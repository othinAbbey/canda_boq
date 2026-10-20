/** Parse a multipart/form-data body and return the parts. */
export function parseMultipart(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!m) throw new Error("missing multipart boundary");
  const boundary = Buffer.from("--" + (m[1] || m[2]).trim());
  const parts = [];
  let start = body.indexOf(boundary);
  while (start !== -1) {
    start += boundary.length;
    if (body.slice(start, start + 2).toString() === "--") break;         // closing boundary
    if (body.slice(start, start + 2).toString() === "\r\n") start += 2;
    const next = body.indexOf(boundary, start);
    if (next === -1) break;
    const part = body.slice(start, next - 2);                            // strip trailing CRLF
    const split = part.indexOf("\r\n\r\n");
    if (split !== -1) {
      const headerText = part.slice(0, split).toString("utf8");
      const headers = {};
      for (const line of headerText.split("\r\n")) {
        const i = line.indexOf(":");
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      const disp = headers["content-disposition"] || "";
      const name = /\bname="([^"]*)"/.exec(disp);
      const filename = /\bfilename="([^"]*)"/.exec(disp);
      parts.push({
        name: name ? name[1] : null,
        filename: filename ? filename[1] : null,
        contentType: headers["content-type"] || null,
        data: part.slice(split + 4),
      });
    }
    start = next;
  }
  return parts;
}
