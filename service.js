// /**
//  * The backend's logic, with no web framework in it.
//  *
//  * A "job" is one PDF going through:  upload -> Claude reads the PDF ->
//  * checks -> quantities -> rates -> Excel.  Jobs run in the background (a read
//  * can take minutes), are saved to disk, and survive a restart.
//  *
//  *     data/jobs/<id>/input.pdf       the upload
//  *     data/jobs/<id>/job.json        status, usage, cost, result summary
//  *     data/jobs/<id>/extraction.json what Claude read (drives the BOQ)
//  *     data/jobs/<id>/<name>_BOQ.xlsx the Excel file
//  */
// import crypto from "node:crypto";
// import fs from "node:fs";
// import path from "node:path";

// import { runBoq } from "./boq/pipeline.js";
// import { buildDoc } from "./claude/documentSchema.js";
// import { ClaudePdfReader, costUsd } from "./claude/pdfReader.js";
// import { reprValue } from "./claude/schemas.js";
// import { ValueError, parseRate } from "./pricing/rateLookup.js";
// import { loadAssumptions } from "./takeoff/quantities.js";
// import { readDictCsv, writeDictCsv } from "./util/csv.js";
// import { pyStr, truthy } from "./util/pyfmt.js";
// import { TomlError } from "./util/toml.js";

// export const JOB_ID_RE = /^[a-f0-9]{12}$/;

// export const RATE_FIELDS = ["item_code", "description", "unit", "rate", "currency", "region", "date", "source"];
// const RATES_HEADER =
//   "# YOUR RATE BOOK. Rates are deliberately blank until you fill them in:\n" +
//   "# a blank rate leaves the BOQ line unpriced; nothing is ever guessed.\n" +
//   "# item_code may end in * to cover a family (e.g. OPN-DOOR-*).\n";

// /** An error the caller can fix; carries the HTTP status to use. */
// export class ServiceError extends Error {
//   constructor(message, status = 400) { super(message); this.name = "ServiceError"; this.message = message; this.status = status; }
// }
// export class NotFound extends ServiceError {
//   constructor(message) { super(message, 404); this.name = "NotFound"; }
// }
// export class Unavailable extends ServiceError {
//   constructor(message) { super(message, 503); this.name = "Unavailable"; }
// }

// function defaultReaderFactory(settings) {
//   if (!process.env.ANTHROPIC_API_KEY) throw new Unavailable("ANTHROPIC_API_KEY is not set on the backend");
//   return new ClaudePdfReader({ model: settings.model, maxTokens: settings.maxTokens, cacheDir: settings.cacheDir });
// }

// /** Lets at most `limit` tasks run at once; the others wait their turn. */
// class Semaphore {
//   constructor(limit) { this.limit = Math.max(1, limit); this.active = 0; this.waiting = []; }
//   async acquire() {
//     if (this.active < this.limit) { this.active++; return; }
//     await new Promise((resolve) => this.waiting.push(resolve));
//   }
//   release() {
//     const next = this.waiting.shift();
//     if (next) next(); else this.active--;
//   }
// }

// const safeStem = (filename) =>
//   (path.parse(filename || "").name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[._-]+|[._-]+$/g, "").slice(0, 60)) || "drawings";

// export class JobService {
//   constructor(settings, { readerFactory = null } = {}) {
//     this.settings = settings;
//     this._readerFactory = readerFactory || defaultReaderFactory;
//     this._reader = null;
//     this._sem = new Semaphore(settings.maxConcurrentJobs);
//     this._running = new Set();                      // promises of jobs in flight (for tests / shutdown)
//     fs.mkdirSync(settings.jobsDir, { recursive: true });
//     this._recoverInterrupted();
//   }

//   // ------------------------------------------------------------------
//   // storage
//   // ------------------------------------------------------------------
//   _dir(id) {
//     if (!JOB_ID_RE.test(id || "")) throw new NotFound(`no job ${reprValue(id)}`);
//     const dir = path.join(this.settings.jobsDir, id);
//     if (!fs.existsSync(path.join(dir, "job.json"))) throw new NotFound(`no job ${reprValue(id)}`);
//     return dir;
//   }

