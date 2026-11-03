/**
 * Python-compatible number rounding and formatting.
 *
 * Why this exists: Python's round() and format() round to the nearest
 * decimal using the EXACT binary value and break exact ties to even.
 * JavaScript's Math.round() and toFixed() differ
 * (round(1.115, 2) is 1.11 in Python but Math.round gives 1.12). A bill of
 * quantities must give the same numbers whichever language computes it, so
 * every rounding in this code base goes through these helpers.
 */

/** Exact decimal expansion of |x| as [integerDigits, fractionDigits] (|x| < 1e21). */
function exactParts(x) {
  const s = Math.abs(x).toFixed(100);          // toFixed is exact for doubles >= ~1e-15
  const dot = s.indexOf(".");
  return [s.slice(0, dot), s.slice(dot + 1)];
}

/** Round the digit string `head + rest` to head.length digits, half to even. */
function roundsUp(head, rest) {
  if (!rest.length || rest[0] < "5") return false;
  if (rest[0] > "5" || /[1-9]/.test(rest.slice(1))) return true;
  return (head.charCodeAt(head.length - 1) - 48) % 2 === 1;      // exact tie: to even
}

/** x as a string with `nd` decimals, like Python's "%.{nd}f" % x. */
export function toFixedPy(x, nd = 0) {
  if (!Number.isFinite(x)) return String(x);
  const sign = x < 0 || Object.is(x, -0) ? "-" : "";
  if (Math.abs(x) >= 1e21) return sign + BigInt(Math.abs(x)).toString() + (nd > 0 ? "." + "0".repeat(nd) : "");
  const [ip, fp] = exactParts(x);
  const head = ip + fp.slice(0, nd).padEnd(nd, "0");
  const up = roundsUp(head, fp.slice(nd));
  const digits = (BigInt(head) + (up ? 1n : 0n)).toString().padStart(nd + 1, "0");
  return sign + (nd > 0 ? digits.slice(0, -nd) + "." + digits.slice(-nd) : digits);
}

/** Python round(x, nd) for floats. */
export function pyRound(x, nd = 0) {
  if (typeof x !== "number" || !Number.isFinite(x)) return x;
  return Number(toFixedPy(x, nd));
}

/** Python round(x) with no digits: an integer, ties to even. */
export function pyRoundInt(x) {
  return Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : Math.round(x);
}

/** Python format(x, ".0%") */
export function fmtPct0(x) {
  return toFixedPy(x * 100, 0) + "%";
}

/** Python format(x, "g"): 6 significant digits, trailing zeros removed. */
export function fmtG(x, prec = 6) {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : (x < 0 ? "-inf" : "inf");
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  const [ip, fp] = exactParts(x);
  const intDigits = ip.replace(/^0+/, "");
  let digits, exp;
  if (intDigits) { digits = intDigits + fp; exp = intDigits.length - 1; }
  else { const k = fp.search(/[1-9]/); digits = fp.slice(k); exp = -(k + 1); }

  let head = digits.slice(0, prec).padEnd(prec, "0");
  if (roundsUp(head, digits.slice(prec))) {
    head = (BigInt(head) + 1n).toString();
    if (head.length > prec) { head = head.slice(0, prec); exp += 1; }   // 999999.5 -> 1e+06
  }
  let out;
  if (exp < -4 || exp >= prec) {
    const frac = head.slice(1).replace(/0+$/, "");
    const e = Math.abs(exp);
    out = head[0] + (frac ? "." + frac : "") + "e" + (exp < 0 ? "-" : "+") + (e < 10 ? "0" + e : e);
  } else if (exp >= 0) {
    const frac = head.slice(exp + 1).replace(/0+$/, "");
    out = head.slice(0, exp + 1) + (frac ? "." + frac : "");
  } else {
    out = "0." + ("0".repeat(-exp - 1) + head).replace(/0+$/, "");
  }
  return (x < 0 ? "-" : "") + out;
}

/**
 * Python's sum() of floats. Since Python 3.12 it uses Neumaier compensated
 * summation (sum([0.1]*10) == 1.0); a plain JS reduce gives 0.9999999999999999.
 */
export function pySum(xs) {
  let f = 0, c = 0;
  for (const x of xs) {
    const t = f + x;
    if (Math.abs(f) >= Math.abs(x)) c += (f - t) + x;
    else c += (x - t) + f;
    f = t;
  }
  if (c && Number.isFinite(c)) f += c;
  return f;
}

/** Python truthiness: None, False, 0, "", [] and {} are falsy. */
export function truthy(v) {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return !(typeof v === "number" && Number.isNaN(v)) || false;
}

/** Python str(x) for the JSON-ish values the model can send. */
export function pyStr(v) {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
