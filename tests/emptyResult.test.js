import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { ClaudePdfReader, ExtractionError } from "../claude/pdfReader.js";
import { OpenAIPdfReader } from "../openai/pdfReader.js";
import { GeminiPdfReader } from "../gemini/pdfReader.js";

const tmp = [];
const cacheDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "boq-empty-")); tmp.push(d); return d; };
afterEach(() => { for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from([0, 255, 128, 10, 13, 200]), Buffer.from("\n%%EOF")]);
const GOOD = { project_name: "Clinic", views: [{ page: 1, name: "Plan" }], document_warnings: [] };

/** A fake Anthropic API streaming a tool_use block. `script` lists what each call sends: an object, or "empty" for no input at all. */
async function fakeAnthropic(script, { rejectForced = false, rejectModel = false } = {}) {
  const requests = []; let n = 0;
  const srv = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body); requests.push(parsed);
      const fail = (msg) => { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: msg } })); };
      if (rejectForced && parsed.tool_choice?.type === "tool") return fail('tool_choice: type "tool" and "any" are not supported for this model.');
      if (rejectModel) return fail("model: invalid model name");
      const answer = script[Math.min(n++, script.length - 1)];
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      ev({ type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 1 } } });
      if (answer === "text") {
        ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I looked at the drawing and it shows a slab." } });
        ev({ type: "content_block_stop", index: 0 });
        ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } });
        ev({ type: "message_stop" }); return res.end();
      }
      ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "record_drawing_set", input: {} } });
      if (answer !== "empty") ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(answer) } });
      ev({ type: "content_block_stop", index: 0 });
      ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 50 } });
      ev({ type: "message_stop" }); res.end();
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { requests, url: `http://127.0.0.1:${srv.address().port}/v1`, close: () => { srv.closeAllConnections?.(); srv.close(); } };
}
const reader = (url, dir = cacheDir()) => new ClaudePdfReader({ apiKey: "k", baseUrl: url, model: "claude-test", maxTokens: 1000, cacheDir: dir, maxRetries: 0 });
const cacheFiles = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith(".json"));

describe("Anthropic reader", () => {
  it("sends the original PDF, byte for byte, as a base64 document block", async () => {
    const api = await fakeAnthropic([GOOD]);
    try {
      const out = await reader(api.url).read(PDF, "plan.pdf");
      const doc = api.requests[0].messages[0].content.find((b) => b.type === "document");
      assert.equal(doc.source.type, "base64"); assert.equal(doc.source.media_type, "application/pdf");
      assert.ok(Buffer.from(doc.source.data, "base64").equals(PDF));
      assert.equal(out.raw.views.length, 1); assert.equal(api.requests[0].tool_choice.name, "record_drawing_set");
    } finally { api.close(); }
  });

  it("an empty answer is retried once automatically and the usage of both calls is counted", async () => {
    const api = await fakeAnthropic(["empty", GOOD]);
    try {
      const out = await reader(api.url).read(PDF, "plan.pdf");
      assert.equal(api.requests.length, 2); assert.equal(out.raw.views.length, 1);
      assert.deepEqual(out.usage, { input_tokens: 200, output_tokens: 100 });
    } finally { api.close(); }
  });

  it("two empty answers fail with a clear message and are NOT cached, so the next try is not stuck", async () => {
    const api = await fakeAnthropic(["empty", "empty", GOOD]);
    const dir = cacheDir(), r = reader(api.url, dir);
    try {
      await assert.rejects(r.read(PDF, "plan.pdf"), (e) => e instanceof ExtractionError && /returned an empty result twice/.test(e.message) && /claude-test/.test(e.message));
      assert.equal(cacheFiles(dir).length, 0);
      const out = await r.read(PDF, "plan.pdf");                               // the very same PDF now works
      assert.equal(out.raw.views.length, 1); assert.equal(out.cached, false);
      assert.equal((await r.read(PDF, "plan.pdf")).cached, true);              // good answers are cached as before
    } finally { api.close(); }
  });

  it("an empty answer already sitting in the cache (from an older version) is ignored and re-read", async () => {
    const api = await fakeAnthropic([GOOD]);
    const dir = cacheDir(), r = reader(api.url, dir);
    try {
      fs.writeFileSync(path.join(dir, `${r._key(PDF)}.json`), "{}");
      const out = await r.read(PDF, "plan.pdf");
      assert.equal(out.cached, false); assert.equal(out.raw.views.length, 1); assert.equal(api.requests.length, 1);
      fs.writeFileSync(path.join(dir, `${r._key(PDF)}.json`), "{broken");        // corrupt file too
      assert.equal((await r.read(PDF, "plan.pdf")).cached, false);
    } finally { api.close(); }
  });
});