//   _read(id) { return JSON.parse(fs.readFileSync(path.join(this._dir(id), "job.json"), "utf8")); }

//   _write(job) {
//     job.updated_at = new Date().toISOString();
//     fs.writeFileSync(path.join(this.settings.jobsDir, job.id, "job.json"), JSON.stringify(job, null, 2), "utf8");
//     return job;
//   }

//   _update(id, patch) { return this._write({ ...this._read(id), ...patch }); }

//   /** A server restart kills running jobs; mark them so the front end does not wait forever. */
//   _recoverInterrupted() {
//     for (const id of fs.readdirSync(this.settings.jobsDir)) {
//       const file = path.join(this.settings.jobsDir, id, "job.json");
//       if (!JOB_ID_RE.test(id) || !fs.existsSync(file)) continue;
//       const job = JSON.parse(fs.readFileSync(file, "utf8"));
//       if (["queued", "reading", "building"].includes(job.status)) {
//         this._write({ ...job, status: "failed", stage: "Interrupted",
//           error: "the server restarted while this job was running; upload the PDF again " +
//             "(if Claude had already answered, the repeat is free)" });
//       }
//     }
//   }

//   _getReader() {
//     if (!this._reader) this._reader = this._readerFactory(this.settings);
//     return this._reader;
//   }

//   // ------------------------------------------------------------------
//   // jobs
//   // ------------------------------------------------------------------
//   /** Accept a PDF and start processing it in the background. Returns the new job. */
//   async createJob(filename, data, { force = false } = {}) {
//     const bytes = Buffer.from(data);
//     if (!bytes.subarray(0, 4).equals(Buffer.from("%PDF"))) throw new ServiceError("that file is not a PDF");
//     const maxBytes = this.settings.maxPdfMb * 1024 * 1024;
//     if (bytes.length > maxBytes) {
//       throw new ServiceError(`the PDF is ${(bytes.length / 1048576).toFixed(1)} MB; the limit is ` +
//         `${this.settings.maxPdfMb} MB (the Claude API request limit is 32 MB). Split or compress the PDF.`, 413);
//     }
//     this._getReader();                              // fails fast (503) when no API key is set

//     const id = crypto.randomBytes(6).toString("hex");
//     fs.mkdirSync(path.join(this.settings.jobsDir, id), { recursive: true });
//     fs.writeFileSync(path.join(this.settings.jobsDir, id, "input.pdf"), bytes);
//     const now = new Date().toISOString();
//     const job = this._write({
//       id, filename: path.basename(filename || "drawings.pdf"), status: "queued", stage: "Waiting to start",
//       created_at: now, error: null, model: this.settings.model, cached: null,
//       usage: null, cost_usd: null, result: null,
//     });

//     const run = this._run(id, force).finally(() => this._running.delete(run));
//     this._running.add(run);
//     return job;
//   }

//   /** Resolves when every job started so far has finished (used by tests and shutdown). */
//   async idle() { while (this._running.size) await Promise.allSettled([...this._running]); }

//   async _run(id, force) {
//     await this._sem.acquire();
//     try {
//       const job = this._read(id);
//       this._update(id, { status: "reading", stage: "Claude is reading the PDF (this can take a few minutes)" });
//       const pdf = fs.readFileSync(path.join(this._dir(id), "input.pdf"));
//       const { raw, usage, cached } = await this._getReader().read(pdf, job.filename, !force);

//       const { doc, problems } = buildDoc(raw, job.filename);
//       if (!doc.views.length) throw new ServiceError("Claude found no drawings in this PDF" +
//         (problems.length ? ` (${problems.join("; ")})` : ""));
//       fs.writeFileSync(path.join(this._dir(id), "extraction.json"), JSON.stringify(doc, null, 2), "utf8");

