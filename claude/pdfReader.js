/**
 * Sends the PDF straight to the Claude API (as a base64 "document" block: Claude
 * reads both the text and the page images) and gets back one structured result
 * for the whole drawing set. Results are cached on disk by PDF content, so the
 * same file is never paid for twice.
 *
 * Talks to the Messages API with fetch, streaming the answer so that a long
 * multi-page read cannot hit a connection timeout. No SDK needed.
 * Needs the ANTHROPIC_API_KEY environment variable.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { DOCUMENT_SCHEMA } from "./documentSchema.js";
import * as prompts from "./prompts.js";

export const TOOL = {
  name: "record_drawing_set",
  description: "Record every drawing in this PDF with its rooms, schedules and notes.",
  input_schema: DOCUMENT_SCHEMA,
};

export class ExtractionError extends Error {
  constructor(message) { super(message); this.name = "ExtractionError"; }
}
export class ApiError extends Error {
  constructor(message, status = null) { super(message); this.name = "ApiError"; this.status = status; }
}

/** Estimated cost of one call from its token usage (null if unknown). */
export function costUsd(usage, priceInPerMtok, priceOutPerMtok) {
  if (!usage) return null;
  return (usage.input_tokens * priceInPerMtok + usage.output_tokens * priceOutPerMtok) / 1_000_000;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

/** Parse a server-sent-events byte stream into {event, data} objects. */
async function* sseEvents(body, onActivity) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    onActivity();
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.search(/\r?\n\r?\n/)) !== -1) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, "");
      let event = "message", data = "";
      for (const line of chunk.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).replace(/^ /, "");
      }
      if (data) yield { event, data };
    }
  }
}

/**
 * Messages API client with the shape the tests stub:
 *   client.messages.create(params) -> {content, usage, stop_reason}
 * It always streams internally and returns the assembled final message.
 * Rate limits, overloads and network errors are retried with backoff
 * (only before any answer has started, so a retry never pays twice).
 */
export class AnthropicStreamClient {
  constructor({ apiKey = process.env.ANTHROPIC_API_KEY, baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
    maxRetries = 4, idleTimeoutMs = Number(process.env.BOQ_API_IDLE_TIMEOUT_S || 120) * 1000, backoffMs = 500 } = {}) {
    this.apiKey = apiKey;
    // Accept both https://api.anthropic.com and https://api.anthropic.com/v1 (the path adds /v1 itself).
    this.baseUrl = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
    this.maxRetries = maxRetries;
    this.idleTimeoutMs = idleTimeoutMs;
    this.backoffMs = backoffMs;
    this.messages = { create: (params) => this._create(params) };
  }

  _delay(attempt) { return Math.min(this.backoffMs * 2 ** attempt, 8000) * (1 - Math.random() * 0.25); }

