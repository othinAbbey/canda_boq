/** Test helpers: a mock of the Anthropic Messages API (streaming) and a few utilities. */
import http from "node:http";
import zlib from "node:zlib";

/** A realistic answer for a small drawing set. */
export const SAMPLE_RESULT = {
  project_name: "Test House",
  views: [
    { page: 1, view_type: "floor_plan", title: "G-Floor Plan", scale_label: "1:100", level: "Ground floor",
      rooms: [
        { name: "Lounge", length_mm: 5000, width_mm: 4000, confidence: "high" },
        { name: "Bedroom 01", length_mm: 3285, width_mm: 2740, confidence: "high" },
        { name: "Kitchen", length_mm: 3000, width_mm: 3000, area_m2: 9, confidence: "medium" },
        { name: "Wc/sh", length_mm: 2000, width_mm: 1500, confidence: "high" },
        { name: "Staircase", length_mm: 2500, width_mm: 2000, confidence: "high" },
      ],
      openings: [], notes: [], warnings: [],
      opening_tags_on_plan: [{ mark: "D6", count: 2 }, { mark: "W3", count: 1 }] },
    { page: 1, view_type: "floor_plan", title: "First Floor Plan", scale_label: "1:100", level: "First floor",
      rooms: [
        { name: "Master Bedroom", length_mm: 4500, width_mm: 4000, confidence: "high" },
        { name: "Bath", length_mm: 2500, width_mm: 2000, confidence: "low" },
      ],
      openings: [], notes: [], warnings: ["dimension near the stairs is hard to read"],
      opening_tags_on_plan: [{ mark: "D6", count: 1 }, { mark: "W3", count: 2 }] },
    { page: 2, view_type: "schedule", title: "Door and Window Schedule", scale_label: null, level: null,
      rooms: [],
      openings: [
        { mark: "d6", kind: "door", width_mm: 900, height_mm: 2100, count: 3, description: "Timber flush door" },
        { mark: "W3", kind: "window", width_mm: 1500, height_mm: 1200, count: 4 },
      ],
      notes: [], warnings: [] },
    { page: 2, view_type: "notes", title: "General notes", scale_label: null, level: null,
      rooms: [], openings: [],
      notes: [{ topic: "Walls", text: "200mm hollow block, plastered both sides" }], warnings: [] },
  ],
  document_warnings: ["Page 3 is a site plan and was not measured"],
};

/**
 * Start a mock Anthropic API. `mode` decides what the next requests do:
 *   "ok" | "overloaded-once" | "auth" | "max_tokens" | "stream-error" | "no-tool" | "slow" | "badjson"
 * Every request received is kept in `requests` (parsed JSON body + headers).
 */
export async function startMockAnthropic() {
  const state = { mode: "ok", requests: [], result: SAMPLE_RESULT, overloadedSent: 0, delayMs: 0 };

  const sseWrite = async (res, events) => {
    const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
    let i = 0;
    while (i < text.length) {                       // tiny random chunks: events get split mid-way
      const n = 1 + Math.floor(Math.random() * 60);
      res.write(text.slice(i, i + n)); i += n;
      if (Math.random() < 0.1) await new Promise((r) => setImmediate(r));
    }
  };

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", async () => {
      const body = JSON.parse(raw || "{}");
      state.requests.push({ url: req.url, headers: req.headers, body });
      const mode = state.mode;

      if (mode === "auth") {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
      }
      if (mode === "overloaded-once" && state.overloadedSent < 1) {
        state.overloadedSent++;
        res.writeHead(529, { "content-type": "application/json", "retry-after": "0" });
        return res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
      }
      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));

      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const json = JSON.stringify(state.result);
      const start = { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], model: body.model, usage: { input_tokens: 12000, output_tokens: 1 } } };
      if (mode === "stream-error") {
        await sseWrite(res, [start, { type: "ping" }, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]);
        return res.end();
      }
      if (mode === "no-tool") {
        await sseWrite(res, [start,
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I cannot do that." } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }, { type: "message_stop" }]);
        return res.end();
      }
      const cut = mode === "max_tokens" ? Math.floor(json.length / 2) : mode === "badjson" ? json.length : json.length;
      const payload = mode === "badjson" ? json.slice(0, 20) + "}}}garbage" : json.slice(0, cut);
      const deltas = [];
      for (let i = 0; i < payload.length; i += 97) {
        deltas.push({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: payload.slice(i, i + 97) } });
      }
      await sseWrite(res, [
        start, { type: "ping" },
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "record_drawing_set", input: {} } },
        ...deltas, { type: "ping" },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: mode === "max_tokens" ? "max_tokens" : "tool_use" }, usage: { output_tokens: 3456 } },
        { type: "message_stop" },
      ]);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { state, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

/** Read the named files out of a zip (xlsx) held in a Buffer: {name: string}. */
export function readZip(buf) {
  const files = {};
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString("utf8");
    const lnlen = buf.readUInt16LE(off + 26), lelen = buf.readUInt16LE(off + 28);
    const data = buf.slice(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize);
    files[name] = (method === 8 ? zlib.inflateRawSync(data) : data).toString("utf8");
    p += 46 + nlen + elen + clen;
  }
  return files;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