//       this._update(id, {
//         status: "building", stage: "Building the Excel file", cached,
//         usage, cost_usd: costUsd(usage, this.settings.priceInPerMtok, this.settings.priceOutPerMtok),
//       });
//       const result = this._build(id, doc);
//       this._update(id, { status: "done", stage: "Done", result });
//     } catch (err) {
//       // Expected failures (API errors, unreadable result) get one log line; real bugs get a stack trace.
//       if (["ServiceError", "ApiError", "ExtractionError"].includes(err.name)) console.error(`job ${id} failed: ${err.message}`);
//       else console.error(`job ${id}:`, err);
//       this._update(id, { status: "failed", stage: "Failed", error: err.message });
//     } finally {
//       this._sem.release();
//     }
//   }

//   /** extraction -> checks, quantities, rates -> Excel. Returns the summary stored on the job. */
//   _build(id, doc) {
//     const job = this._read(id);
//     let res;
//     try {
//       res = runBoq(doc, this.settings, safeStem(job.filename), this._dir(id));
//     } catch (exc) {
//       if (exc && exc.code === "ENOENT") throw new ServiceError(`missing settings file: ${exc.message}`, 500);
//       if (exc instanceof ValueError || exc instanceof TomlError) throw new ServiceError(`settings problem: ${exc.message}`, 400);
//       throw exc;
//     }
//     const views = doc.views.filter((v) => v.extraction);
//     return {
//       currency: res.boq.currency,
//       sections: res.boq.sections.map((s) => ({
//         key: s.key, title: s.title, total: s.total,
//         lines: s.lines.map((l) => ({
//           item: l.item, code: l.code, description: l.description, unit: l.unit, quantity: l.quantity,
//           rate: l.rate, amount: l.amount, basis: l.basis, rate_source: l.rate_source,
//         })),
//       })),
//       totals: res.boq.totals(),
//       unpriced: res.boq.unpriced.map((l) => ({ item: l.item, code: l.code, description: l.description })),
//       issues: res.issues.map((i) => ({ level: i.level, where: i.where, message: i.message })),
//       document_warnings: doc.document_warnings || [],
//       counts: {
//         drawings: views.length,
//         rooms: views.reduce((n, v) => n + v.extraction.rooms.length, 0),
//         openings: views.reduce((n, v) => n + v.extraction.openings.length, 0),
//       },
//       xlsx: path.basename(res.xlsx),
//     };
//   }

//   getJob(id) { this._dir(id); return this._read(id); }

//   listJobs(limit = 50) {
//     const out = [];
//     for (const id of fs.readdirSync(this.settings.jobsDir)) {
//       if (!JOB_ID_RE.test(id) || !fs.existsSync(path.join(this.settings.jobsDir, id, "job.json"))) continue;
//       const j = this._read(id);
//       out.push({
//         id: j.id, filename: j.filename, status: j.status, stage: j.stage, created_at: j.created_at,
//         error: j.error, cost_usd: j.cost_usd,
//         total: j.result ? j.result.totals.total : null, currency: j.result ? j.result.currency : null,
//       });
//     }
//     return out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, limit);
//   }

//   /** What Claude read from the PDF (rooms, schedules, notes). */
//   extraction(id) {
//     const file = path.join(this._dir(id), "extraction.json");
//     if (!fs.existsSync(file)) throw new NotFound("this job has no extraction yet");
//     return JSON.parse(fs.readFileSync(file, "utf8"));
//   }

//   /** Recompute the BOQ and Excel from the saved extraction with the CURRENT rates
//    * and assumptions. Free: it does not call the API again. */
//   rebuild(id) {
//     const job = this.getJob(id);
//     if (job.status !== "done") throw new ServiceError("this job has not finished yet");
//     const result = this._build(id, this.extraction(id));
//     return this._update(id, { result });
//   }

//   xlsxPath(id) {
//     const job = this.getJob(id);
//     if (!job.result) throw new NotFound("no Excel file for this job yet");
//     const file = path.join(this._dir(id), job.result.xlsx);
//     if (!fs.existsSync(file)) throw new NotFound("the Excel file is missing; rebuild the job");
//     return file;
//   }

