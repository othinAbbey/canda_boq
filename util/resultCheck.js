import fs from "node:fs";

/** A usable AI answer is an object with a `views` list. Anything else (for example `{}`) must never be cached or trusted. */
export const isUsableResult = (raw) => raw !== null && typeof raw === "object" && Array.isArray(raw.views);

/** Reads a cached answer, or returns null if the file is missing, corrupt or not a usable answer (so it is simply asked again). */
export function readCache(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return isUsableResult(j) ? j : null;
  } catch { return null; }
}
