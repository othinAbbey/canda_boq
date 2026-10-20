/**
 * End to end: real HTTP server, real streaming client, a mock Claude API.
 * Run:  node --test tests/
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { createApp } from "../server.js";
import { AnthropicStreamClient, ClaudePdfReader } from "../claude/pdfReader.js";
import { loadSettings } from "../config.js";
import { JobService } from "../service.js";
import { readZip, sleep, startMockAnthropic } from "./helpers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const PDF = fs.readFileSync(path.join(HERE, "fixture_sheet.pdf"));
const variant = (n) => Buffer.concat([PDF, Buffer.from(`\n% variant ${n}\n`)]);   // a different PDF each time

let mock, tmp, service, server, base, settings;

async function startBackend({ maxJobs = 2, maxPdfMb = 20, corsOrigins = null, defaultReader = false } = {}) {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "boq-e2e-"));
  fs.copyFileSync(path.join(ROOT, "pricing", "rates.csv"), path.join(tmp, "rates.csv"));
 settings = loadSettings({
  AI_PROVIDER: "anthropic",
  AI_API_KEY: defaultReader ? "" : "test-key",
  AI_BASE_URL: mock.url,
  AI_MODEL: "claude-sonnet-5-5",
  AI_TIMEOUT_MS: "120000",
  AI_MAX_RETRIES: "2",

  BOQ_DATA: path.join(tmp, "data"),
  BOQ_JOBS: path.join(tmp, "data", "jobs"),
  BOQ_CACHE: path.join(tmp, "data", "cache"),
  BOQ_RATES: path.join(tmp, "rates.csv"),
  BOQ_ASSUMPTIONS: path.join(ROOT, "takeoff", "assumptions.toml"),
  BOQ_MAX_TOKENS: "16000",
  BOQ_MAX_JOBS: String(maxJobs),
  BOQ_MAX_PDF_MB: String(maxPdfMb),
  BOQ_PRICE_IN: "2",
  BOQ_PRICE_OUT: "10",
  BOQ_CURRENCY: "UGX",
  BOQ_CORS_ORIGINS: "http://localhost:3000",
});
  service = new JobService(settings, defaultReader ? {} : {
    readerFactory: (s) =>
      new ClaudePdfReader({ model: s.model, maxTokens: s.maxTokens, cacheDir: s.cacheDir,
        client: new AnthropicStreamClient({ apiKey: "test-key", baseUrl: mock.url, backoffMs: 1, idleTimeoutMs: 5000 }) }),
  });
  server = http.createServer(createApp(service, { corsOrigins }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
}
async function stopBackend() {
  await service.idle();
  await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  fs.rmSync(tmp, { recursive: true, force: true });
}

const api = async (method, p, opts = {}) => {
  const res = await fetch(base + p, { method, ...opts });
  const type = res.headers.get("content-type") || "";
  return { status: res.status, headers: res.headers, body: type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()) };
};
const upload = (buf, name = "house_plan.pdf", query = "") => {
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: "application/pdf" }), name);
  return api("POST", `/api/jobs${query}`, { body: fd });
};
async function waitFor(id, ...states) {
  for (let i = 0; i < 400; i++) {
    const { body } = await api("GET", `/api/jobs/${id}`);
    if (states.includes(body.status)) return body;
    await sleep(15);
  }
  throw new Error(`job ${id} never reached ${states}`);
}

before(async () => { mock = await startMockAnthropic(); });
after(async () => { await mock.close(); });

describe("PDF -> Claude -> Excel (happy path)", () => {
  before(() => startBackend());
  after(() => stopBackend());
  beforeEach(() => { mock.state.mode = "ok"; mock.state.requests.length = 0; mock.state.delayMs = 0; });

  let job;
  it("accepts the upload immediately (202) and sends the PDF itself to the API", async () => {
    const res = await upload(PDF);
    assert.equal(res.status, 202);
    assert.equal(res.body.status, "queued");
    job = await waitFor(res.body.id, "done", "failed");
    assert.equal(job.status, "done", job.error);

    assert.equal(mock.state.requests.length, 1);
    const r = mock.state.requests[0];
    assert.equal(r.url, "/v1/messages");
    assert.equal(r.headers["x-api-key"], "test-key");
    assert.equal(r.headers["anthropic-version"], "2023-06-01");
    assert.equal(r.body.stream, true);
    assert.deepEqual(r.body.tool_choice, { type: "tool", name: "record_drawing_set" });
    const [doc, text] = r.body.messages[0].content;
    assert.equal(doc.type, "document");
    assert.equal(doc.source.media_type, "application/pdf");
    assert.ok(Buffer.from(doc.source.data, "base64").equals(PDF), "the exact PDF bytes were sent");
    assert.equal(text.type, "text");
  });

  it("builds the BOQ from what Claude read", () => {
    const res = job.result;
    assert.equal(res.counts.drawings, 4);
    assert.equal(res.counts.rooms, 7);
    assert.equal(res.counts.openings, 2);
    const codes = res.sections.flatMap((s) => s.lines.map((l) => l.code));
    assert.ok(codes.includes("FIN-FLOOR-TILE") || codes.some((c) => c.startsWith("FIN-FLOOR-")));
    assert.ok(codes.includes("OPN-DOOR-D6"), "mark was normalised to upper case");
    assert.ok(codes.includes("OPN-WINDOW-W3"));
    assert.ok(res.issues.some((i) => /no finishes measured for voids\/stairs: Staircase/.test(i.message)), "staircase excluded");
    assert.ok(res.issues.some((i) => i.where === "opening W3" && /schedule says 4, floor plans show 3/.test(i.message)), "schedule vs plan tags check");
    assert.ok(!res.issues.some((i) => i.where === "opening D6"), "D6: schedule (3) matches the plans (2+1)");
    assert.deepEqual(res.document_warnings, ["Page 3 is a site plan and was not measured"]);
    assert.equal(job.cached, false);
    assert.deepEqual(job.usage, { input_tokens: 12000, output_tokens: 3456 });
    assert.ok(Math.abs(job.cost_usd - (12000 * 2 + 3456 * 10) / 1e6) < 1e-9);
  });

  it("serves a valid Excel file with live formulas and the data Claude read", async () => {
    const res = await api("GET", `/api/jobs/${job.id}/boq.xlsx`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /spreadsheetml/);
    assert.match(res.headers.get("content-disposition"), /house_plan_BOQ\.xlsx/);
    const files = readZip(res.body);
    const workbook = files["xl/workbook.xml"];
    for (const name of ["BOQ", "Unpriced", "Issues", "Rooms read", "Openings read", "Notes read"]) {
      assert.ok(workbook.includes(`name="${name}"`), `sheet ${name}`);
    }
    assert.match(files["xl/worksheets/sheet1.xml"], /<f>IF\(E\d+=&quot;&quot;,&quot;&quot;,D\d+\*E\d+\)<\/f>/);
    assert.match(files["xl/worksheets/sheet4.xml"], /Master Bedroom/);
    assert.match(files["xl/worksheets/sheet6.xml"], /200mm hollow block/);
  });

  it("exposes what Claude read, for review", async () => {
    const res = await api("GET", `/api/jobs/${job.id}/extraction`);
    assert.equal(res.status, 200);
    assert.equal(res.body.views.length, 4);
    assert.equal(res.body.views[0].name, "p1_v1");
    assert.equal(res.body.views[1].name, "p1_v2");
    assert.equal(res.body.views[2].name, "p2_v1");
    assert.equal(res.body.views[0].label_scale, 100);
    assert.deepEqual(res.body.views[0].tag_counts, { D6: 2, W3: 1 });
  });

  it("lists jobs", async () => {
    const res = await api("GET", "/api/jobs");
    assert.equal(res.body[0].id, job.id);
    assert.equal(res.body[0].status, "done");
    assert.equal(res.body[0].currency, "UGX");
  });

  it("serves the same PDF from the cache for free, and force=true pays again", async () => {
    mock.state.requests.length = 0;
    const again = await waitFor((await upload(PDF)).body.id, "done");
    assert.equal(again.cached, true);
    assert.equal(again.cost_usd, null);
    assert.equal(mock.state.requests.length, 0, "no API call");
    const forced = await waitFor((await upload(PDF, "house_plan.pdf", "?force=true")).body.id, "done");
    assert.equal(forced.cached, false);
    assert.equal(mock.state.requests.length, 1);
  });

  it("rebuild applies new rates without calling the API again", async () => {
    const before = job.result;
    assert.ok(before.unpriced.length > 0, "rates start blank");
    assert.equal(before.totals.total, 0);
    const rates = (await api("GET", "/api/rates")).body;
    const rows = rates.rows.map((r) => ({ ...r, rate: r.item_code === "OPN-DOOR-*" ? "250,000" : r.item_code === "FIN-FLOOR-TILE" ? "40000" : r.rate }));
    assert.equal((await api("PUT", "/api/rates", { headers: { "content-type": "application/json" }, body: JSON.stringify({ rows }) })).body.saved, rows.length);

    mock.state.requests.length = 0;
    const res = await api("POST", `/api/jobs/${job.id}/rebuild`);
    assert.equal(res.status, 200);
    assert.equal(mock.state.requests.length, 0);
    assert.ok(res.body.result.totals.total > 0);
    assert.ok(res.body.result.unpriced.length < before.unpriced.length);
    const door = res.body.result.sections.flatMap((s) => s.lines).find((l) => l.code === "OPN-DOOR-D6");
    assert.equal(door.rate, 250000);
    assert.equal(door.amount, 750000);                        // 3 doors
    assert.ok(fs.existsSync(path.join(settings.ratesPath + ".bak")), "previous rates kept as .bak");
  });
});

describe("failures are reported, never lost", () => {
  before(() => startBackend());
  after(() => stopBackend());
  beforeEach(() => { mock.state.mode = "ok"; mock.state.overloadedSent = 0; mock.state.requests.length = 0; });

  it("retries an overloaded API and then succeeds", async () => {
    mock.state.mode = "overloaded-once";
    const job = await waitFor((await upload(variant(1))).body.id, "done", "failed");
    assert.equal(job.status, "done", job.error);
    assert.equal(mock.state.requests.length, 2);
  });

  it("reports an authentication error clearly", async () => {
    mock.state.mode = "auth";
    const job = await waitFor((await upload(variant(2))).body.id, "done", "failed");
    assert.equal(job.status, "failed");
    assert.match(job.error, /401.*authentication_error.*invalid x-api-key/);
  });

  it("explains a truncated answer", async () => {
    mock.state.mode = "max_tokens";
    const job = await waitFor((await upload(variant(3))).body.id, "done", "failed");
    assert.equal(job.status, "failed");
    assert.match(job.error, /cut off.*BOQ_MAX_TOKENS/);
  });

  it("reports an error that arrives in the middle of the stream", async () => {
    mock.state.mode = "stream-error";
    const job = await waitFor((await upload(variant(4))).body.id, "done", "failed");
    assert.equal(job.status, "failed");
    assert.match(job.error, /overloaded_error/);
  });

  it("handles an answer with no structured result, and malformed JSON", async () => {
    mock.state.mode = "no-tool";
    let job = await waitFor((await upload(variant(5))).body.id, "done", "failed");
    assert.match(job.error, /no structured result/);
    mock.state.mode = "badjson";
    job = await waitFor((await upload(variant(6))).body.id, "done", "failed");
    assert.match(job.error, /incomplete or malformed/);
  });

  it("a failed read is not cached (the next try pays and can succeed)", async () => {
    mock.state.mode = "max_tokens";
    const pdf = variant(7);
    await waitFor((await upload(pdf)).body.id, "failed");
    mock.state.mode = "ok";
    const job = await waitFor((await upload(pdf)).body.id, "done", "failed");
    assert.equal(job.status, "done", job.error);
    assert.equal(job.cached, false);
  });

  it("a result with no drawings fails with a clear message", async () => {
    mock.state.result = { views: [], document_warnings: [] };
    try {
      const job = await waitFor((await upload(variant(8))).body.id, "done", "failed");
      assert.equal(job.status, "failed");
      assert.match(job.error, /no drawings/);
    } finally { const { SAMPLE_RESULT } = await import("./helpers.js"); mock.state.result = SAMPLE_RESULT; }
  });
});

describe("input validation and HTTP behaviour", () => {
  before(() => startBackend({ maxPdfMb: 0.001, corsOrigins: "http://app.test" }));
  after(() => stopBackend());

  it("rejects a file that is not a PDF (400) and a PDF over the limit (413)", async () => {
    let res = await upload(Buffer.from("hello world"), "notes.txt");
    assert.equal(res.status, 400); assert.match(res.body.detail, /not a PDF/);
    res = await upload(Buffer.concat([PDF, Buffer.alloc(5000)]));
    assert.equal(res.status, 413); assert.match(res.body.detail, /limit is 0\.001 MB/);
  });

  it("requires a multipart 'file' field", async () => {
    const res = await api("POST", "/api/jobs", { headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 422);
  });

  it("404 for unknown jobs / routes, 405 for the wrong method", async () => {
    assert.equal((await api("GET", "/api/jobs/doesnotexist")).status, 404);
    assert.equal((await api("GET", "/api/jobs/aaaaaaaaaaaa")).status, 404);
    assert.equal((await api("GET", "/api/nothing")).status, 404);
    assert.equal((await api("DELETE", "/api/rates")).status, 405);
    assert.equal((await api("GET", "/api/jobs/../../etc/passwd")).status, 404);
  });

  it("CORS: allows the configured origin only, answers preflight", async () => {
    const ok = await fetch(base + "/api/health", { headers: { Origin: "http://app.test" } });
    assert.equal(ok.headers.get("access-control-allow-origin"), "http://app.test");
    const other = await fetch(base + "/api/health", { headers: { Origin: "http://evil.test" } });
    assert.equal(other.headers.get("access-control-allow-origin"), null);
    const pre = await fetch(base + "/api/jobs", { method: "OPTIONS", headers: { Origin: "http://app.test", "Access-Control-Request-Method": "POST" } });
    assert.equal(pre.status, 200);
    assert.match(pre.headers.get("access-control-allow-methods"), /POST/);
    const bad = await fetch(base + "/api/jobs", { method: "OPTIONS", headers: { Origin: "http://evil.test", "Access-Control-Request-Method": "POST" } });
    assert.equal(bad.status, 400);
  });

  it("rate book validation reports every problem", async () => {
    const res = await api("PUT", "/api/rates", { headers: { "content-type": "application/json" },
      body: JSON.stringify({ rows: [{ item_code: "A", rate: "abc" }, { item_code: "" }, { item_code: "A", rate: "1" }] }) });
    assert.equal(res.status, 400);
    assert.match(res.body.detail, /row 1 \(A\): rate 'abc' is not a number/);
    assert.match(res.body.detail, /row 2: item_code is empty/);
    assert.match(res.body.detail, /row 3: A appears twice/);
  });

  it("config reports whether a key is set", async () => {
    const res = await api("GET", "/api/config");
    assert.equal(res.body.currency, "UGX");
    assert.equal(typeof res.body.api_key_set, "boolean");
  });
});

describe("no API key", () => {
  let savedKey;
  before(async () => {  await startBackend({ defaultReader: true });});
  after(async () => {  await stopBackend();});
  it("fails fast with 503 and creates no job", async () => {
    const res = await upload(PDF);
    assert.equal(res.status, 503);
    assert.match(res.body.detail, /AI_API_KEY is not configured/);
    assert.deepEqual((await api("GET", "/api/jobs")).body, [], "no job was created");
    assert.equal((await api("GET", "/api/config")).body.api_key_set, false);
  });
});

describe("queueing and restarts", () => {
  before(() => startBackend({ maxJobs: 1 }));
  after(() => stopBackend());
  beforeEach(() => { mock.state.mode = "ok"; mock.state.delayMs = 250; mock.state.requests.length = 0; });

  it("runs one job at a time when limited to 1; the other waits as 'queued'", async () => {
    const a = (await upload(variant(10))).body.id, b = (await upload(variant(11))).body.id;
    await sleep(120);
    const [ja, jb] = [(await api("GET", `/api/jobs/${a}`)).body, (await api("GET", `/api/jobs/${b}`)).body];
    assert.equal(ja.status, "reading");
    assert.equal(jb.status, "queued");
    assert.equal((await waitFor(a, "done")).status, "done");
    assert.equal((await waitFor(b, "done")).status, "done");
    mock.state.delayMs = 0;
  });

  it("marks jobs interrupted by a restart as failed", async () => {
    const id = "abcdef012345";
    const dir = path.join(settings.jobsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify({ id, filename: "x.pdf", status: "reading", stage: "x", created_at: new Date().toISOString() }));
    const fresh = new JobService(settings, { readerFactory: () => ({}) });
    const j = fresh.getJob(id);
    assert.equal(j.status, "failed");
    assert.match(j.error, /restarted/);
  });
});

import { describe as d2, it as i2 } from "node:test";
import assert2 from "node:assert/strict";
d2("service key", () => {
  i2("rejects calls without the key but allows /api/health", async () => {
    const { createApp } = await import("../server.js");
    const http = await import("node:http");
    const handler = createApp({ settings: { maxPdfMb: 1 }, config: () => ({}) }, { corsOrigins: [], serviceKey: "k1" });
    const srv = http.createServer(handler); await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    try {
      assert2.equal((await fetch(base + "/api/health")).status, 200);
      assert2.equal((await fetch(base + "/api/config")).status, 401);
      assert2.equal((await fetch(base + "/api/config", { headers: { "x-service-key": "bad" } })).status, 401);
      assert2.notEqual((await fetch(base + "/api/config", { headers: { "x-service-key": "k1" } })).status, 401);
    } finally { srv.closeAllConnections?.(); srv.close(); }
  });
});
