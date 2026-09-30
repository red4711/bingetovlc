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

export const PAYLOAD_VERSION = 1;

/** Conservative ceiling for a URI we are willing to hand to Chrome. */
export const MAX_URI_LENGTH = 6000;

/** Guard rail: longer queues use the .m3u download path instead of a URI. */
export const MAX_URI_ITEMS = 60;

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
 * Build a payload object. Items are accepted with either short keys (`u`, `t`,
 * `d`) or long ones (`url`, `title`, `duration`) and normalised to short keys,
 * because the URI length budget is real.
 */
export function build({ source, server, title, scope, items = [], opts = {} }) {
  if (!Array.isArray(items)) throw new Error("items must be an array");
  const normalised = items.map((item) => {
    const url = item.u || item.url;
    if (!url || typeof url !== "string") throw new Error("item is missing a url");
    assertSafeUrl(url);
    const entry = { u: url };
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
  const cleanOpts = {};
  for (const key of ["fs", "one", "exit", "cache", "referrer", "ua"]) {
    if (opts[key] !== undefined && opts[key] !== null && opts[key] !== false) cleanOpts[key] = opts[key];
  }
  if (opts.start) cleanOpts.start = Math.max(1, Math.round(Number(opts.start)));
  if (Object.keys(cleanOpts).length) payload.opts = cleanOpts;
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
  if (payload.v !== PAYLOAD_VERSION) {
    throw new Error(`unsupported payload version ${payload.v} (this build speaks ${PAYLOAD_VERSION})`);
  }
  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    throw new Error("payload has no items");
  }
  if (payload.n !== undefined && payload.n !== payload.items.length) {
    throw new Error(
      `payload is incomplete: it declares ${payload.n} items but contains ${payload.items.length}`,
    );
  }
  for (const item of payload.items) {
    if (!item || typeof item.u !== "string") throw new Error("payload item is not an absolute URL");
    assertSafeUrl(item.u);
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
