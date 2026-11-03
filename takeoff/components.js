/**
 * Quantities for detail / structural sheets: concrete members, reinforcement and counted items.
 * Plain arithmetic, no AI. The model only reports the dimensions PRINTED on the drawing; every volume,
 * length and weight is worked out here, and each line's `basis` shows the sum so a reviewer can check it.
 *
 *   concrete       length x width x thickness x count                          -> m3
 *   reinforcement  total bar length x unit weight (0.00617 x diameter^2 kg/m)  -> kg
 *   item           the count                                                    -> nr (or the unit on the drawing)
 *
 * Settings live in takeoff/assumptions.toml: [waste] concrete_pct, rebar_pct and [components] rebar_cover_mm, rebar_kg_per_m_per_mm2.
 */
import { Issue } from "../validate/checks.js";
import { fmtG, pyRound, toFixedPy } from "../util/pyfmt.js";

const DEFAULTS = { rebar_cover_mm: 25, rebar_kg_per_m_per_mm2: 0.00617, concrete_pct: 0, rebar_pct: 0 };
const pos = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
const slug = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "ITEM";

/** Settings with safe defaults when a project's assumptions file does not have the new sections yet. */
function settings(a) {
  const c = a?.components || {}, w = a?.waste || {};
  return {
    cover: pos(c.rebar_cover_mm) || c.rebar_cover_mm === 0 ? Number(c.rebar_cover_mm) : DEFAULTS.rebar_cover_mm,
    kgPerMm2: pos(c.rebar_kg_per_m_per_mm2) ? Number(c.rebar_kg_per_m_per_mm2) : DEFAULTS.rebar_kg_per_m_per_mm2,
    concreteWaste: Number.isFinite(w.concrete_pct) ? w.concrete_pct : DEFAULTS.concrete_pct,
    rebarWaste: Number.isFinite(w.rebar_pct) ? w.rebar_pct : DEFAULTS.rebar_pct,
  };
}

/** "Grade 25 (1:2:4)" -> "G25", "C25/30" -> "G25", "1:2:4" -> "MIX-1-2-4", nothing -> "GEN". */
export function gradeCode(text) {
  const t = String(text || "");
  const n = /(?:^|[^0-9])(1[0-9]|[2-6][0-9])(?!\d)/.exec(t);
  if (n) return `G${n[1]}`;
  const mix = /(\d+)\s*:\s*(\d+)\s*:\s*(\d+)/.exec(t);
  return mix ? `MIX-${mix[1]}-${mix[2]}-${mix[3]}` : "GEN";
}

/** Weight of a plain round or deformed bar in kg per metre: 0.00617 x d^2 (T8 = 0.395, Y12 = 0.888). */
export const kgPerMetre = (diameterMm, k = DEFAULTS.rebar_kg_per_m_per_mm2) => k * diameterMm * diameterMm;

function collect(doc) {
  const out = [];
  for (const v of doc.views || []) {
    const drawing = v.extraction?.title || v.title || v.name;
    for (const c of v.extraction?.components || []) out.push({ ...c, page: v.page, drawing });
  }
  return out;
}

function concrete(c, s, issues) {
  const where = `component ${c.name}`, n = c.count ?? 1;
  const missing = [["length", c.length_mm], ["width", c.width_mm], ["thickness", c.thickness_mm]].filter(([, v]) => !pos(v)).map(([k]) => k);
  if (missing.length) { issues.push(new Issue("warning", where, `concrete needs length, width and thickness; not given: ${missing.join(", ")}. Left out of the takeoff`)); return null; }
  const net = (c.length_mm * c.width_mm * c.thickness_mm) / 1e9 * n;
  const grade = c.concrete_grade ? String(c.concrete_grade).trim() : "";
  if (!grade) issues.push(new Issue("info", where, "no concrete grade printed; priced as general concrete (CONC-GEN)"));
  return {
    item_code: `CONC-${gradeCode(grade)}`, unit: "m3", quantity: pyRound(net * (1 + s.concreteWaste / 100), 3),
    description: `${c.name}${grade ? `, ${grade}` : ""} (${fmtG(c.length_mm)} x ${fmtG(c.width_mm)} x ${fmtG(c.thickness_mm)} mm${n > 1 ? `, ${n} nr` : ""})`,
    basis: `${fmtG(c.length_mm)} x ${fmtG(c.width_mm)} x ${fmtG(c.thickness_mm)} mm x ${n} = ${toFixedPy(net, 3)} m3 net + ${s.concreteWaste}% waste`,
  };
}

