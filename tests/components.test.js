import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { buildDoc } from "../claude/documentSchema.js";
import { parseView } from "../claude/schemas.js";
import { PROMPT_VERSION, SYSTEM } from "../claude/prompts.js";
import { runBoq } from "../boq/pipeline.js";
import { gradeCode, kgPerMetre, measureComponents } from "../takeoff/components.js";
import { loadAssumptions, takeoff } from "../takeoff/quantities.js";

const A = loadAssumptions(path.join(import.meta.dirname, "..", "takeoff", "assumptions.toml"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "boq-comp-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// What the model returns for the latrine slab sheet: dimensions as printed, no quantities.
const SLAB = { kind: "concrete", name: "Latrine slab", count: 1, length_mm: 1000, width_mm: 1000, thickness_mm: 100, concrete_grade: "Grade 25 (1:2:4)" };
const T8 = { kind: "reinforcement", name: "T8 mesh, top layer", bar_label: "T8", bar_diameter_mm: 8, spacing_mm: 200, layers: 1, bar_directions: 2, bar_count: 12, length_per_bar_m: 1.0, printed_total_length_m: 12.0, applies_to: "Latrine slab" };
const PAN = { kind: "item", name: "Sato pan", count: 1, length_mm: 450, width_mm: 300, thickness_mm: 120 };
const docOf = (...components) => buildDoc({ project_name: "Household Latrine Support", views: [{ page: 1, view_type: "detail", title: "Latrine slab", rooms: [], openings: [], notes: [], warnings: [], components }], document_warnings: [] }).doc;
const find = (lines, code) => lines.find((l) => l.item_code === code);

describe("quantities from components", () => {
  it("latrine slab: concrete in m3, steel in kg, pan as a count", () => {
    const { lines, issues } = measureComponents(docOf(SLAB, T8, PAN), A);
    const c = find(lines, "CONC-G25"), r = find(lines, "REBAR-T8"), p = find(lines, "ITEM-SATO-PAN");
    assert.deepEqual([c.unit, c.quantity], ["m3", 0.1]);
    assert.match(c.description, /Latrine slab, Grade 25/); assert.match(c.basis, /1000 x 1000 x 100 mm x 1 = 0\.100 m3/);
    assert.deepEqual([r.unit, r.quantity], ["kg", 4.74]);                                   // 12 m x 0.395 kg/m
    assert.match(r.basis, /printed bar schedule total 12\.00 m x 0\.395 kg\/m/);
    assert.deepEqual([p.unit, p.quantity], ["nr", 1]); assert.match(p.description, /Sato pan, 450 x 300 x 120 mm/);
    assert.equal(issues.filter((i) => i.level !== "info").length, 0);
  });

  it("concrete: count, waste and unit weights", () => {
    const withWaste = { ...A, waste: { ...A.waste, concrete_pct: 5, rebar_pct: 10 } };
    const { lines } = measureComponents(docOf({ ...SLAB, count: 3 }, T8), withWaste);
    assert.equal(find(lines, "CONC-G25").quantity, 0.315);                                    // 0.3 m3 + 5%
    assert.equal(find(lines, "REBAR-T8").quantity, 5.21);                                     // 4.7386 kg + 10%
    assert.ok(Math.abs(kgPerMetre(12) - 0.888) < 0.001); assert.ok(Math.abs(kgPerMetre(8) - 0.395) < 0.001);
  });

  it("grades become rate codes", () => {
    assert.deepEqual(["Grade 25 (1:2:4)", "C25/30", "M20", "1:2:4", "", null, "Grade 7.5"].map(gradeCode), ["G25", "G25", "G20", "MIX-1-2-4", "GEN", "GEN", "GEN"]);
  });

  it("missing dimensions are reported, not guessed", () => {
    const { lines, issues } = measureComponents(docOf({ ...SLAB, thickness_mm: null }, { ...T8, bar_diameter_mm: null }), A);
    assert.equal(lines.length, 0);
    assert.ok(issues.some((i) => i.level === "warning" && /not given: thickness/.test(i.message)));
    assert.ok(issues.some((i) => i.level === "warning" && /needs a bar diameter/.test(i.message)));
  });

  it("reinforcement without a schedule is estimated from spacing and flagged", () => {
    const { lines, issues } = measureComponents(docOf(SLAB, { ...T8, bar_count: null, length_per_bar_m: null, printed_total_length_m: null }), A);
    const r = find(lines, "REBAR-T8");
    assert.equal(r.quantity, 4.5);                                                              // (6 x 0.95 + 6 x 0.95) m x 0.395
    assert.match(r.basis, /estimated from Latrine slab: 6 bars x 0\.95 m \+ 6 bars x 0\.95 m/);
    assert.ok(issues.some((i) => i.level === "warning" && /estimate from spacing and cover/.test(i.message)));
    const none = measureComponents(docOf({ ...T8, bar_count: null, length_per_bar_m: null, printed_total_length_m: null }), A);   // no slab to measure from
    assert.equal(none.lines.length, 0); assert.ok(none.issues.some((i) => /no single concrete member/.test(i.message)));
  });

  it("warns when the printed total disagrees with bars x length, and uses the printed total", () => {
    const { lines, issues } = measureComponents(docOf(SLAB, { ...T8, bar_count: 6 }), A);
    assert.equal(find(lines, "REBAR-T8").quantity, 4.74);
    assert.ok(issues.some((i) => i.level === "warning" && /differs from 6 bars/.test(i.message)));
    assert.equal(find(measureComponents(docOf(SLAB, { ...T8, printed_total_length_m: null, bar_count: 10, length_per_bar_m: 0.9 }), A).lines, "REBAR-T8").quantity, 3.55);   // count x length when nothing is printed
  });

  it("the same item on two sheets adds up; unknown kinds are dropped with a note", () => {
    const { lines } = measureComponents(docOf(PAN, PAN, { ...PAN, name: "Pipe cover" }), A);
    assert.equal(find(lines, "ITEM-SATO-PAN").quantity, 2); assert.equal(find(lines, "ITEM-PIPE-COVER").quantity, 1);
    const [view, errors] = parseView({ view_type: "detail", components: [{ kind: "wizard", name: "x" }, { kind: "item" }, { kind: "item", name: "ok", count: "3", length_mm: "abc" }] });
    assert.equal(view.components.length, 1); assert.equal(view.components[0].count, 3); assert.equal(view.components[0].length_mm, null);
    assert.equal(errors.length, 3);
  });
});

describe("the BOQ for a detail sheet", () => {
  const rates = path.join(tmp, "rates.csv");
  fs.writeFileSync(rates, "item_code,description,unit,rate,currency,region,date,source\nCONC-G25,Concrete grade 25,m3,450000,UGX,,2026-05-01,quote\nREBAR-*,Reinforcement,kg,5000,UGX,,2026-05-01,quote\nITEM-SATO-PAN,Sato pan,nr,30000,UGX,,2026-05-01,quote\n");
  const settings = { assumptionsPath: path.join(import.meta.dirname, "..", "takeoff", "assumptions.toml"), ratesPath: rates, currency: "UGX" };

  it("prices every component and builds sections in a sensible order", () => {
    const out = runBoq(docOf(SLAB, T8, PAN), settings, "LS-001", tmp);
    assert.deepEqual(out.boq.sections.map((s) => s.title), ["Concrete works", "Reinforcement", "Fittings and items"]);
    assert.deepEqual(out.boq.sections.map((s) => s.lines[0].item), ["A.1", "B.1", "C.1"]);
    assert.deepEqual(out.boq.sections.map((s) => s.lines[0].amount), [45000, 23700, 30000]);   // 0.1 m3, 4.74 kg, 1 nr
    assert.equal(out.boq.subtotal, 98700); assert.equal(out.boq.unpriced.length, 0);
    assert.equal(out.issues.some((i) => i.level === "error"), false);
    assert.ok(out.issues.some((i) => i.level === "info" && /no floor plans in this PDF/.test(i.message)));
    assert.ok(fs.statSync(out.xlsx).size > 1000);
  });

  it("with no rooms and no components it still says so", () => {
    const out = runBoq(docOf(), settings, "empty", tmp);
    assert.ok(out.issues.some((i) => i.level === "error" && /no components/.test(i.message)));
  });

  it("floor plans still work exactly as before, with components alongside", () => {
    const doc = buildDoc({ views: [{ page: 1, view_type: "floor_plan", rooms: [{ name: "Bedroom", length_mm: 4000, width_mm: 3000, confidence: "high" }], openings: [], notes: [], warnings: [], components: [SLAB] }], document_warnings: [] }).doc;
    const [lines, issues] = takeoff(doc, A);
    assert.ok(lines.some((l) => l.item_code.startsWith("FIN-FLOOR"))); assert.ok(lines.some((l) => l.item_code === "CONC-G25"));
    assert.equal(issues.some((i) => i.level === "error"), false);
  });
});

describe("the AI is asked for dimensions, never quantities", () => {
  it("prompt version changed (so old cached readings are not reused) and the old conflicting rule is gone", () => {
    assert.equal(PROMPT_VERSION, "d2");
    assert.match(SYSTEM, /report "components"/); assert.match(SYSTEM, /Do NOT calculate volumes, lengths or weights/);
    assert.doesNotMatch(SYSTEM, /Calculate quantities of areas/);
  });
});