describe("models that refuse a forced tool call", () => {
  it("falls back to tool_choice auto with a firm instruction, and remembers it", async () => {
    const api = await fakeAnthropic([GOOD], { rejectForced: true });
    try {
      const r = reader(api.url);
      const out = await r.read(PDF, "plan.pdf");
      assert.equal(out.raw.views.length, 1);
      assert.deepEqual(api.requests.map((q) => q.tool_choice.type), ["tool", "auto"]);               // refused once, then accepted
      assert.match(api.requests[1].system, /reply ONLY by calling the record_drawing_set tool/);
      const doc = api.requests[1].messages[0].content.find((b) => b.type === "document");
      assert.ok(Buffer.from(doc.source.data, "base64").equals(PDF));                                  // still the original PDF
      await r.read(Buffer.concat([PDF, Buffer.from("different")]), "other.pdf");                      // a second file goes straight to auto
      assert.deepEqual(api.requests.map((q) => q.tool_choice.type), ["tool", "auto", "auto"]);
    } finally { api.close(); }
  });
  it("a plain-text reply in auto mode is retried once with a nudge", async () => {
    const api = await fakeAnthropic(["text", GOOD], { rejectForced: true });
    try {
      const out = await reader(api.url).read(PDF, "plan.pdf");
      assert.equal(out.raw.views.length, 1);
      const last = api.requests[api.requests.length - 1].messages[0].content.find((b) => b.type === "text").text;
      assert.match(last, /You must call the record_drawing_set tool now/);
    } finally { api.close(); }
  });
  it("two plain-text replies fail clearly and are not cached", async () => {
    const api = await fakeAnthropic(["text", "text"], { rejectForced: true });
    const dir = cacheDir();
    try {
      await assert.rejects(reader(api.url, dir).read(PDF, "plan.pdf"), (e) => e instanceof ExtractionError && /no structured result|empty result/.test(e.message));
      assert.equal(cacheFiles(dir).length, 0);
    } finally { api.close(); }
  });
  it("other 400 errors are not mistaken for this and still fail straight away", async () => {
    const api = await fakeAnthropic([GOOD], { rejectModel: true });
    try {
      await assert.rejects(reader(api.url).read(PDF, "plan.pdf"), (e) => e.name === "ApiError" && e.status === 400 && /invalid model name/.test(e.message));
      assert.equal(api.requests.length, 1);
    } finally { api.close(); }
  });
});

describe("the other readers also ignore an empty cached answer", () => {
  it("OpenAI", async () => {
    const dir = cacheDir();
    const client = { create: async () => ({ status: "completed", usage: { input_tokens: 1, output_tokens: 1 }, output_text: JSON.stringify(GOOD) }) };
    const r = new OpenAIPdfReader({ apiKey: "k", baseUrl: "x", model: "m", maxTokens: 1000, cacheDir: dir, client });
    fs.writeFileSync(path.join(dir, `${r._key(PDF)}.json`), "{}");
    const out = await r.read(PDF, "plan.pdf");
    assert.equal(out.cached, false); assert.equal(out.raw.views.length, 1);
  });
  it("Gemini", async () => {
    const dir = cacheDir();
    const client = { generate: async () => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(GOOD) }] } }] }) };
    const r = new GeminiPdfReader({ model: "m", maxTokens: 1000, cacheDir: dir, client });
    fs.writeFileSync(path.join(dir, `${r._key(PDF)}.json`), "{}");
    const out = await r.read(PDF, "plan.pdf");
    assert.equal(out.cached, false); assert.equal(out.raw.views.length, 1);
  });
});
