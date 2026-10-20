/**
 * HTTP API. Routes only: every decision lives in service.js.
 *
 *     node server.js            # http://127.0.0.1:8000
 *
 * Listens on this machine only by default (HOST=127.0.0.1). To host it set
 * HOST=0.0.0.0 (and PORT). Before exposing it to a network, put authentication
 * in front of it: anyone who can reach it can spend your Anthropic credit.
 *
 * Browser front ends on another origin need CORS: set BOQ_CORS_ORIGINS to a
 * comma-separated list, e.g. https://boq.example.com,http://localhost:3000
 *
 * API (all under /api)
 *   POST /jobs                 upload a PDF (multipart field "file"; ?force=true skips the cache)
 *   GET  /jobs                 recent jobs
 *   GET  /jobs/{id}            status + result (poll this until status is done or failed)
 *   POST /jobs/{id}/rebuild    recompute BOQ/Excel with current rates (free)
 *   GET  /jobs/{id}/extraction what Claude read from the PDF
 *   GET  /jobs/{id}/boq.xlsx   the Excel file
 *   GET/PUT /rates, GET /assumptions, GET /config, GET /usage, GET /health
 */

import "dotenv/config";

import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

import { SETTINGS } from "./config.js";
import { JobService, ServiceError } from "./service.js";
import { parseMultipart } from "./util/multipart.js";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const JSON_LIMIT = 10 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, detail) { super(typeof detail === "string" ? detail : JSON.stringify(detail)); this.status = status; this.detail = detail; }
}

function parseBool(value, name) {
  if (value === null || value === undefined) return undefined;
  const v = String(value).toLowerCase();
  if (["true", "1", "yes", "on", "t", "y"].includes(v)) return true;
  if (["false", "0", "no", "off", "f", "n"].includes(v)) return false;
  throw new HttpError(422, [{ loc: ["query", name], msg: "value could not be parsed to a boolean", type: "bool_parsing" }]);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, "request body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function jsonBody(req) {
  const raw = await readBody(req, JSON_LIMIT);
  let body;
  try { body = JSON.parse(raw.toString("utf8")); }
  catch { throw new HttpError(422, [{ loc: ["body"], msg: "invalid JSON", type: "json_invalid" }]); }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(422, [{ loc: ["body"], msg: "Input should be a valid dictionary", type: "dict_type" }]);
  }
  return body;
}