  async _create(params) {
    if (!this.apiKey) throw new ApiError("ANTHROPIC_API_KEY is not set");
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // The timer is an idle timeout: it restarts whenever data arrives (the API sends
      // keep-alive pings), so a slow but alive answer is never cut off.
      const ctrl = new AbortController();
      let timer = setTimeout(() => ctrl.abort(), this.idleTimeoutMs);
      const touch = () => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), this.idleTimeoutMs); };
      try {
        let res;
        try {
          res = await fetch(`${this.baseUrl}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ ...params, stream: true }),
            signal: ctrl.signal,
          });
        } catch (err) {
          lastError = new ApiError(err.name === "AbortError" ? "no answer from the API (timed out)" : `connection error: ${err.message}`);
          if (attempt < this.maxRetries) { await sleep(this._delay(attempt)); continue; }
          throw lastError;
        }
        if (!res.ok) {
          const text = await res.text();
          let detail = text;
          try { const b = JSON.parse(text); detail = `${b.error?.type || "error"}: ${b.error?.message || text}`; } catch { /* keep raw */ }
          lastError = new ApiError(`${res.status} ${detail}`, res.status);
          if (RETRY_STATUS.has(res.status) && attempt < this.maxRetries) {
            const ra = Number(res.headers.get("retry-after"));
            await sleep(Number.isFinite(ra) && ra > 0 && ra <= 60 ? ra * 1000 : this._delay(attempt));
            continue;
          }
          throw lastError;
        }
        touch();
        return await this._assemble(res.body, touch);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }

  /** Rebuild the final message from the stream of events. */
  async _assemble(body, touch) {
    const blocks = [];
    const usage = { input_tokens: 0, output_tokens: 0 };
    let stopReason = null;
    try {
      for await (const { event, data } of sseEvents(body, touch)) {
        let msg;
        try { msg = JSON.parse(data); } catch { continue; }
        const type = msg.type || event;
        if (type === "message_start") {
          usage.input_tokens = msg.message?.usage?.input_tokens ?? 0;
          usage.output_tokens = msg.message?.usage?.output_tokens ?? 0;
        } else if (type === "content_block_start") {
          blocks[msg.index] = { ...msg.content_block, _json: "", text: msg.content_block.text ?? "" };
        } else if (type === "content_block_delta") {
          const b = blocks[msg.index];
          if (!b) continue;
          if (msg.delta?.type === "input_json_delta") b._json += msg.delta.partial_json ?? "";
          else if (msg.delta?.type === "text_delta") b.text += msg.delta.text ?? "";
        } else if (type === "message_delta") {
          stopReason = msg.delta?.stop_reason ?? stopReason;
          if (msg.usage?.output_tokens !== undefined) usage.output_tokens = msg.usage.output_tokens;
          if (msg.usage?.input_tokens !== undefined) usage.input_tokens = msg.usage.input_tokens;
        } else if (type === "error") {
          throw new ApiError(`${msg.error?.type || "error"}: ${msg.error?.message || "stream error"}`);
        }
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(err.name === "AbortError" ? "the answer stopped arriving (timed out)" : `connection lost while reading the answer: ${err.message}`);
    }
    const content = blocks.filter(Boolean).map((b) => {
      if (b.type !== "tool_use") return { type: b.type, text: b.text };
      let input = null;                                // null = cut off or malformed
      try { input = b._json ? JSON.parse(b._json) : {}; } catch { /* truncated JSON */ }
      return { type: "tool_use", id: b.id, name: b.name, input };
    });
    return { content, usage, stop_reason: stopReason };
  }
}

export class ClaudePdfReader {
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

    this.client = client || new AnthropicStreamClient({
      apiKey,
      baseUrl,
      maxRetries,
      idleTimeoutMs: timeoutMs,
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
      `${this._key(pdf)}.json`
    );

    if (useCache && fs.existsSync(file)) {
      this.cache_hits += 1;

      return {
        raw: JSON.parse(fs.readFileSync(file, "utf8")),
        usage: null,
        cached: true,
      };
    }

    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: prompts.SYSTEM,
      tools: [TOOL],
      tool_choice: {
        type: "auto",
      },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: Buffer.from(pdf).toString("base64"),
              },
            },
            {
              type: "text",
              text: prompts.userText(filename),
            },
          ],
        },
      ],
    });

    this.calls += 1;

    const usage = resp.usage
      ? {
          input_tokens: resp.usage.input_tokens,
          output_tokens: resp.usage.output_tokens,
        }
      : null;

    if (usage) {
      this.total_input += usage.input_tokens;
      this.total_output += usage.output_tokens;
    }

    if (resp.stop_reason === "max_tokens") {
      throw new ExtractionError(
        "the answer was cut off because the drawing set is too large for one reply " +
        "(raise BOQ_MAX_TOKENS, or upload fewer pages at a time)"
      );
    }

    if (resp.stop_reason === "refusal") {
      throw new ExtractionError(
        "the model declined to read this document"
      );
    }

    const block = (resp.content || []).find(
      (item) => item.type === "tool_use"
    );

    if (!block) {
      throw new ExtractionError(
        "the model returned no structured result"
      );
    }

    if (block.input === null) {
      throw new ExtractionError(
        "the model's result was incomplete or malformed; try again"
      );
    }

    fs.writeFileSync(
      file,
      JSON.stringify(block.input, null, 2),
      "utf8"
    );

    return {
      raw: block.input,
      usage,
      cached: false,
    };
  }
}



// export class ClaudePdfReader {
//   constructor({ model, maxTokens, cacheDir, client = null }) {
//     this.model = model; this.maxTokens = maxTokens; this.cacheDir = String(cacheDir);
//     fs.mkdirSync(this.cacheDir, { recursive: true });
//     this.client = client || new AnthropicStreamClient();
//     this.calls = 0; this.cache_hits = 0;
//     this.total_input = 0; this.total_output = 0;       // tokens used by this process
//   }

//   _key(pdf) {
//     return crypto.createHash("sha256")
//       .update(`${this.model}\n${prompts.PROMPT_VERSION}\n`).update(pdf).digest("hex");
//   }

//   /**
//    * Read a PDF. Returns {raw, usage, cached}: the structured result, the token
//    * usage of the call (null when served from the cache) and whether it was cached.
//    * useCache=false forces a fresh (paid) call; the new answer is cached.
//    */
//   async read(pdf, filename = "drawings.pdf", useCache = true) {
//     const file = path.join(this.cacheDir, `${this._key(pdf)}.json`);
//     if (useCache && fs.existsSync(file)) {
//       this.cache_hits += 1;
//       return { raw: JSON.parse(fs.readFileSync(file, "utf8")), usage: null, cached: true };
//     }

//     const resp = await this.client.messages.create({
//       model: this.model, max_tokens: this.maxTokens,
//       system: prompts.SYSTEM,
//       tools: [TOOL], tool_choice: { type: "tool", name: TOOL.name },
//       messages: [{
//         role: "user",
//         content: [
//           { type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from(pdf).toString("base64") } },
//           { type: "text", text: prompts.userText(filename) },
//         ],
//       }],
//     });
//     this.calls += 1;
//     const usage = resp.usage ? { input_tokens: resp.usage.input_tokens, output_tokens: resp.usage.output_tokens } : null;
//     if (usage) { this.total_input += usage.input_tokens; this.total_output += usage.output_tokens; }

//     if (resp.stop_reason === "max_tokens") {
//       throw new ExtractionError("the answer was cut off because the drawing set is too large for one reply " +
//         "(raise BOQ_MAX_TOKENS, or upload fewer pages at a time)");
//     }
//     if (resp.stop_reason === "refusal") throw new ExtractionError("the model declined to read this document");
//     const block = (resp.content || []).find((b) => b.type === "tool_use");
//     if (!block) throw new ExtractionError("the model returned no structured result");
//     if (block.input === null) throw new ExtractionError("the model's result was incomplete or malformed; try again");

//     fs.writeFileSync(file, JSON.stringify(block.input, null, 2), "utf8");
//     return { raw: block.input, usage, cached: false };
//   }
// }

