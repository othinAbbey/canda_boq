/**
 * Dependency-free .xlsx writer: just what the BOQ export needs.
 * Strings, numbers, live formulas, bold/size/fill/number-format/wrap styles,
 * column widths. An .xlsx is a zip of XML files, built here with node:zlib.
 *
 * Formulas are written only through formula(); a text value that happens to
 * start with "=" stays plain text (so model-written text cannot become a formula).
 */
import zlib from "node:zlib";

// ---------------------------------------------------------------- zip ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** files: [{name, data: Buffer}] -> zip Buffer (deflate). */
export function makeZip(files) {
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, "utf8");
    const comp = zlib.deflateRawSync(raw);
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(8, 8); lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(dosTime, 12);
    ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

// ---------------------------------------------------------------- xml ----
const esc = (s) => String(s)
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")        // illegal in XML 1.0
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function colLetter(n) {                       // 1 -> A, 27 -> AA
  let s = "";
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// ------------------------------------------------------------ workbook ---
export class Workbook {
  constructor() { this.sheets = []; this._styles = new Map(); this._styleList = [{}]; this._styles.set("{}", 0); }

  addSheet(title) {
    const s = new Sheet(this, title);
    this.sheets.push(s);
    return s;
  }

  /** Index of a style object (bold, size, fill, numFmt, wrap, vtop), registered on first use. */
  _styleId(style) {
    const key = JSON.stringify(Object.fromEntries(Object.entries(style).sort()));
    if (!this._styles.has(key)) { this._styles.set(key, this._styleList.length); this._styleList.push(JSON.parse(key)); }
    return this._styles.get(key);
  }

  _stylesXml() {
    const fonts = [{ b: false, sz: 11 }];
    const fills = [null, "gray125"];
    const fontIdx = (s) => {
      const f = { b: !!s.bold, sz: s.size || 11 };
      let i = fonts.findIndex((x) => x.b === f.b && x.sz === f.sz);
      if (i < 0) { fonts.push(f); i = fonts.length - 1; }
      return i;
    };
    const fillIdx = (rgb) => {
      if (!rgb) return 0;
      let i = fills.indexOf(rgb);
      if (i < 0) { fills.push(rgb); i = fills.length - 1; }
      return i;
    };
    const xfs = this._styleList.map((s) => {
      const font = fontIdx(s), fill = fillIdx(s.fill);
      const numFmt = s.numFmt === "#,##0.00" ? 4 : 0;
      const align = s.wrap || s.vtop
        ? `<alignment${s.wrap ? ' wrapText="1"' : ""}${s.vtop ? ' vertical="top"' : ""}/>` : "";
      return `<xf numFmtId="${numFmt}" fontId="${font}" fillId="${fill}" borderId="0" xfId="0"` +
        `${numFmt ? ' applyNumberFormat="1"' : ""}${font ? ' applyFont="1"' : ""}` +
        `${fill ? ' applyFill="1"' : ""}${align ? ' applyAlignment="1">' + align + "</xf>" : "/>"}`;
    });
    const fontXml = fonts.map((f) =>
      `<font>${f.b ? "<b/>" : ""}<sz val="${f.sz}"/><name val="Calibri"/><family val="2"/></font>`).join("");
    const fillXml = fills.map((f, i) => i === 0 ? '<fill><patternFill patternType="none"/></fill>'
      : f === "gray125" ? '<fill><patternFill patternType="gray125"/></fill>'
      : `<fill><patternFill patternType="solid"><fgColor rgb="FF${f}"/><bgColor indexed="64"/></patternFill></fill>`).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<fonts count="${fonts.length}">${fontXml}</fonts>` +
      `<fills count="${fills.length}">${fillXml}</fills>` +
      `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs>` +
      `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  }

  toBuffer() {
    const n = this.sheets.length;
    const files = [
      { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${this.sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
      { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
      { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${this.sheets.map((s, i) => `<sheet name="${esc(s.title)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>` },
      { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${this.sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    ];
    this.sheets.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: s._xml() }));
    files.push({ name: "xl/styles.xml", data: this._stylesXml() });   // after sheets: styles are registered while they render
    return makeZip(files);
  }
}

export class Sheet {
  constructor(wb, title) {
    this.wb = wb; this.title = title;
    this.cells = new Map();            // "row:col" -> {value, formula, style}
    this.widths = new Map();
    this.nextAppendRow = 1;
  }

  _cell(r, c) {
    const k = `${r}:${c}`;
    if (!this.cells.has(k)) this.cells.set(k, { r, c, value: null, formula: null, style: {} });
    return this.cells.get(k);
  }

  /** Set a literal value (string, number or null) and optionally style. */
  set(r, c, value, style) {
    const cell = this._cell(r, c);
    cell.value = value; cell.formula = null;
    if (style) Object.assign(cell.style, style);
    return this;
  }

  /** Set a live formula (without the leading "="). */
  formula(r, c, text, style) {
    const cell = this._cell(r, c);
    cell.formula = text.replace(/^=/, ""); cell.value = null;
    if (style) Object.assign(cell.style, style);
    return this;
  }

  /** Merge style properties into a cell (creating an empty cell if needed). */
  style(r, c, patch) { Object.assign(this._cell(r, c).style, patch); return this; }

  /** Append a row of plain values after the last appended row (like openpyxl's ws.append). */
  append(values, style) {
    const r = this.nextAppendRow++;
    values.forEach((v, i) => this.set(r, i + 1, v, style));
    return r;
  }

  width(col, w) { this.widths.set(col, w); return this; }

  _xml() {
    const byRow = new Map();
    for (const cell of this.cells.values()) {
      if (!byRow.has(cell.r)) byRow.set(cell.r, []);
      byRow.get(cell.r).push(cell);
    }
    const rows = [...byRow.keys()].sort((a, b) => a - b).map((r) => {
      const cells = byRow.get(r).sort((a, b) => a.c - b.c).map((cell) => {
        const ref = colLetter(cell.c) + cell.r;
        const s = Object.keys(cell.style).length ? ` s="${this.wb._styleId(cell.style)}"` : "";
        if (cell.formula !== null) return `<c r="${ref}"${s}><f>${esc(cell.formula)}</f></c>`;
        const v = cell.value;
        if (v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v))) return `<c r="${ref}"${s}/>`;
        if (typeof v === "number") return `<c r="${ref}"${s}><v>${v}</v></c>`;
        const text = String(v);
        return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
      });
      return `<row r="${r}">${cells.join("")}</row>`;
    });
    const cols = this.widths.size
      ? "<cols>" + [...this.widths.entries()].sort((a, b) => a[0] - b[0])
        .map(([c, w]) => `<col min="${c}" max="${c}" width="${w}" customWidth="1"/>`).join("") + "</cols>" : "";
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${rows.join("")}</sheetData></worksheet>`;
  }
}