//   // ------------------------------------------------------------------
//   // settings the front end shows or edits
//   // ------------------------------------------------------------------
//   usage() {
//     const r = this._reader;
//     const tin = r ? r.total_input : 0, tout = r ? r.total_output : 0;
//     return {
//       calls: r ? r.calls : 0, cache_hits: r ? r.cache_hits : 0, input_tokens: tin, output_tokens: tout,
//       cost_usd: costUsd({ input_tokens: tin, output_tokens: tout }, this.settings.priceInPerMtok, this.settings.priceOutPerMtok) || 0.0,
//     };
//   }

//   config() {
//     const s = this.settings;
//     return {
//       model: s.model, currency: s.currency, max_pdf_mb: s.maxPdfMb,
//       price_in_per_mtok: s.priceInPerMtok, price_out_per_mtok: s.priceOutPerMtok,
//       api_key_set: Boolean(process.env.ANTHROPIC_API_KEY),
//     };
//   }

//   assumptions() {
//     try { return loadAssumptions(this.settings.assumptionsPath); }
//     catch (exc) {
//       if (exc && exc.code === "ENOENT") throw new ServiceError(`missing settings file: ${exc.message}`, 500);
//       throw exc;
//     }
//   }

//   rates() {
//     const file = this.settings.ratesPath;
//     const rows = (fs.existsSync(file) ? readDictCsv(fs.readFileSync(file, "utf8")) : [])
//       .map((r) => Object.fromEntries(RATE_FIELDS.map((k) => [k, truthy(r[k]) ? r[k] : ""])));
//     return { fields: RATE_FIELDS, rows };
//   }

//   /** Replace the rate book. The previous file is kept as rates.csv.bak. */
//   saveRates(rows) {
//     if (!Array.isArray(rows)) throw new ServiceError("rows must be a list");
//     const problems = [], seen = new Set(), clean = [];
//     const text = (v) => (truthy(v) ? pyStr(v) : "");
//     rows.forEach((r0, i) => {
//       const n = i + 1;
//       const r = r0 !== null && typeof r0 === "object" && !Array.isArray(r0) ? r0 : {};
//       const code = text(r.item_code).trim();
//       if (!code) { problems.push(`row ${n}: item_code is empty`); return; }
//       if (seen.has(code)) problems.push(`row ${n}: ${code} appears twice`);
//       seen.add(code);
//       const raw = text(r.rate).replace(/,/g, "").trim();
//       if (raw && Number.isNaN(parseRate(raw))) problems.push(`row ${n} (${code}): rate ${reprValue(r.rate)} is not a number`);
//       clean.push({ ...Object.fromEntries(RATE_FIELDS.map((k) => [k, text(r[k]).trim()])), rate: raw });
//     });
//     if (problems.length) throw new ServiceError(problems.join("; "));

//     const file = this.settings.ratesPath;
//     if (fs.existsSync(file)) fs.writeFileSync(`${file}.bak`, fs.readFileSync(file));
//     fs.writeFileSync(file, RATES_HEADER + writeDictCsv(RATE_FIELDS, clean), "utf8");
//     return { saved: clean.length };
//   }
// }


/**
 * Provider-independent backend service.
 *
 * Job workflow:
 * PDF upload -> AI document extraction -> validation -> quantities ->
 * rates -> BOQ -> Excel.
 *
 * The service manages jobs and BOQ processing. The reader adapter handles
 * communication with the configured AI provider.
 *
 * Job files:
 * data/jobs/<id>/input.pdf
 * data/jobs/<id>/job.json
 * data/jobs/<id>/extraction.json
 * data/jobs/<id>/<name>_BOQ.xlsx
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { runBoq } from "./boq/pipeline.js";
import { buildDoc } from "./claude/documentSchema.js";
import { costUsd } from "./claude/pdfReader.js";
import { createPdfReader } from "./providers/index.js";
import { reprValue } from "./claude/schemas.js";
import { ValueError, parseRate } from "./pricing/rateLookup.js";
import { loadAssumptions } from "./takeoff/quantities.js";
import { readDictCsv, writeDictCsv } from "./util/csv.js";
import { pyStr, truthy } from "./util/pyfmt.js";
import { TomlError } from "./util/toml.js";

export const JOB_ID_RE = /^[a-f0-9]{12}$/;

export const RATE_FIELDS = [
  "item_code",
  "description",
  "unit",
  "rate",
  "currency",
  "region",
  "date",
  "source",
];

const RATES_HEADER =
  "# YOUR RATE BOOK. Rates are deliberately blank until you fill them in:\n" +
  "# a blank rate leaves the BOQ line unpriced; nothing is ever guessed.\n" +
  "# item_code may end in * to cover a family (e.g. OPN-DOOR-*).\n";

/** An error the caller can fix; carries the HTTP status to use. */
export class ServiceError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "ServiceError";
    this.status = status;
  }
}

