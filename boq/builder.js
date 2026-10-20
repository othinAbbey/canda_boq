/** Combine quantity lines with rates into a priced bill of quantities. */
import { pyRound, pySum } from "../util/pyfmt.js";

export class BoqLine {
  constructor({ item, code, description, unit, quantity, rate, basis = "", rate_source = "" }) {
    Object.assign(this, { item, code, description, unit, quantity, rate, basis, rate_source });
  }
  get amount() { return this.rate === null ? null : pyRound(this.quantity * this.rate, 2); }
}

export class Section {
  constructor(key, title) { this.key = key; this.title = title; this.lines = []; }
  get total() { return pyRound(pySum(this.lines.filter((l) => l.amount !== null).map((l) => l.amount)), 2); }
}

export class Boq {
  constructor(sections, commercial, currency) {
    this.sections = sections; this.commercial = commercial; this.currency = currency;
  }
  get unpriced() { return this.sections.flatMap((s) => s.lines.filter((l) => l.rate === null)); }
  get subtotal() { return pyRound(pySum(this.sections.map((s) => s.total)), 2); }

  totals() {
    const c = this.commercial;
    const sub = this.subtotal;
    const prelim = pyRound(sub * c.preliminaries_pct / 100, 2);
    const cont = pyRound((sub + prelim) * c.contingency_pct / 100, 2);
    const tax = pyRound((sub + prelim + cont) * c.tax_pct / 100, 2);
    return { subtotal: sub, preliminaries: prelim, contingency: cont, tax, total: pyRound(sub + prelim + cont + tax, 2) };
  }
}

export function buildBoq(qtyLines, ratebook, assumptions, currency = "UGX") {
  const sectionNames = assumptions.sections || {};
  const sections = new Map();
  const order = Object.keys(sectionNames);               // keep the order of the TOML

  for (const q of qtyLines) {
    const key = q.item_code.split("-")[0];
    if (!sections.has(key)) sections.set(key, new Section(key, key in sectionNames ? sectionNames[key] : key));
    const rate = ratebook.get(q.item_code);
    sections.get(key).lines.push(new BoqLine({
      item: "", code: q.item_code, description: q.description, unit: q.unit,
      quantity: q.quantity, rate: rate ? rate.rate : null, basis: q.basis,
      rate_source: rate ? `${rate.source} ${rate.date}`.trim() : "",
    }));
  }

  const ordered = order.filter((k) => sections.has(k)).map((k) => sections.get(k));
  for (const [k, s] of sections) if (!order.includes(k)) ordered.push(s);

  ordered.forEach((sec, n) => {
    const letter = String.fromCharCode(65 + n);
    sec.lines.forEach((line, i) => { line.item = `${letter}.${i + 1}`; });
  });
  return new Boq(ordered, assumptions.commercial, currency);
}