function reinforcement(c, s, all, issues) {
  const where = `component ${c.name}`;
  const d = pos(c.bar_diameter_mm) ? c.bar_diameter_mm : null;
  if (d === null) { issues.push(new Issue("warning", where, "reinforcement needs a bar diameter; left out of the takeoff")); return null; }
  const label = (c.bar_label && String(c.bar_label).trim()) || `T${fmtG(d)}`;
  const perM = kgPerMetre(d, s.kgPerMm2);

  let metres = null, how = "";
  const counted = pos(c.bar_count) && pos(c.length_per_bar_m) ? c.bar_count * c.length_per_bar_m : null;
  if (pos(c.printed_total_length_m)) {
    metres = c.printed_total_length_m; how = `printed bar schedule total ${toFixedPy(metres, 2)} m`;
    if (counted !== null && Math.abs(counted - metres) / metres > 0.02) {
      issues.push(new Issue("warning", where, `printed total length (${toFixedPy(metres, 2)} m) differs from ${c.bar_count} bars x ${toFixedPy(c.length_per_bar_m, 2)} m (${toFixedPy(counted, 2)} m); the printed total was used`));
    }
  } else if (counted !== null) {
    metres = counted; how = `${c.bar_count} bars x ${toFixedPy(c.length_per_bar_m, 2)} m = ${toFixedPy(metres, 2)} m`;
  } else if (pos(c.spacing_mm)) {
    // No schedule printed: estimate a mesh from the concrete member it sits in.
    const key = String(c.applies_to || "").toLowerCase();
    const hosts = all.filter((h) => h.kind === "concrete" && pos(h.length_mm) && pos(h.width_mm));
    const host = (key && hosts.find((h) => h.name.toLowerCase().includes(key) || key.includes(h.name.toLowerCase())))
      || (hosts.filter((h) => h.page === c.page).length === 1 ? hosts.find((h) => h.page === c.page) : null) || (hosts.length === 1 ? hosts[0] : null);
    if (!host) { issues.push(new Issue("warning", where, "no bar schedule and no single concrete member to measure the mesh from; left out of the takeoff")); return null; }
    const dirs = c.bar_directions === 1 ? 1 : 2, layers = c.layers || 1, cover = s.cover;
    if (c.bar_directions == null) issues.push(new Issue("info", where, "bar directions not stated; assumed a mesh in both directions"));
    const along = (host.length_mm - 2 * cover) / 1000, across = (host.width_mm - 2 * cover) / 1000;
    const nAcross = Math.floor(host.width_mm / c.spacing_mm) + 1, nAlong = Math.floor(host.length_mm / c.spacing_mm) + 1;
    metres = (nAcross * along + (dirs === 2 ? nAlong * across : 0)) * layers * (host.count ?? 1);
    how = `estimated from ${host.name}: ${nAcross} bars x ${toFixedPy(along, 2)} m` + (dirs === 2 ? ` + ${nAlong} bars x ${toFixedPy(across, 2)} m` : "") + ` per layer x ${layers} layer(s) (${fmtG(c.spacing_mm)} mm spacing, ${fmtG(cover)} mm cover) = ${toFixedPy(metres, 2)} m`;
    issues.push(new Issue("warning", where, "no bar schedule printed; the length is an estimate from spacing and cover. Check it against the drawing"));
  } else {
    issues.push(new Issue("warning", where, "no bar schedule or spacing printed; left out of the takeoff"));
    return null;
  }
  const kg = metres * perM * (1 + s.rebarWaste / 100);
  return {
    item_code: `REBAR-${slug(label)}`, unit: "kg", quantity: pyRound(kg, 2),
    description: `Reinforcement bar ${label} (${fmtG(d)} mm)${c.name ? `, ${c.name}` : ""}`,
    basis: `${how} x ${toFixedPy(perM, 3)} kg/m` + (s.rebarWaste ? ` + ${s.rebarWaste}% laps/waste` : "") + ` = ${toFixedPy(kg, 2)} kg`,
  };
}

function item(c, issues) {
  const n = pos(c.count) ? c.count : 1;
  if (!pos(c.count)) issues.push(new Issue("info", `component ${c.name}`, "no count printed; taken as 1"));
  const size = pos(c.length_mm) && pos(c.width_mm) ? `, ${fmtG(c.length_mm)} x ${fmtG(c.width_mm)}${pos(c.thickness_mm) ? ` x ${fmtG(c.thickness_mm)}` : ""} mm` : "";
  return { item_code: `ITEM-${slug(c.name)}`, unit: c.unit || "nr", quantity: n, description: `${c.name}${size}${c.notes ? `, ${c.notes}` : ""}`, basis: "count from the drawing" };
}

/** -> { lines: [{item_code, description, unit, quantity, basis}], issues }. Same lines add up when the same item appears twice. */
export function measureComponents(doc, assumptions) {
  const s = settings(assumptions), issues = [], all = collect(doc), merged = new Map();
  for (const c of all) {
    const line = c.kind === "concrete" ? concrete(c, s, issues) : c.kind === "reinforcement" ? reinforcement(c, s, all, issues) : c.kind === "item" ? item(c, issues) : null;
    if (!line) continue;
    const key = `${line.item_code}|${line.description}`, seen = merged.get(key);
    if (seen) { seen.quantity = pyRound(seen.quantity + line.quantity, 3); seen.basis += ` ; ${line.basis}`; } else merged.set(key, line);
  }
  return { lines: [...merged.values()], issues };
}