export class NotFound extends ServiceError {
  constructor(message) {
    super(message, 404);
    this.name = "NotFound";
  }
}

export class Unavailable extends ServiceError {
  constructor(message) {
    super(message, 503);
    this.name = "Unavailable";
  }
}

/**
 * Creates the configured reader.
 *
 * The provider adapter must accept the original PDF bytes and must not
 * extract PDF text locally.
 *
 * Additional providers will be added through this factory.
 */
// function defaultReaderFactory(settings) {
//   if (!settings.apiKey) {
//     throw new Unavailable(
//       "AI_API_KEY is not configured on the backend"
//     );
//   }

//   if (settings.aiProvider !== "anthropic") {
//     throw new Unavailable(
//       `The "${settings.aiProvider}" provider adapter has not been implemented yet`
//     );
//   }

//   return new ClaudePdfReader({
//     apiKey: settings.apiKey,
//     baseUrl: settings.baseUrl,
//     model: settings.model,
//     maxTokens: settings.maxTokens,
//     cacheDir: settings.cacheDir,
//     timeoutMs: settings.timeoutMs,
//     maxRetries: settings.maxRetries,
//   });
// }
function defaultReaderFactory(settings) {
  try {
    return createPdfReader(settings);
  } catch (err) {
    throw new Unavailable(err.message);
  }
}

/** Lets at most limit tasks run at once; the others wait their turn. */
class Semaphore {
  constructor(limit) {
    this.limit = Math.max(1, limit);
    this.active = 0;
    this.waiting = [];
  }

  async acquire() {
    if (this.active < this.limit) {
      this.active++;
      return;
    }

    await new Promise((resolve) => this.waiting.push(resolve));
  }

  release() {
    const next = this.waiting.shift();

    if (next) {
      next();
    } else {
      this.active--;
    }
  }
}

const safeStem = (filename) =>
  (
    path
      .parse(filename || "")
      .name.replace(/[^A-Za-z0-9._-]/g, "_")
      .replace(/^[._-]+|[._-]+$/g, "")
      .slice(0, 60)
  ) || "drawings";

export class JobService {
  constructor(settings, { readerFactory = null } = {}) {
    this.settings = settings;
    this._readerFactory = readerFactory || defaultReaderFactory;
    this._reader = null;
    this._sem = new Semaphore(settings.maxConcurrentJobs);
    this._running = new Set();

    fs.mkdirSync(settings.jobsDir, { recursive: true });
    this._recoverInterrupted();
  }

  // ---------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------

  _dir(id) {
    if (!JOB_ID_RE.test(id || "")) {
      throw new NotFound(`no job ${reprValue(id)}`);
    }

    const dir = path.join(this.settings.jobsDir, id);

    if (!fs.existsSync(path.join(dir, "job.json"))) {
      throw new NotFound(`no job ${reprValue(id)}`);
    }

    return dir;
  }

  _read(id) {
    return JSON.parse(
      fs.readFileSync(
        path.join(this._dir(id), "job.json"),
        "utf8"
      )
    );
  }

