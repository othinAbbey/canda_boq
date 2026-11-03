/**
 * What Claude must return for a whole drawing set: every drawing (view) on
 * every page, with its rooms, schedule rows and notes. It is the earlier
 * per-view schema, wrapped with a page number so one call covers the PDF.
 *
 * No quantities and no prices are asked from the model: those are computed by
 * code (takeoff/, pricing/) so every number can be traced.
 */
import { VIEW_SCHEMA, parseView } from "./schemas.js";

export const DOCUMENT_SCHEMA = {
  type: "object",
  properties: {
    project_name: { type: ["string", "null"], description: "Project name from the title block, if any." },
    views: {
      type: "array",
      description: "Every drawing in the PDF, in page order. One entry per drawing, not per page.",
      items: {
        type: "object",
        properties: {
          page: { type: "integer", description: "1-based page number in the PDF." },
          ...VIEW_SCHEMA.properties,
          opening_tags_on_plan: {
            type: "array",
            description: "Floor plans only: how many times each door/window tag (D1, W3 ...) is printed on this plan. Omit if unsure.",
            items: {
              type: "object",
              properties: { mark: { type: "string" }, count: { type: "integer" } },
              required: ["mark", "count"],
            },
          },
        },
        required: ["page", "view_type", "rooms", "openings", "notes", "warnings"],
      },
    },
    document_warnings: {
      type: "array", items: { type: "string" },
      description: "Problems that affect the whole document: unreadable pages, missing sheets, mixed scales.",
    },
  },
  required: ["views", "document_warnings"],
};

const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

/** "1:100" / "1 : 100" -> 100, else null. */
function scaleNumber(label) {
  const m = /1\s*:\s*(\d+)/.exec(String(label ?? ""));
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Raw tool result -> the document shape used by checks/takeoff:
 *   {source, views: [{name, page, view_id, title, kind, label_scale, tag_counts,
 *                     extraction, parse_errors, error}], document_warnings}
 * Returns {doc, problems}; problems are things the model returned that could not be used.
 */
export function buildDoc(raw, source = "") {
  const problems = [];
  if (!isObj(raw) || !Array.isArray(raw.views)) {
    return { doc: { source, project_name: null, views: [], document_warnings: [] }, problems: ["the result had no 'views' list"] };
  }
  const perPage = new Map();
  const views = [];
  raw.views.forEach((v, i) => {
    if (!isObj(v)) { problems.push(`view ${i + 1} is not an object`); return; }
    const page = Number.isInteger(v.page) && v.page >= 1 ? v.page : null;
    if (page === null) problems.push(`view ${i + 1}: missing or invalid page, using page 1`);
    const p = page ?? 1;
    const viewId = (perPage.get(p) || 0) + 1;
    perPage.set(p, viewId);

    const [extraction, errors] = parseView(v);
    const tags = {};
    for (const t of Array.isArray(v.opening_tags_on_plan) ? v.opening_tags_on_plan : []) {
      if (isObj(t) && typeof t.mark === "string" && Number.isInteger(t.count) && t.count >= 0) {
        const mark = t.mark.trim().toUpperCase();
        tags[mark] = (tags[mark] || 0) + t.count;
      }
    }
    views.push({
      name: `p${p}_v${viewId}`, page: p, view_id: viewId,
      title: extraction.title, kind: extraction.view_type,
      label_scale: scaleNumber(extraction.scale_label),
      tag_counts: tags, extraction, parse_errors: errors, error: null,
    });
  });
  return {
    doc: {
      source, project_name: typeof raw.project_name === "string" ? raw.project_name : null, views,
      document_warnings: (Array.isArray(raw.document_warnings) ? raw.document_warnings : []).map(String),
    },
    problems,
  };
}
