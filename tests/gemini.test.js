import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { GeminiClient, GeminiPdfReader } from "../gemini/pdfReader.js";
import { createPdfReader } from "../providers/index.js";
import { loadSettings } from "../config.js";
import { AnthropicStreamClient, ClaudePdfReader } from "../claude/pdfReader.js";
import { OpenAIPdfReader } from "../openai/pdfReader.js";

const tempDirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "boq-gemini-")); tempDirs.push(d); return d; };
afterEach(() => { for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const ok = (raw = { project_name: "P", views: [], document_warnings: [] }) => ({
  candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(raw) }] } }],
  usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 300, thoughtsTokenCount: 50 },
});

function reader(generate) {
  return new GeminiPdfReader({ model: "test-gemini", maxTokens: 16000, cacheDir: tmp(), client: { generate } });
}

describe("Gemini PDF reader", () => {
  it("sends the original PDF bytes as inline_data with a JSON schema", async () => {
    const pdf = Buffer.from("%PDF-1.7 raw drawing bytes");
    let model, body;
    const r = reader(async (m, b) => { model = m; body = b; return ok(); });
    const out = await r.read(pdf, "plan.pdf");

    assert.equal(model, "test-gemini");
    const parts = body.contents[0].parts;
    const file = parts.find((p) => p.inline_data);
    assert.equal(file.inline_data.mime_type, "application/pdf");
    assert.deepEqual(Buffer.from(file.inline_data.data, "base64"), pdf);   // untouched bytes
    assert.match(parts.find((p) => p.text).text, /plan\.pdf/);
    assert.equal(body.generationConfig.responseMimeType, "application/json");
    assert.equal(body.generationConfig.maxOutputTokens, 16000);
    assert.equal(body.generationConfig.responseJsonSchema.type, "object");
    assert.deepEqual(out.usage, { input_tokens: 1000, output_tokens: 350 });  // thinking counted
    assert.equal(out.cached, false);
  });

  it("caches good answers and never caches bad ones", async () => {
    let calls = 0;
    const r = reader(async () => {
      calls++;
      return calls === 1
        ? { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "{bad json" }] } }] }
        : ok();
    });
    const pdf = Buffer.from("%PDF cache");
    await assert.rejects(r.read(pdf), /malformed JSON/);
    const a = await r.read(pdf);
    const b = await r.read(pdf);
    assert.equal(calls, 2);
    assert.equal(a.cached, false);
    assert.equal(b.cached, true);
  });

  it("reports truncation, blocks and empty answers clearly", async () => {
    const pdf = Buffer.from("%PDF x");
    await assert.rejects(reader(async () => ({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [] } }] })).read(pdf), /cut off.*BOQ_MAX_TOKENS/);
    await assert.rejects(reader(async () => ({ promptFeedback: { blockReason: "SAFETY" } })).read(pdf), /blocked/);
    await assert.rejects(reader(async () => ({ candidates: [{ finishReason: "STOP", content: { parts: [] } }] })).read(pdf), /no structured result/);
    await assert.rejects(reader(async () => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "{}" }] } }] })).read(pdf), /invalid drawing-set/);
  });
});

describe("Gemini HTTP client", () => {
  it("posts to :generateContent with the key header and retries 503", async () => {
    const seen = [];
    const srv = http.createServer((req, res) => {
      let raw = ""; req.on("data", (c) => (raw += c));
      req.on("end", () => {
        seen.push({ url: req.url, key: req.headers["x-goog-api-key"] });
        if (seen.length === 1) { res.writeHead(503, { "content-type": "application/json" }); return res.end('{"error":{"message":"busy"}}'); }
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(ok()));
      });
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const c = new GeminiClient({ apiKey: "k", baseUrl: `http://127.0.0.1:${srv.address().port}/v1beta`, maxRetries: 2, backoffMs: 1, timeoutMs: 5000 });
      const out = await c.generate("gem-x", { contents: [] });
      assert.equal(seen.length, 2);
      assert.equal(seen[0].url, "/v1beta/models/gem-x:generateContent");
      assert.equal(seen[0].key, "k");
      assert.ok(out.candidates);
    } finally { srv.closeAllConnections?.(); srv.close(); }
  });

  it("fails without an API key and without a request", async () => {
    await assert.rejects(new GeminiClient({ apiKey: "" }).generate("m", {}), /GEMINI_API_KEY/);
  });
});

describe("provider selection", () => {
  const base = {
    AI_TIMEOUT_MS: "5000", AI_MAX_RETRIES: "0", BOQ_MAX_TOKENS: "16000", BOQ_MAX_PDF_MB: "20", BOQ_MAX_JOBS: "2",
    BOQ_DATA: "/tmp/d", BOQ_JOBS: "/tmp/d/j", BOQ_CACHE: "/tmp/d/c", BOQ_RATES: "/tmp/r.csv", BOQ_ASSUMPTIONS: "/tmp/a.toml",
    AI_BASE_URL: "", AI_MODEL: "", AI_API_KEY: "", BOQ_PRICE_IN: "1", BOQ_PRICE_OUT: "2", BOQ_CURRENCY: "UGX", BOQ_CORS_ORIGINS: "http://localhost:3000",
  };
  const make = (extra) => createPdfReader(loadSettings({ ...base, ...extra }));

  it("builds the right reader for each provider", () => {
    assert.ok(make({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k", ANTHROPIC_MODEL: "m" }) instanceof ClaudePdfReader);
    assert.ok(make({ AI_PROVIDER: "openai", OPENAI_API_KEY: "k", OPENAI_MODEL: "m" }) instanceof OpenAIPdfReader);
    assert.ok(make({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "k", GEMINI_MODEL: "m" }) instanceof GeminiPdfReader);
  });

  it("uses each provider's own key and default URL", () => {
    const s = loadSettings({ ...base, AI_PROVIDER: "gemini", GEMINI_API_KEY: "gk", AI_MODEL: "m", AI_API_KEY: "shared" });
    assert.equal(s.apiKey, "gk");
    assert.equal(s.baseUrl, "https://generativelanguage.googleapis.com/v1beta");
  });

  it("rejects unknown providers and missing keys", () => {
    assert.throws(() => loadSettings({ ...base, AI_PROVIDER: "nope", AI_MODEL: "m" }), /Supported providers: anthropic, openai, gemini/);
    assert.throws(() => make({ AI_PROVIDER: "gemini", GEMINI_MODEL: "m", AI_API_KEY: "" }), /AI_API_KEY is not configured/);
  });

  it("Anthropic base URL works with or without /v1", () => {
    assert.equal(new AnthropicStreamClient({ apiKey: "k", baseUrl: "https://api.anthropic.com/v1" }).baseUrl, "https://api.anthropic.com");
    assert.equal(new AnthropicStreamClient({ apiKey: "k", baseUrl: "https://api.anthropic.com/" }).baseUrl, "https://api.anthropic.com");
  });
});
