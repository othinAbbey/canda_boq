/**
 * A small TOML reader for the subset used by takeoff/assumptions.toml:
 * comments, [tables], [[arrays of tables]], dotted table names, bare or
 * quoted keys, strings, numbers, booleans, arrays (multi-line, trailing
 * commas, comments inside) and inline tables.
 * It throws a clear error on anything else instead of guessing.
 */
export class TomlError extends Error {}

export function parseToml(text) {
  const src = text.replace(/^\uFEFF/, "");
  let pos = 0;
  const root = {};
  let target = root;

  const fail = (msg) => {
    const line = src.slice(0, pos).split("\n").length;
    throw new TomlError(`TOML error on line ${line}: ${msg}`);
  };
  const peek = () => src[pos];
  const skipSpaces = () => { while (pos < src.length && (src[pos] === " " || src[pos] === "\t")) pos++; };
  const skipComment = () => { if (src[pos] === "#") while (pos < src.length && src[pos] !== "\n") pos++; };
  const skipWsAndComments = () => {            // inside arrays: newlines are allowed
    for (;;) {
      while (pos < src.length && /\s/.test(src[pos])) pos++;
      if (src[pos] === "#") skipComment(); else break;
    }
  };

  function parseKey() {
    skipSpaces();
    const parts = [];
    for (;;) {
      skipSpaces();
      if (src[pos] === '"') parts.push(parseBasicString());
      else if (src[pos] === "'") parts.push(parseLiteralString());
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(src.slice(pos));
        if (!m) fail("expected a key");
        parts.push(m[0]); pos += m[0].length;
      }
      skipSpaces();
      if (src[pos] === ".") { pos++; continue; }
      break;
    }
    return parts;
  }

  function parseBasicString() {
    pos++;                                       // opening quote
    let out = "";
    while (pos < src.length && src[pos] !== '"') {
      if (src[pos] === "\n") fail("unterminated string");
      if (src[pos] === "\\") {
        pos++;
        const c = src[pos];
        const simple = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\" };
        if (c in simple) { out += simple[c]; pos++; }
        else if (c === "u" || c === "U") {
          const n = c === "u" ? 4 : 8;
          out += String.fromCodePoint(parseInt(src.slice(pos + 1, pos + 1 + n), 16)); pos += n + 1;
        } else fail(`bad escape \\${c}`);
      } else out += src[pos++];
    }
    if (src[pos] !== '"') fail("unterminated string");
    pos++;
    return out;
  }

  function parseLiteralString() {
    pos++;
    const end = src.indexOf("'", pos);
    if (end < 0 || src.slice(pos, end).includes("\n")) fail("unterminated string");
    const s = src.slice(pos, end); pos = end + 1; return s;
  }

  function parseValue() {
    skipSpaces();
    const c = src[pos];
    if (c === '"') {
      if (src.startsWith('"""', pos)) fail("multi-line strings are not supported");
      return parseBasicString();
    }
    if (c === "'") return parseLiteralString();
    if (c === "[") return parseArray();
    if (c === "{") return parseInlineTable();
    if (src.startsWith("true", pos)) { pos += 4; return true; }
    if (src.startsWith("false", pos)) { pos += 5; return false; }
    const m = /^[+-]?(?:inf|nan|0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?)/.exec(src.slice(pos));
    if (!m) fail("unsupported value");
    pos += m[0].length;
    const t = m[0].replace(/_/g, "");
    if (/^[+-]?inf$/.test(t)) return t[0] === "-" ? -Infinity : Infinity;
    if (/^[+-]?nan$/.test(t)) return NaN;
    if (/^0[xob]/i.test(t)) return Number(t);
    return Number(t);
  }

  function parseArray() {
    pos++;
    const out = [];
    for (;;) {
      skipWsAndComments();
      if (src[pos] === "]") { pos++; return out; }
      out.push(parseValue());
      skipWsAndComments();
      if (src[pos] === ",") { pos++; continue; }
      skipWsAndComments();
      if (src[pos] === "]") { pos++; return out; }
      fail("expected , or ] in array");
    }
  }

  function parseInlineTable() {
    pos++;
    const out = {};
    skipSpaces();
    if (src[pos] === "}") { pos++; return out; }
    for (;;) {
      const key = parseKey();
      skipSpaces();
      if (src[pos] !== "=") fail("expected =");
      pos++;
      setPath(out, key, parseValue());
      skipSpaces();
      if (src[pos] === ",") { pos++; continue; }
      if (src[pos] === "}") { pos++; return out; }
      fail("expected , or } in inline table");
    }
  }

  function setPath(obj, keys, value) {
    let o = obj;
    for (const k of keys.slice(0, -1)) {
      if (!(k in o)) o[k] = {};
      o = Array.isArray(o[k]) ? o[k][o[k].length - 1] : o[k];
    }
    const last = keys[keys.length - 1];
    if (last in o) fail(`duplicate key ${last}`);
    o[last] = value;
  }

  function descend(keys, asArray) {
    let o = root;
    keys.forEach((k, idx) => {
      const isLast = idx === keys.length - 1;
      if (isLast && asArray) {
        if (!(k in o)) o[k] = [];
        if (!Array.isArray(o[k])) fail(`${k} is not an array of tables`);
        const t = {}; o[k].push(t); o = t;
      } else {
        if (!(k in o)) o[k] = {};
        o = Array.isArray(o[k]) ? o[k][o[k].length - 1] : o[k];
      }
    });
    return o;
  }

  while (pos < src.length) {
    skipSpaces();
    const c = peek();
    if (c === undefined) break;
    if (c === "\n" || c === "\r") { pos++; continue; }
    if (c === "#") { skipComment(); continue; }
    if (c === "[") {
      const isArr = src[pos + 1] === "[";
      pos += isArr ? 2 : 1;
      const keys = parseKey();
      skipSpaces();
      if (isArr) { if (!src.startsWith("]]", pos)) fail("expected ]]"); pos += 2; }
      else { if (src[pos] !== "]") fail("expected ]"); pos++; }
      target = descend(keys, isArr);
    } else {
      const keys = parseKey();
      skipSpaces();
      if (src[pos] !== "=") fail("expected =");
      pos++;
      setPath(target, keys, parseValue());
    }
    skipSpaces(); skipComment();
    if (pos < src.length && src[pos] !== "\n" && src[pos] !== "\r") fail("unexpected text after value");
  }
  return root;
}
