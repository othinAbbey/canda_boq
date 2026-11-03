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
    components: {
      type: "array",
      description: "Elements to be measured, mostly on detail, section and structural sheets: concrete members " +
        "(slab, beam, column, footing, wall), reinforcement, and counted items (pans, covers, fittings). " +
        "Report dimensions exactly as printed. Never calculate volumes, lengths or weights.",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["concrete", "reinforcement", "item"] },
          name: { type: "string", description: "e.g. 'Latrine slab', 'T8 mesh', 'Sato pan'." },
          count: { type: ["integer", "null"], description: "Number of identical elements; 1 if there is one." },
          length_mm: NUM, width_mm: NUM,
          thickness_mm: { ...NUM, description: "Thickness, depth or height of a concrete member (or of an item, if dimensioned)." },
          concrete_grade: { ...STR, description: "As printed: 'Grade 25', 'C25/30', '1:2:4'." },
          bar_diameter_mm: NUM,
          bar_label: { ...STR, description: "As printed: 'T8', 'Y12', 'R6'." },
          spacing_mm: { ...NUM, description: "Centre-to-centre spacing of bars." },
          layers: { type: ["integer", "null"] },
          bar_directions: { type: ["integer", "null"], description: "1, or 2 for a mesh running both ways." },
          bar_count: { type: ["integer", "null"], description: "Total number of bars of this size in the bar schedule, all directions together." },
          length_per_bar_m: { ...NUM, description: "Length per bar in metres, from the bar schedule." },
          printed_total_length_m: { ...NUM, description: "Total bar length in metres, only if the bar schedule prints it." },
          unit: { ...STR, description: "For items: 'nr', 'set', 'm' ... as the drawing says. Default 'nr'." },
          applies_to: { ...STR, description: "For reinforcement: the name of the concrete element it sits in." },
          notes: STR,
        },
        required: ["kind", "name"],
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
    rooms: [], openings: [], notes: [], overall_dimensions_mm: [], components: [], warnings: [],
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

  const components = [];
  for (const c of orEmpty(data.components)) {
    if (!isObj(c) || !["concrete", "reinforcement", "item"].includes(c.kind) || !truthy(c.name)) {
      errors.push(`bad component: ${reprValue(c)}`);
      continue;
    }
    const label = `component ${pyStr(c.name)}`;
    components.push({
      kind: c.kind, name: pyStr(c.name).trim(), count: toInt(checkedNum(c.count, label + " count", errors)),
      length_mm: checkedNum(c.length_mm, label + " length", errors), width_mm: checkedNum(c.width_mm, label + " width", errors),
      thickness_mm: checkedNum(c.thickness_mm, label + " thickness", errors), concrete_grade: get(c, "concrete_grade"),
      bar_diameter_mm: checkedNum(c.bar_diameter_mm, label + " bar diameter", errors), bar_label: get(c, "bar_label"),
      spacing_mm: checkedNum(c.spacing_mm, label + " spacing", errors), layers: toInt(checkedNum(c.layers, label + " layers", errors)),
      bar_directions: toInt(checkedNum(c.bar_directions, label + " directions", errors)), bar_count: toInt(checkedNum(c.bar_count, label + " bar count", errors)),
      length_per_bar_m: checkedNum(c.length_per_bar_m, label + " length per bar", errors),
      printed_total_length_m: checkedNum(c.printed_total_length_m, label + " total length", errors),
      unit: get(c, "unit"), applies_to: get(c, "applies_to"), notes: get(c, "notes"),
    });
  }

  return [{
    view_type: vt, title: get(data, "title"), scale_label: get(data, "scale_label"),
    level: get(data, "level"), rooms, openings, notes, components,
    overall_dimensions_mm: orEmpty(data.overall_dimensions_mm).filter(isObj),
    warnings: orEmpty(data.warnings).map(pyStr),
  }, errors];
}
