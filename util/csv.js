/** Minimal CSV reader/writer matching Python's csv.DictReader / DictWriter defaults. */

/** Parse CSV text into an array of rows (arrays of strings). Handles quotes, "" escapes and CR/LF. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false, i = 0, sawAny = false;
  while (i < text.length) {
    const ch = text[i];
    sawAny = true;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ",") { row.push(field); field = ""; i++; continue; }
    if (ch === "\r" || ch === "\n") {
      row.push(field); field = "";
      rows.push(row); row = [];
      if (ch === "\r" && text[i + 1] === "\n") i++;
      i++; sawAny = false; continue;
    }
    field += ch; i++;
  }
  if (sawAny || field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Like Python's "skip blank lines and # comments, then csv.DictReader".
 * Returns an array of {column: value} objects. Missing cells are undefined.
 */
export function readDictCsv(text) {
  text = text.replace(/^\uFEFF/, "");                         // utf-8-sig
  const kept = text.split(/(?<=\n)|(?<=\r(?!\n))/)             // keep line endings
    .filter((ln) => ln.trim() && !ln.trimStart().startsWith("#"));
  const rows = parseCsv(kept.join(""));
  const nonEmpty = rows.filter((r) => !(r.length === 1 && r[0] === ""));
  if (!nonEmpty.length) return [];
  const header = nonEmpty[0];
  return nonEmpty.slice(1).map((r) => {
    const o = {};
    header.forEach((h, k) => { if (k < r.length) o[h] = r[k]; });
    return o;
  });
}

function quote(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** CSV text with a header row, \r\n line endings (Python's csv default). */
export function writeDictCsv(fields, rows) {
  const lines = [fields.map(quote).join(",")];
  for (const r of rows) lines.push(fields.map((f) => quote(r[f])).join(","));
  return lines.join("\r\n") + "\r\n";
}
