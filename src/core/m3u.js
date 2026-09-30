/**
 * vlcmate — M3U serialisation.
 *
 * Two callers depend on this being byte-identical:
 *   1. the userscript, for the "download .m3u" fallback and "copy playlist"
 *   2. the Windows handler, which writes the same format to a temp file
 *
 * So this function is the source of truth and `tests/fixtures/vectors.json`
 * pins its output. The PowerShell handler is asserted against the same vectors
 * on windows-latest, which is the only way to be sure a user's queue is not
 * silently reordered on the way to VLC.
 *
 * `includeTokens: false` produces a shareable playlist with the query strings
 * stripped — useful for pasting into a bug report without leaking a token.
 */

/** `#EXTINF` titles are a single line by definition. */
function oneLine(text) {
  return String(text == null ? "" : text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return "-1";
  return String(Math.round(value));
}

/** Strip the query string of a URL, keeping the path (for shareable output). */
function stripQuery(url) {
  const index = url.indexOf("?");
  return index === -1 ? url : url.slice(0, index);
}

export function buildM3u(payload, { includeTokens = true, newline = "\n" } = {}) {
  const opts = payload.opts || {};
  const lines = ["#EXTM3U"];
  if (payload.title) lines.push(`#PLAYLIST:${oneLine(payload.title)}`);

  for (const item of payload.items) {
    lines.push(`#EXTINF:${formatDuration(item.d)},${oneLine(item.t || item.u)}`);
    if (opts.cache) lines.push(`#EXTVLCOPT:network-caching=${Math.round(Number(opts.cache))}`);
    // Header options exist for the generic (non-Emby) adapters, where a stream
    // may be referrer-locked. Emby never needs them: its token is in the URL.
    if (opts.referrer) lines.push(`#EXTVLCOPT:http-referrer=${oneLine(opts.referrer)}`);
    if (opts.ua) lines.push(`#EXTVLCOPT:http-user-agent=${oneLine(opts.ua)}`);
    lines.push(includeTokens ? item.u : stripQuery(item.u));
  }
  return lines.join(newline) + newline;
}

export function playlistFilename(title, startIndex) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
  const slug = oneLine(title || "playlist")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const index = startIndex && startIndex > 1 ? `-from-${startIndex}` : "";
  return `bingetovlc-${stamp}${index}-${slug || "playlist"}.m3u`;
}
