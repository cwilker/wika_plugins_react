/** Consensus-compatible page identity v1; deliberately does not use browser URL serialization.
 * ASCII URIs only. Use A-label hostnames and percent-encoded non-ASCII text.
 * Identity normalization alone does not authorize a network fetch (including IP literals).
 */
export const PAGE_IDENTITY_VERSION = 1;
export const MAX_PAGE_URL_BYTES = 254;
export function canonicalPageUrl(input: string): string {
  const invalid = (): never => { throw new Error("Unsupported or invalid page URL (identity v1)."); };
  if (!input || input.length > MAX_PAGE_URL_BYTES || /[^\x21-\x7e]|[\\"<>'`{}|^\[\]]/.test(input)) invalid();
  const raw = input.split("#", 1)[0]!;
  const separator = raw.indexOf("://");
  if (separator < 0) invalid();
  const scheme = raw.slice(0, separator).toLowerCase();
  if (scheme !== "https" && scheme !== "http") invalid();
  const rest = raw.slice(separator + 3);
  const end = rest.search(/[/?]/);
  const authority = end < 0 ? rest : rest.slice(0, end);
  const tail = end < 0 ? "" : rest.slice(end);
  if (authority.includes("@")) invalid();
  const parts = authority.split(":");
  if (parts.length > 2) invalid();
  const host = parts[0]!;
  const port = parts[1];
  if (port !== undefined && (!/^[1-9][0-9]*$/.test(port) || Number(port) > 65535)) invalid();
  const labels = host.split(".");
  if (!host || host.length > 253 || labels.some(label => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) invalid();
  const last = labels.at(-1)!;
  if (/^0x[0-9a-f]+$/i.test(last)) invalid();
  if (/^[0-9]+$/.test(last) && (labels.length !== 4 || labels.some(s => !/^(0|[1-9][0-9]*)$/.test(s) || Number(s) > 255))) invalid();
  const queryAt = tail.indexOf("?");
  const path = queryAt < 0 ? tail : tail.slice(0, queryAt);
  const query = queryAt < 0 ? "" : tail.slice(queryAt);
  if (/%(?![a-f0-9]{2})/i.test(tail)) invalid();
  const segments: string[] = [];
  if (path) {
    const pieces = path.slice(1).split("/");
    pieces.forEach((segment, index) => {
      const dot = segment.replace(/%2e/gi, ".");
      if (dot !== segment && (dot === "." || dot === "..")) invalid();
      if (segment === "..") segments.pop();
      else if (segment !== ".") segments.push(segment);
      if (index === pieces.length - 1 && (segment === "." || segment === "..")) segments.push("");
    });
  }
  const suffix = port && !(scheme === "https" && port === "443" || scheme === "http" && port === "80") ? `:${port}` : "";
  const result = `${scheme}://${host.toLowerCase()}${suffix}/${segments.join("/")}${query}`;
  if (result.length > MAX_PAGE_URL_BYTES) invalid();
  return result;
}
