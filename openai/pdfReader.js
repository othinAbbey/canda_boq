
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { OPENAI_DOCUMENT_SCHEMA } from "./documentSchema.js";
import * as prompts from "../claude/prompts.js";

export class ExtractionError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExtractionError";
  }
}

export class ApiError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const RETRY_STATUS = new Set([
  408, 409, 429, 500, 502, 503, 504,
]);

function retryDelay(attempt) {
  return Math.min(500 * 2 ** attempt, 8000);
}

function responseText(response) {
  if (typeof response.output_text === "string") {
    return response.output_text;
  }

  // Fallback for responses without the output_text convenience field.
  const parts = [];

  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) {
        parts.push(content.text);
      }
    }
  }

  return parts.join("\n");
}

export class OpenAIResponsesClient {
  constructor({
    apiKey = process.env.OPENAI_API_KEY,
    baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    maxRetries = 2,
    timeoutMs = 120000,
    backoffMs = 500,
  } = {}) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.maxRetries = maxRetries;
    this.timeoutMs = timeoutMs;
    this.backoffMs = backoffMs;
  }

  async create(params) {
    if (!this.apiKey) {
      throw new ApiError("OPENAI_API_KEY is not configured");
    }

    let lastError;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        this.timeoutMs,
      );

      try {
        let response;

        try {
          response = await fetch(`${this.baseUrl}/responses`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify(params),
            signal: controller.signal,
          });
        } catch (error) {
          lastError = new ApiError(
            error.name === "AbortError"
              ? "OpenAI did not respond before the request timed out"
              : `OpenAI connection error: ${error.message}`,
          );

          if (attempt < this.maxRetries) {
            await sleep(this.backoffMs * 2 ** attempt);
            continue;
          }

          throw lastError;
        }

        if (!response.ok) {
          const body = await response.text();
          let detail = body;

          try {
            const parsed = JSON.parse(body);
            detail = parsed.error?.message || body;
          } catch {
            // Keep the response text if it is not JSON.
          }

          lastError = new ApiError(
            `OpenAI API error (${response.status}): ${detail}`,
            response.status,
          );

          if (
            RETRY_STATUS.has(response.status) &&
            attempt < this.maxRetries
          ) {
            const retryAfter = Number(
              response.headers.get("retry-after"),
            );

            const delay =
              Number.isFinite(retryAfter) &&
              retryAfter > 0 &&
              retryAfter <= 60
                ? retryAfter * 1000
                : this.backoffMs * 2 ** attempt;

            await sleep(delay);
            continue;
          }

          throw lastError;
        }

        let result;

        try {
          result = await response.json();
        } catch {
          throw new ApiError("OpenAI returned an invalid JSON response");
        }

        if (result.error) {
          throw new ApiError(
            result.error.message || "OpenAI response failed",
          );
        }

        return result;
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError || new ApiError("OpenAI request failed");
  }
}

export class OpenAIPdfReader {
  constructor({
    apiKey,
    baseUrl,
    model,
    maxTokens,
    cacheDir,
    timeoutMs = 120000,
    maxRetries = 2,
    client = null,
  }) {
    this.model = model;
    this.maxTokens = maxTokens;
    this.cacheDir = String(cacheDir);

    fs.mkdirSync(this.cacheDir, { recursive: true });

    this.client =
      client ||
      new OpenAIResponsesClient({
        apiKey,
        baseUrl,
        maxRetries,
        timeoutMs,
      });

    this.calls = 0;
    this.cache_hits = 0;
    this.total_input = 0;
    this.total_output = 0;
  }

  _key(pdf) {
    return crypto
      .createHash("sha256")
      .update(`${this.model}\n${prompts.PROMPT_VERSION}\n`)
      .update(pdf)
      .digest("hex");
  }

  async read(pdf, filename = "drawings.pdf", useCache = true) {
    const file = path.join(
      this.cacheDir,
      `${this._key(pdf)}.json`,
    );

    if (useCache && fs.existsSync(file)) {
      this.cache_hits += 1;

      return {
        raw: JSON.parse(fs.readFileSync(file, "utf8")),
        usage: null,
        cached: true,
      };
    }

    const base64Pdf = Buffer.from(pdf).toString("base64");

    const response = await this.client.create({
      model: this.model,
      max_output_tokens: this.maxTokens,
      instructions: prompts.SYSTEM,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_file",
              filename: filename || "drawings.pdf",
              file_data: `data:application/pdf;base64,${base64Pdf}`,
            },
            {
              type: "input_text",
              text: prompts.userText(filename),
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "drawing_set",
          strict: true,
          schema: OPENAI_DOCUMENT_SCHEMA,
        },
      },
    });

    this.calls += 1;

    const usage = response.usage
      ? {
          input_tokens: response.usage.input_tokens ?? 0,
          output_tokens: response.usage.output_tokens ?? 0,
        }
      : null;

    if (usage) {
      this.total_input += usage.input_tokens;
      this.total_output += usage.output_tokens;
    }

    if (
      response.status === "incomplete" ||
      response.incomplete_details?.reason === "max_output_tokens"
    ) {
      throw new ExtractionError(
        "The OpenAI response was cut off because the drawing set " +
        "is too large for one reply. Increase BOQ_MAX_TOKENS or " +
        "upload fewer pages at a time.",
      );
    }

    if (response.status === "failed") {
      throw new ExtractionError(
        response.error?.message || "OpenAI failed to read the PDF",
      );
    }

    const refusal = (response.output || []).some((item) =>
      (item.content || []).some(
        (content) => content.type === "refusal",
      ),
    );

    if (refusal) {
      throw new ExtractionError(
        "The OpenAI model declined to read this document",
      );
    }

    if (response.status && response.status !== "completed") {
      throw new ExtractionError(
        `OpenAI returned an unfinished response: ${response.status}`,
      );
    }

    const output = responseText(response);

    if (!output) {
      throw new ExtractionError(
        "OpenAI returned no structured result",
      );
    }

    let raw;

    try {
      raw = JSON.parse(output);
    } catch {
      throw new ExtractionError(
        "OpenAI returned incomplete or malformed JSON; try again",
      );
    }

    if (
      !raw ||
      typeof raw !== "object" ||
      !Array.isArray(raw.views)
    ) {
      throw new ExtractionError(
        "OpenAI returned an invalid drawing-set structure",
      );
    }

    // Cache only a successfully parsed result.
    fs.writeFileSync(file, JSON.stringify(raw, null, 2), "utf8");

    return {
      raw,
      usage,
      cached: false,
    };
  }
}
