/**
 * bingetovlc — payload codec.
 *
 * The handoff URI is the only thing that leaves the browser, so it is the most
 * failure-prone part of the project: it travels through a Chrome external
 * protocol prompt, the Windows registry, PowerShell's argument parsing and
 * finally a file on disk. Everything here is chosen to survive that trip:
 *
 *  - `base64url` (RFC 4648 §5), padding stripped: the alphabet is `A-Za-z0-9-_`,
 *    so there is no `+`, `/`, `=`, `%`, `&`, `?`, space or quote in the payload
 *    for any of those layers to mangle.
 *  - No `Buffer`, no `btoa`/`atob`: pure JS so the same file runs in the page,
 *    in Node (`node --test`) and in the CI harness.
 *  - Truncation detection, because a long URI can be cut off somewhere in the
 *    chain without any layer reporting an error. Two independent signals: the
 *    declared item count `n`, and non-zero trailing bits, which a correct
 *    base64url encoding of a whole payload never has.
 *  - Decoding tolerates the variants a browser might hand over anyway (padding,
 *    `+/`, whitespace, percent-escapes) rather than failing on them.
 */

export const PAYLOAD_VERSION = 2;

/**
 * Versions this build can *read*. `v1` carried full stream URLs, which made a
 * 28 episode season a 5,471 byte URI — past the Windows hand-off limit below.
 * `v2` carries item ids and lets the handler build the URL, so the same season
 * fits in a few hundred bytes. Reading v1 stays supported so a URI produced by
 * the earlier pre-release still works.
 */
export const SUPPORTED_VERSIONS = [1, 2];

/**
 * Ceiling for the URI handed to the browser.
 *
 * On Windows, Chromium hands an external-protocol URI to the shell with
 * `ShellExecuteA`, so the URI is bound by `INTERNET_MAX_URL_LENGTH` (~2046, and
 * IEInternals measured silent truncation at 2083) rather than by any browser
 * limit. Over that length Chrome still shows its prompt and then does nothing at
 * all when the user accepts — the failure mode is "no playlist, no error".
 *
 * A real measured data point: the v1 payload for a 28 episode season was 5,471
 * bytes, i.e. it would have failed exactly there and only there — on the feature
 * this project exists for. Hence 1,800 with headroom for the scheme, the query
 * key and registry quoting. Queues that still exceed it fall back to a
 * downloaded .m3u, which has no such limit.
 */
export const MAX_URI_LENGTH = 1800;

/** Item ceiling, kept as a secondary guard rather than the primary budget. */
export const MAX_URI_ITEMS = 200;

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * A URL that reaches the playlist file must not be able to change its structure.
 * An `.m3u` is line-oriented, so a newline inside a URL injects an extra playlist
 * entry or `#EXTVLCOPT` line — a playlist-content injection, not code execution,
 * but still a payload that does something other than what it says.
 *
 * The previous check only anchored the start of the URL (`^scheme://`), which
 * accepted `https://host/a\nfile:///etc/passwd`. This rejects any whitespace or
 * control character instead, at the point where a payload is built *and* where it
 * is decoded, so a hand-crafted URI cannot get past either door. `buildM3u`
 * strips control characters as well, for payloads assembled by other code.
 */
const UNSAFE_URL_CHARS = /[\u0000-\u001f\u007f\s]/;

export function assertSafeUrl(url) {
  if (typeof url !== "string" || !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) {
    throw new Error("payload item is not an absolute URL");
  }
  if (UNSAFE_URL_CHARS.test(url)) {
    throw new Error(
      "payload item URL contains whitespace or control characters; percent-encode it instead",
    );
  }
  return true;
}

/** An Emby-style item id: short, opaque, and never able to affect a file line. */
export function assertSafeItemId(id) {
  if (typeof id !== "string" || id.length === 0 || id.length > 64) {
    throw new Error("payload item id must be a non-empty string of at most 64 characters");
  }
  if (UNSAFE_URL_CHARS.test(id) || id.includes("/") || id.includes("?")) {
    throw new Error("payload item id contains characters that would change the generated URL");
  }
  return true;
}

/**
 * The URL for one payload item.
 *
 * v2 payloads carry ids and the handler builds the URL, so the queue stays small
 * enough to survive the Windows hand-off. v1 payloads and the generic adapter
 * carry the URL directly. Both shapes are accepted everywhere a playlist is
 * produced (browser, PowerShell handler, Python reference), which is what keeps
 * the three implementations byte-identical.
 */
export function resolveItemUrl(payload, item) {
  if (item && typeof item.u === "string" && item.u) return item.u;
  const server = String((payload && payload.server) || "").replace(/\/+$/, "");
  const token = (payload && payload.token) || "";
  return `${server}/Videos/${item.i}/stream?Static=true&api_key=${encodeURIComponent(token)}`;
}

function pad2(value) {
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.trunc(n)).padStart(2, "0") : "00";
}

/**
 * The playlist label for an item, in order of preference: the episode title when
 * the payload had room for it, then the two-byte-per-item `S01E03` form, then the
 * URL. `fitToBudget()` is what decides whether the title survives.
 */