  _write(job) {
    job.updated_at = new Date().toISOString();

    fs.writeFileSync(
      path.join(this.settings.jobsDir, job.id, "job.json"),
      JSON.stringify(job, null, 2),
      "utf8"
    );

    return job;
  }

  _update(id, patch) {
    return this._write({
      ...this._read(id),
      ...patch,
    });
  }

  /** Mark unfinished jobs as failed after a server restart. */
  _recoverInterrupted() {
    for (const id of fs.readdirSync(this.settings.jobsDir)) {
      const file = path.join(
        this.settings.jobsDir,
        id,
        "job.json"
      );

      if (!JOB_ID_RE.test(id) || !fs.existsSync(file)) {
        continue;
      }

      const job = JSON.parse(
        fs.readFileSync(file, "utf8")
      );

      if (
        ["queued", "reading", "building"].includes(job.status)
      ) {
        this._write({
          ...job,
          status: "failed",
          stage: "Interrupted",
          error:
            "The server restarted while this job was running. " +
            "Upload the PDF again. If the AI provider had already " +
            "completed the extraction, the cached result may be reusable.",
        });
      }
    }
  }

  _getReader() {
    if (!this._reader) {
      this._reader = this._readerFactory(this.settings);
    }

    return this._reader;
  }

  // ---------------------------------------------------------------
  // Jobs
  // ---------------------------------------------------------------

  /** Accept a PDF and start processing it in the background. */
  async createJob(filename, data, { force = false } = {}) {
    const bytes = Buffer.from(data);

    if (!bytes.subarray(0, 4).equals(Buffer.from("%PDF"))) {
      throw new ServiceError("That file is not a PDF");
    }

    const maxBytes = this.settings.maxPdfMb * 1024 * 1024;

    if (bytes.length > maxBytes) {
      throw new ServiceError(
        `The PDF is ${(bytes.length / 1048576).toFixed(1)} MB; ` +
          `the configured limit is ${this.settings.maxPdfMb} MB. ` +
          "Split or compress the PDF.",
        413
      );
    }

    // Fail before creating a job if the reader cannot be configured.
    this._getReader();

    const id = crypto.randomBytes(6).toString("hex");
    const jobDir = path.join(this.settings.jobsDir, id);

    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(path.join(jobDir, "input.pdf"), bytes);

    const now = new Date().toISOString();

    const job = this._write({
      id,
      filename: path.basename(filename || "drawings.pdf"),
      status: "queued",
      stage: "Waiting to start",
      created_at: now,
      error: null,
      provider: this.settings.aiProvider,
      model: this.settings.model,
      cached: null,
      usage: null,
      cost_usd: null,
      result: null,
    });

    const run = this._run(id, force).finally(() => {
      this._running.delete(run);
    });

    this._running.add(run);

    return job;
  }

  /** Wait until every job started so far has finished. */
  async idle() {
    while (this._running.size) {
      await Promise.allSettled([...this._running]);
    }
  }

  async _run(id, force) {
    await this._sem.acquire();

    try {
      const job = this._read(id);

      this._update(id, {
        status: "reading",
        stage: "AI provider is reading the original PDF",
      });

      // Pass the original PDF bytes to the reader without local text extraction.
      const pdf = fs.readFileSync(
        path.join(this._dir(id), "input.pdf")
      );

      const { raw, usage, cached } = await this._getReader().read(
        pdf,
        job.filename,
        !force
      );

      // Validate and normalize the provider's structured response.
      const { doc, problems } = buildDoc(raw, job.filename);

      if (!doc.views.length) {
        throw new ServiceError(
          "The AI provider found no drawings in this PDF" +
            (problems.length
              ? ` (${problems.join("; ")})`
              : "")
        );
      }

      fs.writeFileSync(
        path.join(this._dir(id), "extraction.json"),
        JSON.stringify(doc, null, 2),
        "utf8"
      );

      this._update(id, {
        status: "building",
        stage: "Building the BOQ and Excel file",
        cached,
        usage,
        cost_usd: costUsd(
          usage,
          this.settings.priceInPerMtok,
          this.settings.priceOutPerMtok
        ),
      });

      const result = this._build(id, doc);

      this._update(id, {
        status: "done",
        stage: "Done",
        result,
      });
    } catch (err) {
      if (
        [
          "ServiceError",
          "ApiError",
          "ExtractionError",
          "Unavailable",
        ].includes(err.name)
      ) {
        console.error(`Job ${id} failed: ${err.message}`);
      } else {
        console.error(`Job ${id}:`, err);
      }

      this._update(id, {
        status: "failed",
        stage: "Failed",
        error: err.message,
      });
    } finally {
      this._sem.release();
    }
  }

