/**
 * Quantities from the extracted data. Plain arithmetic, no AI.
 *
 * Version 1 covers FINISHES and OPENINGS only:
 *   floor finish, skirting, ceiling paint, internal plaster and paint,
 *   doors and windows by mark.
 * Structure (foundations, slabs, walling, roof) needs wall lengths and levels
 * and is not measured here yet.
 *
 * Approximations are listed in each line's `basis` so a reviewer can see them.
 */
import fs from "node:fs";

import { Issue } from "../validate/checks.js";
import { fmtG, fmtPct0, pyRound, pySum, toFixedPy } from "../util/pyfmt.js";
import { parseToml } from "../util/toml.js";

export class QtyLine {
  constructor(item_code, description, unit, quantity, basis = "") {
    Object.assign(this, { item_code, description, unit, quantity, basis });
  }
}

export function loadAssumptions(filePath) {
  return parseToml(fs.readFileSync(filePath, "utf8"));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function hasWord(text, words) {
  const t = (text || "").toLowerCase();
  return words.some((w) => new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(w.toLowerCase())}(?![\\p{L}\\p{N}_])`, "u").test(t));
}

/** Voids, stairs and shafts: no finishes are measured for them. */
export function isExcluded(name, a) {
  return hasWord(name, (a.exclude_rooms || {}).keywords || []);
}

/** Clear wall height in metres for a level name (fallback: [geometry]). */
export function wallHeightM(level, a) {
  for (const rule of a.level_heights || []) {
    if (hasWord(level, rule.keywords) || rule.keywords.some((k) => (level || "").toLowerCase().includes(k.toLowerCase()))) {
      return rule.height_mm / 1000.0;
    }
  }
  return a.geometry.wall_height_mm / 1000.0;
}

function floorItem(name, a) {
  const low = (name || "").toLowerCase();
  for (const rule of a.floor_rules || []) {
    if (rule.keywords.some((k) => low.includes(k))) return rule.item;
  }
  return a.floor_default.item;
}

export function collectRooms(doc) {
  const rooms = [];
  for (const v of doc.views) {
    const ex = v.extraction;
    if (!ex || ex.view_type !== "floor_plan") continue;
    for (const r of ex.rooms) {
      const L = r.length_mm, W = r.width_mm, A = r.area_m2;
      const area = A ? A : (L && W ? L * W / 1e6 : null);
      rooms.push({
        name: r.name, level: ex.level || v.title, area,
        perimeter: L && W ? 2 * (L + W) / 1000.0 : null,
      });
    }
  }
  return rooms;
}

export function collectOpenings(doc) {
  const found = new Map();
  for (const v of doc.views) {
    const ex = v.extraction;
    if (!ex) continue;
    for (const o of ex.openings) {
      if (o.count !== null && o.count !== undefined && !found.has(o.mark)) found.set(o.mark, o);
    }
  }
  return found;
}

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Returns [lines, issues]. */
export function takeoff(doc, assumptions) {
  const a = assumptions;
  const issues = [], lines = [];
  const minDeduct = a.geometry.opening_deduct_min_m2;
  const floorWaste = 1 + a.waste.floor_finish_pct / 100.0;
  const paintWaste = 1 + a.waste.paint_pct / 100.0;

  const allRooms = collectRooms(doc);
  const excluded = allRooms.filter((r) => isExcluded(r.name, a));
  const rooms = allRooms.filter((r) => !isExcluded(r.name, a));
  const openings = collectOpenings(doc);
  if (excluded.length) {
    issues.push(new Issue("info", "rooms", "no finishes measured for voids/stairs: "
      + [...new Set(excluded.map((r) => r.name))].sort(cmpStr).join(", ")));
  }

  // ---- floors, ceilings -------------------------------------------
  const floor = new Map(), names = new Map();
  let ceiling = 0.0;
  for (const r of rooms) {
    if (r.area === null) {
      issues.push(new Issue("warning", `room ${r.name}`, "no size, left out of the takeoff"));
      continue;
    }
    const item = floorItem(r.name, a);
    floor.set(item, (floor.get(item) || 0.0) + r.area);
    if (!names.has(item)) names.set(item, []);
    names.get(item).push(r.name);
    ceiling += r.area;
  }

  for (const [item, area] of [...floor.entries()].sort((p, q) => cmpStr(p[0], q[0]))) {
    lines.push(new QtyLine(
      item, "Floor finish: " + item.split("FIN-FLOOR-").join("").split("-").join(" ").toLowerCase(),
      "m2", pyRound(area * floorWaste, 2),
      `${toFixedPy(area, 2)} m2 net + ${a.waste.floor_finish_pct}% waste; rooms: ${names.get(item).join(", ")}`));
  }

  if (ceiling) {
    lines.push(new QtyLine("FIN-CEIL-PAINT", "Paint to ceilings", "m2", pyRound(ceiling * paintWaste, 2),
      `${toFixedPy(ceiling, 2)} m2 room area + waste`));
  }

  // ---- skirting, plaster, wall paint ---------------------------------
  const withPerim = rooms.filter((r) => r.perimeter);
  const skipped = rooms.filter((r) => r.area && !r.perimeter).map((r) => r.name);
  if (skipped.length) {
    issues.push(new Issue("info", "walls", "no length/width for: " + skipped.join(", ") + "; their walls are not measured"));
  }

  const perim = pySum(withPerim.map((r) => r.perimeter));
  const gross = pySum(withPerim.map((r) => r.perimeter * wallHeightM(r.level, a)));
  const hmap = new Map();
  for (const r of withPerim) {
    const lv = r.level || "?", h = wallHeightM(r.level, a);
    hmap.set(JSON.stringify([lv, h]), [lv, h]);
  }
  const heights = [...hmap.values()].sort((p, q) => cmpStr(p[0], q[0]) || p[1] - q[1]);
  let deduct = 0.0;
  for (const o of openings.values()) {
    if (o.width_mm && o.height_mm) {
      const m2 = o.width_mm * o.height_mm / 1e6;
      if (m2 >= minDeduct) deduct += m2 * o.count;
    }
  }

  if (perim) {
    lines.push(new QtyLine("FIN-SKIRTING", "Skirting", "m", pyRound(perim, 2),
      "sum of room perimeters (door openings not deducted)"));
    const net = Math.max(gross - deduct, 0.0);
    if (deduct > 0.4 * gross) {
      const share = gross > 0 ? fmtPct0(deduct / gross) : "100%";
      issues.push(new Issue("warning", "walls",
        `openings to deduct (${toFixedPy(deduct, 1)} m2) are ${share} of the measured wall area ` +
        `(${toFixedPy(gross, 1)} m2): the schedule probably covers rooms that were not measured, ` +
        "so plaster and paint are understated"));
    }
    const hs = heights.map(([lv, h]) => `${lv}: ${toFixedPy(h, 2)} m`).join("; ");
    lines.push(new QtyLine("FIN-PLASTER-INT", "Internal wall plaster", "m2", pyRound(net, 2),
      `room perimeters x wall height per level (${hs}) = ${toFixedPy(gross, 2)} m2, minus ` +
      `openings ${toFixedPy(deduct, 2)} m2. Approximate: a partition is counted ` +
      "from both rooms, but its openings are deducted once"));
    lines.push(new QtyLine("FIN-PAINT-INT", "Paint to internal walls", "m2", pyRound(net * paintWaste, 2),
      `${toFixedPy(net, 2)} m2 plaster area + ${a.waste.paint_pct}% waste`));
  }

  // ---- doors and windows ---------------------------------------------
  for (const [mark, o] of [...openings.entries()].sort((p, q) => cmpStr(p[0], q[0]))) {
    const size = o.width_mm && o.height_mm ? `${fmtG(o.width_mm)} x ${fmtG(o.height_mm)} mm` : "size not given";
    const kind = o.kind.charAt(0).toUpperCase() + o.kind.slice(1).toLowerCase();
    lines.push(new QtyLine(
      `OPN-${o.kind.toUpperCase()}-${mark}`,
      `${kind} ${mark}, ${size}` + (o.description ? `, ${o.description}` : ""),
      "nr", Number(o.count), "count from the schedule"));
  }

  if (!rooms.length) issues.push(new Issue("error", "takeoff", "no rooms from any floor plan"));
  return [lines, issues];
}
