/**
 * What the model must return for each view, as a JSON schema (for the API's
 * forced tool call) plus tolerant parsing of the answer.
 *
 * Design rules
 * ------------
 * - Everything the model is unsure about is null, never a guess.
 * - Sizes are millimetres. Areas are m2 and only when printed on the drawing.
 * - No quantities and no prices: those are computed by code (takeoff/, pricing/).
 */
import { pyRoundInt, pyStr, truthy } from "../util/pyfmt.js";

export const VIEW_TYPES = ["floor_plan", "roof_plan", "site_plan", "elevation", "section",
  "detail", "schedule", "notes", "other"];

const NUM = { type: ["number", "null"] };
const STR = { type: ["string", "null"] };

export const VIEW_SCHEMA = {
  type: "object",
  properties: {
    view_type: { type: "string", enum: VIEW_TYPES },
    title: STR,
    scale_label: { ...STR, description: "Scale printed on the view, e.g. '1:100'." },
    level: { ...STR, description: "e.g. 'Ground floor', 'First floor'." },
    rooms: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Room name as written." },
          length_mm: { ...NUM, description: "Clear internal length if dimensioned." },
          width_mm: { ...NUM, description: "Clear internal width if dimensioned." },
          area_m2: { ...NUM, description: "Only if an area is printed." },
          floor_finish: STR,
          wall_finish: STR,
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          notes: STR,
        },
        required: ["name", "confidence"],
      },
    },
    openings: {
      type: "array",
      description: "Door/window schedule rows (not individual tags on a plan).",
      items: {
        type: "object",
        properties: {
          mark: { type: "string", description: "e.g. D6, W3." },
          kind: { type: "string", enum: ["door", "window"] },
          width_mm: NUM,
          height_mm: NUM,
          count: { type: ["integer", "null"], description: "Count from the schedule." },
          description: STR,
        },
        required: ["mark", "kind"],
      },
    },
    notes: {
      type: "array",
      description: "Construction/specification notes that affect quantities " +
        "(wall construction, finishes, slab, roof).",
      items: {
        type: "object",
        properties: { topic: { type: "string" }, text: { type: "string" } },
        required: ["topic", "text"],
      },
    },
    overall_dimensions_mm: {
      type: "array",
      items: {
        type: "object",
        properties: { label: { type: "string" }, value_mm: NUM },
        required: ["label"],
      },
    },
    warnings: {
      type: "array", items: { type: "string" },
      description: "Anything unclear, cut off or contradictory.",
    },
  },
  required: ["view_type", "rooms", "openings", "notes", "warnings"],
};

// ---------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------

const PY_FLOAT = /^[+-]?(?:\d+(?:_\d+)*(?:\.(?:\d+(?:_\d+)*)?)?|\.\d+(?:_\d+)*)(?:[eE][+-]?\d+(?:_\d+)*)?$/;

/** Python float(v) for JSON values, or null when it would fail (or give inf/nan). */
export function num(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = v.trim();
    if (!PY_FLOAT.test(s)) return null;
    const n = Number(s.replace(/_/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toInt(v) {
  const n = num(v);
  return n === null ? null : pyRoundInt(n);
}

function checkedNum(raw, label, errors) {
  const value = num(raw);
  if (raw !== null && raw !== undefined && value === null) {
    errors.push(`${label}: ${reprValue(raw)} is not a number, value dropped`);
  }
  return value;
}

/** Python repr() for the JSON values that can appear in an error message. */
export function reprValue(v) {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "string") return v.includes("'") && !v.includes('"') ? `"${v}"` : `'${v.replace(/'/g, "\\'")}'`;
  if (Array.isArray(v)) return "[" + v.map(reprValue).join(", ") + "]";
  if (typeof v === "object") return "{" + Object.entries(v).map(([k, x]) => `${reprValue(k)}: ${reprValue(x)}`).join(", ") + "}";
  return String(v);
}

export function emptyExtraction() {
  return {
    view_type: "other", title: null, scale_label: null, level: null,
    rooms: [], openings: [], notes: [], overall_dimensions_mm: [], warnings: [],
  };
}

const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const orEmpty = (x) => (truthy(x) ? x : []);
const get = (o, k) => (o[k] === undefined ? null : o[k]);

/** dict from the model (or from a reviewed JSON) -> [extraction, errors]. */
export function parseView(data) {
  const errors = [];
  if (!isObj(data)) return [emptyExtraction(), ["response is not an object"]];

  let vt = get(data, "view_type");
  if (!VIEW_TYPES.includes(vt)) {
    errors.push(`unknown view_type ${reprValue(vt)}`);
    vt = "other";
  }

  const rooms = [];
  for (const r of orEmpty(data.rooms)) {
    if (!isObj(r) || !truthy(r.name)) {
      errors.push(`room without a name: ${reprValue(r)}`);
      continue;
    }
    const label = `room ${pyStr(r.name)}`;
    rooms.push({
      name: pyStr(r.name).trim(),
      length_mm: checkedNum(r.length_mm, label + " length", errors),
      width_mm: checkedNum(r.width_mm, label + " width", errors),
      area_m2: checkedNum(r.area_m2, label + " area", errors),
      floor_finish: get(r, "floor_finish"), wall_finish: get(r, "wall_finish"),
      confidence: ["high", "medium", "low"].includes(r.confidence) ? r.confidence : "low",
      notes: get(r, "notes"),
    });
  }

  const openings = [];
  for (const o of orEmpty(data.openings)) {
    if (!isObj(o) || !truthy(o.mark) || !["door", "window"].includes(o.kind)) {
      errors.push(`bad opening row: ${reprValue(o)}`);
      continue;
    }
    openings.push({
      mark: pyStr(o.mark).trim().toUpperCase(), kind: o.kind,
      width_mm: checkedNum(o.width_mm, `opening ${pyStr(o.mark)} width`, errors),
      height_mm: checkedNum(o.height_mm, `opening ${pyStr(o.mark)} height`, errors),
      count: toInt(checkedNum(o.count, `opening ${pyStr(o.mark)} count`, errors)),
      description: get(o, "description"),
    });
  }

  const notes = orEmpty(data.notes).filter(isObj).map((n) => ({
    topic: pyStr(n.topic === undefined ? "" : n.topic),
    text: pyStr(n.text === undefined ? "" : n.text),
  }));

  return [{
    view_type: vt, title: get(data, "title"), scale_label: get(data, "scale_label"),
    level: get(data, "level"), rooms, openings, notes,
    overall_dimensions_mm: orEmpty(data.overall_dimensions_mm).filter(isObj),
    warnings: orEmpty(data.warnings).map(pyStr),
  }, errors];
}