  /** Build quantities, rates, BOQ and Excel from the extracted document. */
  _build(id, doc) {
    const job = this._read(id);
    let res;

    try {
      res = runBoq(
        doc,
        this.settings,
        safeStem(job.filename),
        this._dir(id)
      );
    } catch (exc) {
      if (exc && exc.code === "ENOENT") {
        throw new ServiceError(
          `Missing settings file: ${exc.message}`,
          500
        );
      }

      if (
        exc instanceof ValueError ||
        exc instanceof TomlError
      ) {
        throw new ServiceError(
          `Settings problem: ${exc.message}`,
          400
        );
      }

      throw exc;
    }

    const views = doc.views.filter((v) => v.extraction);

    return {
      currency: res.boq.currency,

      sections: res.boq.sections.map((s) => ({
        key: s.key,
        title: s.title,
        total: s.total,

        lines: s.lines.map((l) => ({
          item: l.item,
          code: l.code,
          description: l.description,
          unit: l.unit,
          quantity: l.quantity,
          rate: l.rate,
          amount: l.amount,
          basis: l.basis,
          rate_source: l.rate_source,
        })),
      })),

      totals: res.boq.totals(),

      unpriced: res.boq.unpriced.map((l) => ({
        item: l.item,
        code: l.code,
        description: l.description,
      })),

      issues: res.issues.map((i) => ({
        level: i.level,
        where: i.where,
        message: i.message,
      })),

      document_warnings: doc.document_warnings || [],

      counts: {
        drawings: views.length,
        rooms: views.reduce(
          (n, v) => n + v.extraction.rooms.length,
          0
        ),
        openings: views.reduce(
          (n, v) => n + v.extraction.openings.length,
          0
        ),
      },

      xlsx: path.basename(res.xlsx),
    };
  }

  getJob(id) {
    this._dir(id);
    return this._read(id);
  }

  listJobs(limit = 50) {
    const out = [];

    for (const id of fs.readdirSync(this.settings.jobsDir)) {
      if (
        !JOB_ID_RE.test(id) ||
        !fs.existsSync(
          path.join(this.settings.jobsDir, id, "job.json")
        )
      ) {
        continue;
      }

      const job = this._read(id);

      out.push({
        id: job.id,
        filename: job.filename,
        status: job.status,
        stage: job.stage,
        created_at: job.created_at,
        error: job.error,
        cost_usd: job.cost_usd,
        total: job.result ? job.result.totals.total : null,
        currency: job.result ? job.result.currency : null,
      });
    }

    return out
      .sort((a, b) =>
        a.created_at < b.created_at ? 1 : -1
      )
      .slice(0, limit);
  }

  /** Return the structured extraction saved for this job. */
  extraction(id) {
    const file = path.join(
      this._dir(id),
      "extraction.json"
    );

    if (!fs.existsSync(file)) {
      throw new NotFound(
        "This job has no extraction yet"
      );
    }

    return JSON.parse(
      fs.readFileSync(file, "utf8")
    );
  }

  /**
   * Rebuild the BOQ and Excel from a saved extraction using current
   * rates and assumptions. This does not call the AI provider.
   */
  rebuild(id) {
    const job = this.getJob(id);

    if (job.status !== "done") {
      throw new ServiceError(
        "This job has not finished yet"
      );
    }

    const result = this._build(
      id,
      this.extraction(id)
    );

    return this._update(id, { result });
  }