export function labelForItem(payload, item) {
  if (item && item.t) return item.t;
  if (item && (item.s !== undefined || item.e !== undefined)) {
    return `S${pad2(item.s)}E${pad2(item.e)}`;
  }
  return resolveItemUrl(payload, item);
}

/**
 * Trim a payload until it fits the URI budget.
 *
 * Titles are the expensive part of a queue (20-40 bytes each) and the season and
 * episode numbers reproduce the useful part of them in about 2 bytes, so titles
 * are dropped first, then durations. What is never dropped is an id: that is the
 * only part the handler cannot reconstruct.
 *
 * This runs inside `build()` so a caller cannot forget it, and it is recorded in
 * `payload.trimmed` so the UI can tell the user the labels will be compact.
 */
export function fitToBudget(payload, { maxUriLength = MAX_URI_LENGTH, scheme = "vlc" } = {}) {
  const length = () => launchUri(payload, scheme).length;
  if (length() <= maxUriLength) return payload;
  if (payload.items.some((item) => item.t)) {
    for (const item of payload.items) delete item.t;
    payload.trimmed = "titles";
    if (length() <= maxUriLength) return payload;
  }
  if (payload.items.some((item) => item.d !== undefined)) {
    for (const item of payload.items) delete item.d;
    payload.trimmed = "titles+durations";
  }
  return payload;
}

/** String -> UTF-8 bytes (surrogate-pair safe). */
export function toUtf8Bytes(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i++;
      }
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 63),
        0x80 | ((code >> 6) & 63),
        0x80 | (code & 63),
      );
    }
  }
  return out;
}

/** UTF-8 bytes -> string. */
export function fromUtf8Bytes(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b0 = bytes[i++];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
    } else if (b0 < 0xe0) {
      out += String.fromCharCode(((b0 & 31) << 6) | (bytes[i++] & 63));
    } else if (b0 < 0xf0) {
      const cp = ((b0 & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
      out += String.fromCharCode(cp);
    } else {
      const cp =
        ((b0 & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
      const v = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 1023));
    }
  }
  return out;
}

/** Bytes -> base64url, padding stripped. */
export function base64UrlEncodeBytes(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    if (b1 === undefined) break;
    out += B64_ALPHABET[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    if (b2 === undefined) break;
    out += B64_ALPHABET[b2 & 63];
  }
  return out;
}

/**
 * base64url (or base64, padded, percent-escaped, whitespace-wrapped) -> bytes.
 * Tolerant about the input spelling, strict about the input *bytes*: leftover
 * bits must be zero, otherwise the payload was truncated or corrupted in transit.
 */
export function base64UrlDecodeBytes(input) {
  let s = String(input)
    .replace(/\s+/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  try {
    s = decodeURIComponent(s);
  } catch {
    /* not percent-encoded; keep as-is */
  }
  s = s.replace(/=+$/, "");
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of s) {
    const value = B64_ALPHABET.indexOf(ch);
    if (value === -1) throw new Error(`invalid base64url character: ${ch}`);
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) {
    throw new Error("payload was truncated or corrupted in transit");
  }
  return bytes;
}

export function encodeText(text) {
  return base64UrlEncodeBytes(toUtf8Bytes(text));
}

export function decodeText(text) {
  return fromUtf8Bytes(base64UrlDecodeBytes(text));
}

/**
 * Build a payload object.
 *
 * Items are accepted with either short keys (`u`/`i`, `t`, `d`) or long ones
 * (`url`/`id`, `title`, `duration`) and normalised to the short form, because the
 * URI length budget is real and enforced by the operating system.
 *
 * Two item shapes are valid:
 *   - `{i: "<item id>"}` with a payload-level `server` + `token`: the handler
 *     builds the stream URL. This is what the Emby adapter uses, and it is the
 *     reason a 28 episode season fits in a URI at all.
 *   - `{u: "<absolute url>"}`: a complete URL, used by the generic adapter and by
 *     v1 payloads.
 */
