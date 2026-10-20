/** Rate book: exact item codes, plus prefix families written with a final *.
 * Never invents a rate: a missing or blank rate returns null. */
import fs from "node:fs";

import { readDictCsv } from "../util/csv.js";

export class ValueError extends Error {
  constructor(message) { super(message); this.name = "ValueError"; }
}

export class Rate {
  constructor(item_code, description, unit, rate, currency, region, date, source) {
    Object.assign(this, { item_code, description, unit, rate, currency, region, date, source });
  }
}

const NUMBER = /^[+-]?(?:\d+(?:_\d+)*(?:\.(?:\d+(?:_\d+)*)?)?|\.\d+(?:_\d+)*)(?:[eE][+-]?\d+(?:_\d+)*)?$/;

/** The number in a rate cell ("1,500" -> 1500), or null when blank. Throws when it is not a number. */
export function parseRate(cell) {
  const raw = (cell || "").replace(/,/g, "").trim();
  if (!raw) return null;
  if (!NUMBER.test(raw)) return NaN;
  return Number(raw.replace(/_/g, ""));
}

export class RateBook {
  constructor(rates) {
    this.exact = new Map(rates.filter((r) => !r.item_code.endsWith("*")).map((r) => [r.item_code, r]));
    this.families = rates.filter((r) => r.item_code.endsWith("*"))
      .map((r) => [r.item_code.slice(0, -1), r])
      .sort((p, q) => q[0].length - p[0].length);        // longest prefix first (stable)
  }

  static load(filePath) {
    const rates = [];
    for (const row of readDictCsv(fs.readFileSync(filePath, "utf8"))) {
      if (row.item_code === undefined) throw new ValueError("the rates file needs an item_code column");
      const value = parseRate(row.rate);
      if (value === null) continue;                      // blank = not priced
      if (Number.isNaN(value)) throw new ValueError(`bad rate '${row.rate}' for ${row.item_code}`);
      rates.push(new Rate(row.item_code.trim(), row.description ?? "", row.unit ?? "", value,
        row.currency ?? "", row.region ?? "", row.date ?? "", row.source ?? ""));
    }
    return new RateBook(rates);
  }

  get(itemCode) {
    if (this.exact.has(itemCode)) return this.exact.get(itemCode);
    for (const [prefix, rate] of this.families) if (itemCode.startsWith(prefix)) return rate;
    return null;
  }
}