  xlsxPath(id) {
    const job = this.getJob(id);

    if (!job.result) {
      throw new NotFound(
        "No Excel file for this job yet"
      );
    }

    const file = path.join(
      this._dir(id),
      job.result.xlsx
    );

    if (!fs.existsSync(file)) {
      throw new NotFound(
        "The Excel file is missing; rebuild the job"
      );
    }

    return file;
  }

  // ---------------------------------------------------------------
  // Usage and public configuration
  // ---------------------------------------------------------------

  usage() {
    const reader = this._reader;
    const inputTokens = reader ? reader.total_input : 0;
    const outputTokens = reader ? reader.total_output : 0;

    return {
      calls: reader ? reader.calls : 0,
      cache_hits: reader ? reader.cache_hits : 0,
      input_tokens: inputTokens,
      output_tokens: outputTokens,

      cost_usd:
        costUsd(
          {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
          },
          this.settings.priceInPerMtok,
          this.settings.priceOutPerMtok
        ) || 0,
    };
  }

  /** Safe settings for the frontend. Never return the API key or its URL. */
  config() {
    const settings = this.settings;

    return {
      ai_provider: settings.aiProvider,
      model: settings.model,
      currency: settings.currency,
      max_pdf_mb: settings.maxPdfMb,
      price_in_per_mtok: settings.priceInPerMtok,
      price_out_per_mtok: settings.priceOutPerMtok,
      api_key_set: Boolean(settings.apiKey),
    };
  }

  assumptions() {
    try {
      return loadAssumptions(
        this.settings.assumptionsPath
      );
    } catch (exc) {
      if (exc && exc.code === "ENOENT") {
        throw new ServiceError(
          `Missing settings file: ${exc.message}`,
          500
        );
      }

      throw exc;
    }
  }

  rates() {
    const file = this.settings.ratesPath;

    const rows = (
      fs.existsSync(file)
        ? readDictCsv(fs.readFileSync(file, "utf8"))
        : []
    ).map((row) =>
      Object.fromEntries(
        RATE_FIELDS.map((key) => [
          key,
          truthy(row[key]) ? row[key] : "",
        ])
      )
    );

    return {
      fields: RATE_FIELDS,
      rows,
    };
  }

  /** Replace the rate book. Preserve the previous file as rates.csv.bak. */
  saveRates(rows) {
    if (!Array.isArray(rows)) {
      throw new ServiceError("rows must be a list");
    }

    const problems = [];
    const seen = new Set();
    const clean = [];

    const text = (value) =>
      truthy(value) ? pyStr(value) : "";

    rows.forEach((rowValue, index) => {
      const rowNumber = index + 1;

      const row =
        rowValue !== null &&
        typeof rowValue === "object" &&
        !Array.isArray(rowValue)
          ? rowValue
          : {};

      const code = text(row.item_code).trim();

      if (!code) {
        problems.push(
          `row ${rowNumber}: item_code is empty`
        );
        return;
      }

      if (seen.has(code)) {
        problems.push(
          `row ${rowNumber}: ${code} appears twice`
        );
      }

      seen.add(code);

      const rawRate = text(row.rate)
        .replace(/,/g, "")
        .trim();

      if (
        rawRate &&
        Number.isNaN(parseRate(rawRate))
      ) {
        problems.push(
          `row ${rowNumber} (${code}): rate ` +
            `${reprValue(row.rate)} is not a number`
        );
      }

      clean.push({
        ...Object.fromEntries(
          RATE_FIELDS.map((key) => [
            key,
            text(row[key]).trim(),
          ])
        ),
        rate: rawRate,
      });
    });

    if (problems.length) {
      throw new ServiceError(
        problems.join("; ")
      );
    }

    const file = this.settings.ratesPath;

    if (fs.existsSync(file)) {
      fs.writeFileSync(
        `${file}.bak`,
        fs.readFileSync(file)
      );
    }

    fs.writeFileSync(
      file,
      RATES_HEADER +
        writeDictCsv(RATE_FIELDS, clean),
      "utf8"
    );

    return {
      saved: clean.length,
    };
  }
}