export function build({ source, server, token, title, scope, items = [], opts = {}, budget = MAX_URI_LENGTH }) {
  if (!Array.isArray(items)) throw new Error("items must be an array");
  const normalised = items.map((item) => {
    const url = item.u || item.url;
    const id = item.i || item.id;
    if (!url && !id) throw new Error("item is missing a url or an id");
    const entry = {};
    if (url) {
      assertSafeUrl(url);
      entry.u = url;
    } else {
      assertSafeItemId(String(id));
      entry.i = String(id);
    }
    // Season/episode numbers are 2 bytes each and let the handler label a queue
    // "S01E03" when the full titles did not fit the URI budget. Guarded so a movie
    // (both fields null) does not become "S00E00".
    const rawSeason = item.s !== undefined ? item.s : item.season;
    if (rawSeason !== undefined && rawSeason !== null && rawSeason !== "" && Number.isFinite(Number(rawSeason))) {
      entry.s = Math.trunc(Number(rawSeason));
    }
    const rawEpisode = item.e !== undefined ? item.e : item.episode;
    if (rawEpisode !== undefined && rawEpisode !== null && rawEpisode !== "" && Number.isFinite(Number(rawEpisode))) {
      entry.e = Math.trunc(Number(rawEpisode));
    }
    const label = item.t || item.title;
    if (label) entry.t = String(label).replace(/[\r\n]+/g, " ").trim();
    const duration = item.d === undefined ? item.duration : item.d;
    if (duration !== undefined && duration !== null && Number.isFinite(Number(duration))) {
      entry.d = Math.max(0, Math.round(Number(duration)));
    }
    return entry;
  });
  if (normalised.length === 0) throw new Error("payload needs at least one item");

  const payload = {
    v: PAYLOAD_VERSION,
    src: source || "unknown",
    server: server || "",
    title: title || "",
    scope: scope || "item",
    n: normalised.length,
    items: normalised,
  };
  if (token) payload.token = String(token);
  const cleanOpts = {};
  for (const key of ["fs", "one", "exit", "cache", "referrer", "ua"]) {
    if (opts[key] !== undefined && opts[key] !== null && opts[key] !== false) cleanOpts[key] = opts[key];
  }
  if (opts.start) cleanOpts.start = Math.max(1, Math.round(Number(opts.start)));
  if (Object.keys(cleanOpts).length) payload.opts = cleanOpts;
  // The budget only applies to the URI path: a downloaded .m3u has no length
  // limit, so it keeps the full titles (pass budget: null to skip the trim).
  if (budget !== null) fitToBudget(payload, { maxUriLength: budget });
  validate(payload);
  return payload;
}

export function encode(payload) {
  return encodeText(JSON.stringify(payload));
}

/** Throws a descriptive error; every caller surfaces it to the user verbatim. */
export function decode(text) {
  const payload = JSON.parse(decodeText(text));
  validate(payload);
  return payload;
}

export function validate(payload) {
  if (!payload || typeof payload !== "object") throw new Error("payload is not an object");
  if (!SUPPORTED_VERSIONS.includes(payload.v)) {
    throw new Error(`unsupported payload version ${payload.v} (this build speaks ${SUPPORTED_VERSIONS.join(", ")})`);
  }
  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    throw new Error("payload has no items");
  }
  if (payload.n !== undefined && payload.n !== payload.items.length) {
    throw new Error(
      `payload is incomplete: it declares ${payload.n} items but contains ${payload.items.length}`,
    );
  }

  const hasIds = payload.items.some((item) => item && !item.u && item.i);
  if (hasIds) {
    // Id-based items are only resolvable against an authenticated server, so the
    // payload must carry both. Without them the queue would silently become a
    // list of 404s, which is worse than refusing the payload.
    assertSafeUrl(String(payload.server || ""));
    if (typeof payload.token !== "string" || payload.token.length === 0) {
      throw new Error("payload carries item ids but no token to build their URLs with");
    }
    if (UNSAFE_URL_CHARS.test(payload.token)) {
      throw new Error("payload token contains whitespace or control characters");
    }
    // Deliberately narrow: these are the characters every implementation can
    // place in a URL without percent-encoding, so the JavaScript, the PowerShell
    // handler and the Python reference cannot diverge on escaping. Emby access
    // tokens are hex, so this costs nothing in practice.
    if (!/^[A-Za-z0-9._~-]+$/.test(payload.token)) {
      throw new Error(
        "payload token contains characters that would need percent-encoding; the three implementations would disagree on the escaped form",
      );
    }
  }

  for (const item of payload.items) {
    if (!item || typeof item !== "object") throw new Error("payload item is not an object");
    if (item.u !== undefined) {
      assertSafeUrl(item.u);
    } else {
      assertSafeItemId(item.i);
    }
  }
  return true;
}

/**
 * The URI that goes into the browser. `scheme` defaults to `vlc` because that is
 * what the installer registers first and what users expect to see.
 */
export function launchUri(payload, scheme = "vlc") {
  return `${String(scheme).replace(/:.*$/, "")}://open?d=${encode(payload)}`;
}

export function estimatedUriLength(payload, scheme = "vlc") {
  return launchUri(payload, scheme).length;
}

/**
 * Decide how this queue should reach VLC.
 *
 *  - `uri`      : short enough to survive the browser + registry round trip
 *  - `download` : too long for a URI, so the user gets an .m3u file instead
 */
export function chooseHandoff(payload, scheme = "vlc", { maxUriLength = MAX_URI_LENGTH, maxItems = MAX_URI_ITEMS } = {}) {
  const length = estimatedUriLength(payload, scheme);
  if (payload.items.length > maxItems) {
    return { mode: "download", reason: "too-many-items", length, items: payload.items.length, maxItems };
  }
  if (length > maxUriLength) {
    return { mode: "download", reason: "uri-too-long", length, maxUriLength, items: payload.items.length };
  }
  return { mode: "uri", length, items: payload.items.length, uri: launchUri(payload, scheme) };
}
