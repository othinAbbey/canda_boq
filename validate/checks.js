/**
 * Sanity checks on what the model extracted. The model's output is a proposal;
 * anything that does not add up becomes an Issue for a human to look at.
 *
 * Levels: "error" (the BOQ would be wrong), "warning" (look at it), "info".
 */
import { fmtG, toFixedPy } from "../util/pyfmt.js";

export class Issue {
  constructor(level, where, message) { this.level = level; this.where = where; this.message = message; }
  toString() { return `[${this.level.toUpperCase().padEnd(7)}] ${this.where}: ${this.message}`; }
}

const viewLabel = (v) => `p${v.page} v${v.view_id} ${v.title || ""}`.trim();

export function checkDocument(doc, areaTolerance = 0.05) {
  const issues = [];
  const schedule = new Map();           // mark -> count from the schedule
  const planTags = new Map();           // tags counted on floor plans
  let planViews = 0;

  for (const v of doc.views) {
    const where = viewLabel(v);
    const ex = v.extraction;

    if (v.error && !String(v.error).startsWith("skipped")) {
      issues.push(new Issue("error", where, `extraction failed: ${v.error}`));
    }
    if (!ex) continue;
    for (const e of v.parse_errors || []) issues.push(new Issue("warning", where, `unusable item dropped: ${e}`));
    for (const w of ex.warnings || []) issues.push(new Issue("info", where, `model warning: ${w}`));

    if (ex.view_type === "floor_plan") {
      planViews += 1;
      for (const [k, n] of Object.entries(v.tag_counts || {})) planTags.set(k, (planTags.get(k) || 0) + n);
      if (!ex.rooms.length) issues.push(new Issue("warning", where, "floor plan with no rooms"));
    }

    for (const r of ex.rooms) {
      const rw = `${where} / ${r.name}`;
      const L = r.length_mm, W = r.width_mm, A = r.area_m2;
      if (!A && !(L && W)) {
        issues.push(new Issue("warning", rw, "no size and no area: room cannot be quantified"));
      } else if (A && L && W) {
        const calc = L * W / 1e6;
        if (Math.abs(calc - A) / A > areaTolerance) {
          issues.push(new Issue("warning", rw,
            `printed area ${fmtG(A)} m2 differs from ${fmtG(L)} x ${fmtG(W)} mm = ${toFixedPy(calc, 2)} m2`));
        }
      }
      if (r.confidence === "low") issues.push(new Issue("info", rw, "model marked this room low confidence"));
    }

    for (const o of ex.openings) {
      if (o.count === null || o.count === undefined) continue;
      if (schedule.has(o.mark) && schedule.get(o.mark) !== o.count) {
        issues.push(new Issue("error", where,
          `${o.mark} appears twice in schedules with different counts (${schedule.get(o.mark)} and ${o.count})`));
      }
      if (!schedule.has(o.mark)) schedule.set(o.mark, o.count);
      if (!(o.width_mm && o.height_mm)) {
        issues.push(new Issue("warning", `${where} / ${o.mark}`,
          "opening without width/height: cannot deduct it from wall areas"));
      }
    }
  }

  // schedule counts against the tags printed on the plans
  const tagTotal = [...planTags.values()].reduce((s, n) => s + n, 0);
  if (schedule.size && planViews && tagTotal) {
    for (const [mark, count] of [...schedule.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
      const found = planTags.get(mark) || 0;
      if (found !== count) {
        issues.push(new Issue("warning", `opening ${mark}`,
          `schedule says ${count}, floor plans show ${found} tags (tags can be missing or repeated; check the drawings)`));
      }
    }
  } else if (schedule.size && !planViews) {
    issues.push(new Issue("warning", "document", "a schedule exists but no floor plan was recognised"));
  }

  if (!doc.views.some((v) => v.extraction)) issues.push(new Issue("error", "document", "nothing was extracted"));
  return issues;
}

export function summarize(issues) {
  const c = { error: 0, warning: 0, info: 0 };
  for (const i of issues) c[i.level] = (c[i.level] || 0) + 1;
  return `${c.error} errors, ${c.warning} warnings, ${c.info} info`;
}