export function createApp(service = new JobService(SETTINGS), { corsOrigins = null, serviceKey = process.env.BOQ_SERVICE_KEY || "" } = {}) {
  const origins = (corsOrigins ?? (process.env.BOQ_CORS_ORIGINS || "").split(",").map((o) => o.trim()).filter(Boolean));
  // PDF upload limit follows the configured PDF limit (plus multipart overhead).
  const uploadLimit = (service.settings.maxPdfMb + 1) * 1024 * 1024;

  const routes = [
    ["GET", /^\/api\/health$/, async () => ({ status: "ok" })],
    ["GET", /^\/api\/config$/, async () => service.config()],
    ["GET", /^\/api\/usage$/, async () => service.usage()],
    ["GET", /^\/api\/assumptions$/, async () => service.assumptions()],
    ["GET", /^\/api\/rates$/, async () => service.rates()],
    ["PUT", /^\/api\/rates$/, async ({ req }) => service.saveRates((await jsonBody(req)).rows)],

    ["GET", /^\/api\/jobs$/, async () => service.listJobs()],
    ["POST", /^\/api\/jobs$/, async ({ req, query }) => {
      const ctype = req.headers["content-type"] || "";
      const missing = () => new HttpError(422, [{ loc: ["body", "file"], msg: "Field required", type: "missing" }]);
      if (!/multipart\/form-data/i.test(ctype)) throw missing();
      const part = parseMultipart(await readBody(req, uploadLimit), ctype).find((p) => p.name === "file" && p.filename !== null);
      if (!part) throw missing();
      const job = await service.createJob(part.filename, part.data, { force: parseBool(query.get("force"), "force") ?? false });
      return { status: 202, body: job };
    }],
    ["GET", /^\/api\/jobs\/([^/]+)$/, async ({ params }) => service.getJob(params[0])],
    ["POST", /^\/api\/jobs\/([^/]+)\/rebuild$/, async ({ params }) => service.rebuild(params[0])],
    ["GET", /^\/api\/jobs\/([^/]+)\/extraction$/, async ({ params }) => service.extraction(params[0])],
    ["GET", /^\/api\/jobs\/([^/]+)\/boq\.xlsx$/, async ({ params }) => {
      const file = service.xlsxPath(params[0]);
      return { type: XLSX, body: fs.readFileSync(file), raw: true,
        headers: { "Content-Disposition": `attachment; filename="${file.split(/[\\/]/).pop()}"` } };
    }],
  ];

  function corsHeaders(req) {
    const origin = req.headers.origin;
    if (!origin || !origins.length) return null;
    if (!(origins.includes("*") || origins.includes(origin))) return null;
    return { "Access-Control-Allow-Origin": origins.includes("*") ? "*" : origin, Vary: "Origin",
      "Access-Control-Expose-Headers": "Content-Disposition" };
  }

  function send(res, status, type, body, extra = {}) {
    res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(body), ...extra });
    res.end(body);
  }

  return async function handle(req, res) {
    const cors = corsHeaders(req) || {};
    try {
      const url = new URL(req.url, "http://localhost");

      if (req.method === "OPTIONS" && req.headers["access-control-request-method"]) {     // CORS preflight
        if (!Object.keys(cors).length) return send(res, 400, "text/plain; charset=utf-8", "Disallowed CORS origin");
        return send(res, 200, "text/plain; charset=utf-8", "OK", {
          ...cors, "Access-Control-Allow-Methods": "DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT",
          "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] || "*",
          "Access-Control-Max-Age": "600" });
      }
      if (url.pathname === "/" && req.method === "GET") {
        return send(res, 200, "application/json", JSON.stringify({ name: "Drawing PDF to BOQ API", version: "2.0", health: "/api/health" }), cors);
      }

      // Internal service: when BOQ_SERVICE_KEY is set, every call except /api/health must carry it.
      if (serviceKey && url.pathname !== "/api/health") {
        const given = Buffer.from(String(req.headers["x-service-key"] || "")), want = Buffer.from(serviceKey);
        if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return send(res, 401, "application/json", JSON.stringify({ detail: "service key required" }), cors);
      }

      let pathMatched = false;
      for (const [method, re, handler] of routes) {
        const m = re.exec(url.pathname);
        if (!m) continue;
        pathMatched = true;
        if (method !== req.method) continue;
        const params = m.slice(1).map((s) => { try { return decodeURIComponent(s); } catch { throw new HttpError(422, "bad path"); } });
        const out = await handler({ req, res, params, query: url.searchParams });
        if (out && out.raw) return send(res, 200, out.type, out.body, { ...cors, ...(out.headers || {}) });
        if (out && out.status && "body" in out) return send(res, out.status, "application/json", JSON.stringify(out.body), cors);
        return send(res, 200, "application/json", JSON.stringify(out), cors);
      }
      throw new HttpError(pathMatched ? 405 : 404, pathMatched ? "Method Not Allowed" : "Not Found");
    } catch (err) {
      if (err instanceof ServiceError) return send(res, err.status, "application/json", JSON.stringify({ detail: err.message }), cors);
      if (err instanceof HttpError) return send(res, err.status, "application/json", JSON.stringify({ detail: err.detail }), cors);
      console.error(err);
      if (!res.headersSent) send(res, 500, "application/json", JSON.stringify({ detail: "Internal Server Error" }), cors);
      else res.end();
    }
  };
}

export function startServer({ host = process.env.HOST || "127.0.0.1", port = Number(process.env.PORT || 8000), service } = {}) {
  const server = http.createServer(createApp(service));
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().then((s) => {
    const a = s.address();
    console.log(`Drawing PDF to BOQ API listening on http://${a.address}:${a.port}`);
  });
}
