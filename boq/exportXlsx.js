/**
 * Excel export. Amounts and totals are live formulas, so editing a rate or a
 * percentage in the sheet recalculates everything.
 */
import fs from "node:fs";

import { Workbook } from "../util/xlsx.js";

const BOLD = { bold: true };
const HEAD = { bold: true, fill: "DDE6F0" };
const SECT = { fill: "F2F2F2" };
const INPUT = { fill: "FFF2CC" };                       // cells you are meant to edit

export function exportBoq(boq, issues, filePath, project = "", doc = null) {
  const wb = new Workbook();
  const ws = wb.addSheet("BOQ");
  const cur = boq.currency;

  ws.set(1, 1, `BILL OF QUANTITIES  ${project}`.trim(), { bold: true, size: 14 });
  ws.set(2, 1, `Currency: ${cur}. Yellow cells are inputs. Blank rate = not priced (see the Unpriced sheet).`);

  ["Item", "Description", "Unit", "Qty", `Rate (${cur})`, `Amount (${cur})`, "Basis / note"]
    .forEach((h, i) => ws.set(4, i + 1, h, HEAD));

  let row = 5;
  const sectionTotals = [];
  for (const sec of boq.sections) {
    ws.set(row, 2, sec.title.toUpperCase(), BOLD);
    for (let c = 1; c <= 7; c++) ws.style(row, c, SECT);
    row += 1;
    const first = row;
    for (const line of sec.lines) {
      ws.set(row, 1, line.item);
      ws.set(row, 2, line.description);
      ws.set(row, 3, line.unit);
      ws.set(row, 4, line.quantity);
      ws.set(row, 5, line.rate, INPUT);
      ws.formula(row, 6, `IF(E${row}="","",D${row}*E${row})`);
      ws.set(row, 7, line.basis, { wrap: true, vtop: true });
      row += 1;
    }
    const last = row - 1;
    ws.set(row, 2, `Total: ${sec.title}`, BOLD);
    if (last >= first) ws.formula(row, 6, `SUM(F${first}:F${last})`, BOLD); else ws.set(row, 6, 0, BOLD);
    sectionTotals.push(`F${row}`);
    row += 2;
  }

  // summary block with editable percentages
  ws.set(row, 2, "Subtotal", BOLD);
  const sub = row;
  if (sectionTotals.length) ws.formula(sub, 6, sectionTotals.join("+")); else ws.set(sub, 6, 0);
  row += 1;
  const c = boq.commercial;
  const items = [["Preliminaries", c.preliminaries_pct], ["Contingency", c.contingency_pct], ["Tax", c.tax_pct]];
  const prelimRow = row;
  items.forEach(([label, pct], i) => {
    ws.set(row + i, 2, `${label} (%)`);
    ws.set(row + i, 5, pct, INPUT);
  });
  ws.formula(prelimRow, 6, `F${sub}*E${prelimRow}/100`);
  ws.formula(prelimRow + 1, 6, `(F${sub}+F${prelimRow})*E${prelimRow + 1}/100`);
  ws.formula(prelimRow + 2, 6, `(F${sub}+F${prelimRow}+F${prelimRow + 1})*E${prelimRow + 2}/100`);
  const gt = prelimRow + 3;
  ws.set(gt, 2, "TOTAL", BOLD);
  ws.formula(gt, 6, `SUM(F${sub}:F${prelimRow + 2})`, BOLD);

  [8, 52, 7, 12, 14, 16, 70].forEach((w, i) => ws.width(i + 1, w));
  for (let r = 5; r <= gt; r++) for (const col of [4, 5, 6]) ws.style(r, col, { numFmt: "#,##0.00" });

  // ---- unpriced -------------------------------------------------------
  const up = wb.addSheet("Unpriced");
  up.append(["Item", "Code", "Description", "Unit", "Qty"], BOLD);
  for (const l of boq.unpriced) up.append([l.item, l.code, l.description, l.unit, l.quantity]);
  [8, 24, 60, 7, 12].forEach((w, i) => up.width(i + 1, w));

  // ---- issues ---------------------------------------------------------
  const iss = wb.addSheet("Issues");
  iss.append(["Level", "Where", "Message"], BOLD);
  for (const i of issues) iss.append([i.level, i.where, i.message]);
  [10, 40, 100].forEach((w, i) => iss.width(i + 1, w));

  if (doc) addExtractedSheets(wb, doc);

  fs.writeFileSync(filePath, wb.toBuffer());
  return filePath;
}

/** What the model read from the PDF, one row per room / opening / note, so a
 * reviewer can compare it with the drawings. */
function addExtractedSheets(wb, doc) {
  const rooms = wb.addSheet("Rooms read");
  rooms.append(["Page", "Drawing", "Level", "Room", "Length mm", "Width mm", "Area m2", "Floor finish", "Wall finish", "Confidence", "Notes"], BOLD);
  const openings = wb.addSheet("Openings read");
  openings.append(["Page", "Drawing", "Mark", "Kind", "Width mm", "Height mm", "Count", "Description"], BOLD);
  const notes = wb.addSheet("Notes read");
  notes.append(["Page", "Drawing", "Topic", "Note"], BOLD);

  for (const v of doc.views) {
    const ex = v.extraction;
    if (!ex) continue;
    const drawing = ex.title || v.title || v.name;
    for (const r of ex.rooms) {
      rooms.append([v.page, drawing, ex.level, r.name, r.length_mm, r.width_mm, r.area_m2,
        r.floor_finish, r.wall_finish, r.confidence, r.notes]);
    }
    for (const o of ex.openings) {
      openings.append([v.page, drawing, o.mark, o.kind, o.width_mm, o.height_mm, o.count, o.description]);
    }
    for (const n of ex.notes) notes.append([v.page, drawing, n.topic, n.text]);
  }
  [6, 28, 16, 24, 12, 12, 10, 22, 22, 11, 40].forEach((w, i) => rooms.width(i + 1, w));
  [6, 28, 10, 9, 11, 11, 8, 40].forEach((w, i) => openings.width(i + 1, w));
  [6, 28, 22, 110].forEach((w, i) => notes.width(i + 1, w));
}
