/** Checks -> takeoff -> rates -> priced BOQ -> Excel. One function. */
import path from "node:path";

import { buildBoq } from "./builder.js";
import { exportBoq } from "./exportXlsx.js";
import { RateBook } from "../pricing/rateLookup.js";
import { loadAssumptions, takeoff } from "../takeoff/quantities.js";
import { checkDocument } from "../validate/checks.js";

export function runBoq(doc, settings, projectName, outDir) {
  const assumptions = loadAssumptions(settings.assumptionsPath);
  const issues = checkDocument(doc);
  const [lines, tissues] = takeoff(doc, assumptions);
  issues.push(...tissues);

  const boq = buildBoq(lines, RateBook.load(settings.ratesPath), assumptions, settings.currency);
  const xlsx = path.join(String(outDir), `${projectName}_BOQ.xlsx`);
  exportBoq(boq, issues, xlsx, projectName, doc);
  return { boq, issues, lines, xlsx };
}
