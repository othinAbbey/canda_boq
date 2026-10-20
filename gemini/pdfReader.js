/**
 * Google Gemini adapter.
 *
 * Sends the ORIGINAL PDF bytes to the Gemini generateContent API as an
 * inline_data part (mime type application/pdf). Gemini reads the text and the
 * page images itself; nothing is extracted or converted locally.
 *
 * Needs GEMINI_API_KEY (or AI_API_KEY). No SDK required.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { DOCUMENT_SCHEMA } from "../claude/documentSchema.js";
import * as prompts from "../claude/prompts.js";

export class ExtractionError extends Error {
  constructor(message) { super(message); this.name = "ExtractionError"; }
}
export class ApiError extends Error {
  constructor(message, status = null) { super(message); this.name = "ApiError"; this.status = status; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

// Gemini has no "tool" to call; it returns JSON that follows the schema.
const SYSTEM_NOTE =
  "\n\nOutput format: return ONE JSON object that follows the response schema. " +
  "Wherever these instructions say to call record_drawing_set, put that content " +
  "in the JSON object instead. Do not call any tools.";

export class GeminiClient {
  constructor({
    apiKey = process.env.GEMINI_API_KEY,
    baseUrl = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta",
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

  async generate(model, body) {
    if (!this.apiKey) throw new ApiError("GEMINI_API_KEY is not configured");
    const url = `${this.baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
    let lastError;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        let res;
        try {
          res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
            body: JSON.stringify(body),
            signal: ctrl.signal,
          });
        } catch (err) {
          lastError = new ApiError(err.name === "AbortError"
            ? "Gemini did not respond before the request timed out"
            : `Gemini connection error: ${err.message}`);
          if (attempt < this.maxRetries) { await sleep(this.backoffMs * 2 ** attempt); continue; }
          throw lastError;
        }

        if (!res.ok) {
          const text = await res.text();
          let detail = text;
          try { detail = JSON.parse(text).error?.message || text; } catch { /* keep raw */ }
          lastError = new ApiError(`Gemini API error (${res.status}): ${detail}`, res.status);
          if (RETRY_STATUS.has(res.status) && attempt < this.maxRetries) {
            const ra = Number(res.headers.get("retry-after"));
            await sleep(Number.isFinite(ra) && ra > 0 && ra <= 60 ? ra * 1000 : this.backoffMs * 2 ** attempt);
            continue;
          }
          throw lastError;
        }

        try { return await res.json(); }
        catch { throw new ApiError("Gemini returned an invalid JSON response"); }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || new ApiError("Gemini request failed");
  }
}

export class GeminiPdfReader {
  constructor({ apiKey, baseUrl, model, maxTokens, cacheDir, timeoutMs = 120000, maxRetries = 2, client = null }) {
    this.model = model;
    this.maxTokens = maxTokens;
    this.cacheDir = String(cacheDir);
    fs.mkdirSync(this.cacheDir, { recursive: true });

    this.client = client || new GeminiClient({ apiKey, baseUrl, maxRetries, timeoutMs });

    this.calls = 0;
    this.cache_hits = 0;
    this.total_input = 0;
    this.total_output = 0;
  }

  _key(pdf) {
    return crypto.createHash("sha256")
      .update(`gemini\n${this.model}\n${prompts.PROMPT_VERSION}\n`)
      .update(pdf).digest("hex");
  }

  async read(pdf, filename = "drawings.pdf", useCache = true) {
    const file = path.join(this.cacheDir, `${this._key(pdf)}.json`);

    if (useCache && fs.existsSync(file)) {
      this.cache_hits += 1;
      return { raw: JSON.parse(fs.readFileSync(file, "utf8")), usage: null, cached: true };
    }

    const resp = await this.client.generate(this.model, {
      systemInstruction: { parts: [{ text: prompts.SYSTEM + SYSTEM_NOTE }] },
      contents: [{
        role: "user",
        parts: [
          { inline_data: { mime_type: "application/pdf", data: Buffer.from(pdf).toString("base64") } },
          { text: prompts.userText(filename) },
        ],
      }],
      generationConfig: {
        maxOutputTokens: this.maxTokens,
        responseMimeType: "application/json",
        responseJsonSchema: DOCUMENT_SCHEMA,
      },
    });

    this.calls += 1;

    // Thinking tokens are billed as output, so count them too.
    const u = resp.usageMetadata;
    const usage = u
      ? { input_tokens: u.promptTokenCount ?? 0,
          output_tokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) }
      : null;
    if (usage) { this.total_input += usage.input_tokens; this.total_output += usage.output_tokens; }

    if (resp.promptFeedback?.blockReason) {
      throw new ExtractionError(`Gemini blocked this document (${resp.promptFeedback.blockReason})`);
    }

    const candidate = resp.candidates?.[0];
    const reason = candidate?.finishReason;

    if (reason === "MAX_TOKENS") {
      throw new ExtractionError(
        "The Gemini response was cut off because the drawing set is too large for one reply. " +
        "Increase BOQ_MAX_TOKENS or upload fewer pages at a time.");
    }
    if (reason && reason !== "STOP") {
      throw new ExtractionError(`Gemini stopped before finishing (${reason})`);
    }

    const output = (candidate?.content?.parts || [])
      .filter((p) => typeof p.text === "string" && !p.thought)
      .map((p) => p.text).join("");
    if (!output) throw new ExtractionError("Gemini returned no structured result");

    let raw;
    try { raw = JSON.parse(output); }
    catch { throw new ExtractionError("Gemini returned incomplete or malformed JSON; try again"); }

    if (!raw || typeof raw !== "object" || !Array.isArray(raw.views)) {
      throw new ExtractionError("Gemini returned an invalid drawing-set structure");
    }

    fs.writeFileSync(file, JSON.stringify(raw, null, 2), "utf8");   // cache only a good result
    return { raw, usage, cached: false };
  }
}
