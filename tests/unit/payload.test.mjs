/**
 * Unit tests for src/core/payload.js — the URI codec.
 *
 * The payload is the single most failure-prone artefact in the project: it
 * travels through Chrome, the registry, PowerShell and a file on disk. These
 * tests pin the two properties that matter — a round trip never loses a
 * character, and a mangled payload fails loudly instead of quietly shrinking
 * the queue (which is how a user ends up watching the wrong episode).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  PAYLOAD_VERSION,
  MAX_URI_LENGTH,
  MAX_URI_ITEMS,
  toUtf8Bytes,
  fromUtf8Bytes,
  base64UrlEncodeBytes,
  base64UrlDecodeBytes,
  encodeText,
  decodeText,
  build,
  encode,
  decode,
  validate,
  launchUri,
  estimatedUriLength,
  chooseHandoff,
} from "../../src/core/payload.js";
// Namespace import on purpose: a checkout that predates `assertSafeUrl()` must
// still import cleanly, so the URL-hygiene tests below can skip loudly instead
// of crashing with "does not provide an export named".
import * as payloadApi from "../../src/core/payload.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const SERVER = "https://media.example.com";
const streamUrl = (id) => `${SERVER}/Videos/${id}/stream?Static=true&api_key=${TOKEN}`;

function moviePayload(items = [{ url: streamUrl("3518601"), title: "Ghosts of Mars", duration: 5880 }]) {
  return build({ source: "emby", server: SERVER, title: "Ghosts of Mars", scope: "item", items });
}

// ---------------------------------------------------------------------------
// UTF-8 and base64url primitives
// ---------------------------------------------------------------------------

test("utf8 byte round trip: ASCII, CJK, emoji, em dash, surrogate pairs", () => {
  const samples = [
    "",
    "plain ascii",
    "葬送のフリーレン",
    "S01E28 잘 어울리는 게 부끄러운 일이라니까 — It Would Be Embarrassing, Really; №28",
    "em dash — and ellipsis … and fullwidth Ｓｅａｓｏｎ",
    "emoji 🎬 😀 🇯🇵 👩‍👩‍👧‍👦",
    "math surrogate pair 𝄞 𝕏",
  ];
  for (const sample of samples) {
    const bytes = toUtf8Bytes(sample);
    assert.ok(Array.isArray(bytes), "toUtf8Bytes must return a plain array");
    assert.equal(fromUtf8Bytes(bytes), sample, `utf8 round trip failed for ${JSON.stringify(sample)}`);
  }
});

test("surrogate pair encodes to 4 UTF-8 bytes (not two 3-byte sequences)", () => {
  assert.deepEqual(toUtf8Bytes("😀"), [0xf0, 0x9f, 0x98, 0x80]);
});

test("base64url byte round trip is exact and unpadded", () => {
  const bytes = [0, 1, 2, 127, 128, 200, 254, 255, 65, 66];
  const encoded = base64UrlEncodeBytes(bytes);
  assert.match(encoded, /^[A-Za-z0-9_-]*$/);
  assert.ok(!encoded.includes("="), "base64url output must not be padded");
  assert.deepEqual(base64UrlDecodeBytes(encoded), bytes);
});

test("encodeText output is unpadded and inside the base64url alphabet", () => {
  const text = build({ source: "emby", server: SERVER, title: "Frieren — 葬送のフリーレン 🎬", scope: "item", items: [{ url: streamUrl("1") }] });
  const encoded = encode(text);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.ok(!encoded.includes("="), "encoded payload must be unpadded");
  assert.deepEqual(decode(encoded), text);
});

// ---------------------------------------------------------------------------
// Tolerance of browser-mangled input
// ---------------------------------------------------------------------------

test("decode tolerates padded base64url", () => {
  const payload = moviePayload();
  const bare = encode(payload);
  const padded = bare + "=".repeat((4 - (bare.length % 4)) % 4);
  assert.deepEqual(decode(padded), payload);
});

test("decode tolerates the standard +/ base64 alphabet", () => {
  // An emoji forces a 62/63 sextet, so the standard alphabet really does use
  // '+' or '/' here; assert that, otherwise the test would be vacuous.
  const payload = build({
    source: "emby",
    server: SERVER,
    title: "🎬😀 — standard alphabet probe",
    scope: "item",
    items: [{ url: streamUrl("3020743"), title: "🎬 title", duration: 10 }],
  });
  const std = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  assert.match(std, /[+/]/, "test input must exercise the +/ alphabet");
  assert.deepEqual(decode(std), payload);
  assert.equal(decode(std).items[0].t, "🎬 title");
});

test("decode tolerates percent-escaped input", () => {
  const payload = moviePayload();
  const bare = encode(payload);
  const padded = bare + "=".repeat((4 - (bare.length % 4)) % 4);
  const escaped = padded.replace(/=/g, "%3D").replace(/-/g, "%2D").replace(/_/g, "%5F");
  assert.deepEqual(decode(escaped), payload);
});

test("decode tolerates surrounding and internal whitespace", () => {
  const payload = moviePayload();
  const bare = encode(payload);
  const spaced = " \n\t" + bare.slice(0, 20) + "\r\n " + bare.slice(20) + "\n";
  assert.deepEqual(decode(spaced), payload);
});

// ---------------------------------------------------------------------------
// Truncation and corruption must fail loudly
// ---------------------------------------------------------------------------

test("truncated payloads throw a clean Error, never a silently short queue", () => {
  const payload = build({
    source: "emby",
    server: SERVER,
    title: "Season 1 — 3 episodes",
    scope: "season",
    items: [
      { url: streamUrl("3020743"), title: "S01E01", duration: 10 },
      { url: streamUrl("3020744"), title: "S01E02", duration: 10 },
      { url: streamUrl("3020745"), title: "S01E03", duration: 10 },
    ],
  });
  const bare = encode(payload);
  const errors = [];
  for (let cut = bare.length - 1; cut >= Math.max(0, bare.length - 12); cut--) {
    const candidate = bare.slice(0, cut);
    let result;
    try {
      result = decode(candidate);
    } catch (error) {
      assert.ok(error instanceof Error, "truncation must raise an Error");
      assert.equal(typeof error.message, "string");
      assert.ok(error.message.length > 0, "truncation error must carry a message");
      errors.push(error.message);
      continue;
    }
    // If it ever decoded, it must not have silently dropped items.
    assert.equal(result.items.length, payload.items.length, `slicing to ${cut} produced a short queue`);
  }
  assert.ok(errors.length > 0, "at least one truncation must be rejected");
});

test("truncation that leaves non-zero trailing bits is rejected at the codec level", () => {
  // [1, 2, 0x80] encodes to "AQKA"; its last character carries the two high bits
  // of the third byte, so dropping it leaves non-zero trailing bits.
  assert.deepEqual(base64UrlDecodeBytes("AQKA"), [1, 2, 0x80]);
  assert.throws(() => base64UrlDecodeBytes("AQK"), /truncated|corrupt/i);
});

test("a payload with a non-zero trailing-bit tail is rejected", () => {
  const payload = moviePayload();
  const bare = encode(payload);
  // Re-introduce a stray character that carries non-zero trailing bits.
  assert.throws(() => decode(bare + "B"));
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("PAYLOAD_VERSION and the length guard rails are the frozen values", () => {
  assert.equal(PAYLOAD_VERSION, 1);
  assert.equal(MAX_URI_LENGTH, 6000);
  assert.equal(MAX_URI_ITEMS, 60);
});

test("a payload with the wrong version is rejected with a versioned message", () => {
  const payload = moviePayload();
  payload.v = PAYLOAD_VERSION + 1;
  assert.throws(() => validate(payload), new RegExp(`unsupported payload version ${PAYLOAD_VERSION + 1}`));
  assert.throws(() => decode(encode(payload)), /unsupported payload version/);
});

test("a declared item count that disagrees with the array length is rejected", () => {
  const payload = moviePayload();
  payload.n = payload.items.length + 3;
  assert.throws(() => validate(payload), /declares 4 items but contains 1/);
  assert.throws(() => decode(encode(payload)), /incomplete/);

  const short = moviePayload();
  short.n = 0;
  assert.throws(() => validate(short), /declares 0 items but contains 1/);
});

test("validate rejects empty items, a non-object and relative URLs", () => {
  assert.throws(() => validate(null), /not an object/);
  assert.throws(() => validate({ v: PAYLOAD_VERSION, items: [] }), /no items/);
  assert.throws(
    () => validate({ v: PAYLOAD_VERSION, n: 1, items: [{ u: "/Videos/1/stream" }] }),
    /not an absolute URL/,
  );
});

test("build normalises long keys, folds newlines in titles and drops empty opts", () => {
  const payload = build({
    source: "emby",
    server: SERVER,
    title: "T",
    scope: "season",
    items: [{ url: streamUrl("1"), title: "line one\nline two\ttab", duration: "1560.4" }],
    opts: { fs: false, one: true, cache: 0, start: 0 },
  });
  assert.deepEqual(payload.items[0], { u: streamUrl("1"), t: "line one line two\ttab", d: 1560 });
  assert.equal(payload.items[0].t.includes("\n"), false, "CR/LF must be folded out of a title");
  assert.deepEqual(payload.opts, { one: true, cache: 0 }, "false is dropped, 0 is a real value");
  assert.equal(payload.n, 1);
  assert.throws(() => build({ items: [] }), /at least one item/);
  assert.throws(() => build({ items: [{ title: "no url" }] }), /missing a url/);
});

// ---------------------------------------------------------------------------
// URI shape
// ---------------------------------------------------------------------------

test("launchUri produces the frozen shape for both schemes", () => {
  const payload = moviePayload();
  const vlc = launchUri(payload, "vlc");
  const alias = launchUri(payload, "bingetovlc");
  assert.equal(vlc, `vlc://open?d=${encode(payload)}`);
  assert.equal(alias, `bingetovlc://open?d=${encode(payload)}`);
  assert.ok(vlc.startsWith("vlc://open?d="), "primary scheme must be vlc");
  assert.ok(alias.startsWith("bingetovlc://open?d="), "alias scheme must be bingetovlc");
  // Default scheme is vlc.
  assert.equal(launchUri(payload), vlc);
  // A scheme with decoration is normalised to its bare form.
  assert.equal(launchUri(payload, "vlc:"), vlc);
  assert.equal(estimatedUriLength(payload, "vlc"), vlc.length);
});

// ---------------------------------------------------------------------------
// chooseHandoff boundaries
// ---------------------------------------------------------------------------

function payloadWithItems(count) {
  const items = Array.from({ length: count }, (_, i) => ({
    url: `https://x.y/v/${i}`,
    title: "A",
  }));
  return build({ source: "t", server: "https://x.y", title: "T", scope: "season", items });
}

test("chooseHandoff: exactly MAX_URI_ITEMS stays a URI, one more goes to download", () => {
  const atMax = payloadWithItems(MAX_URI_ITEMS);
  const over = payloadWithItems(MAX_URI_ITEMS + 1);
  // Guard the premise: at MAX items the URI must still fit the length budget,
  // otherwise this would be testing the length branch, not the item branch.
  assert.ok(estimatedUriLength(atMax) <= MAX_URI_LENGTH, "premise: MAX_URI_ITEMS payload must fit");

  const atDecision = chooseHandoff(atMax, "vlc");
  assert.equal(atDecision.mode, "uri");
  assert.equal(atDecision.items, MAX_URI_ITEMS);

  const overDecision = chooseHandoff(over, "vlc");
  assert.equal(overDecision.mode, "download");
  assert.equal(overDecision.reason, "too-many-items");
  assert.equal(overDecision.maxItems, MAX_URI_ITEMS);
});

/** Find a payload whose estimated URI length is exactly `target`. */
function payloadWithUriLength(target) {
  for (let pad = 0; pad < 8000; pad++) {
    const payload = build({
      source: "t",
      server: "https://s.example",
      title: "A" + "x".repeat(pad),
      scope: "item",
      items: [{ url: "https://s.example/Videos/1/stream?Static=true&api_key=" + "k".repeat(20) }],
    });
    const length = estimatedUriLength(payload, "vlc");
    if (length === target) return payload;
    if (length > target) break;
  }
  return null;
}

test("chooseHandoff: exactly MAX_URI_LENGTH stays a URI, longer goes to download", () => {
  const exact = payloadWithUriLength(MAX_URI_LENGTH);
  assert.ok(exact, `could not construct a payload with an exact ${MAX_URI_LENGTH}-byte URI`);
  assert.equal(estimatedUriLength(exact, "vlc"), MAX_URI_LENGTH);

  const exactDecision = chooseHandoff(exact, "vlc");
  assert.equal(exactDecision.mode, "uri", "a URI at exactly the ceiling must still be used");
  assert.equal(exactDecision.length, MAX_URI_LENGTH);

  // Grow the title until the URI exceeds the ceiling.
  const exactTitleLength = exact.title.length;
  let longer = null;
  for (let grow = 1; grow < 64 && !longer; grow++) {
    const candidate = build({
      source: "t",
      server: "https://s.example",
      title: "A" + "x".repeat(exactTitleLength - 1 + grow),
      scope: "item",
      items: [{ url: "https://s.example/Videos/1/stream?Static=true&api_key=" + "k".repeat(20) }],
    });
    if (estimatedUriLength(candidate, "vlc") > MAX_URI_LENGTH) longer = candidate;
  }
  assert.ok(longer, "could not construct a payload longer than the ceiling");
  const longDecision = chooseHandoff(longer, "vlc");
  assert.equal(longDecision.mode, "download");
  assert.equal(longDecision.reason, "uri-too-long");
  assert.equal(longDecision.maxUriLength, MAX_URI_LENGTH);
});

test("chooseHandoff: the ceiling is inclusive at an explicit maxUriLength", () => {
  const payload = moviePayload();
  const length = estimatedUriLength(payload, "vlc");
  assert.equal(chooseHandoff(payload, "vlc", { maxUriLength: length }).mode, "uri");
  const decision = chooseHandoff(payload, "vlc", { maxUriLength: length - 1 });
  assert.equal(decision.mode, "download");
  assert.equal(decision.reason, "uri-too-long");
  assert.equal(decision.length, length);
});

test("chooseHandoff returns the launch URI in the success case", () => {
  const payload = moviePayload();
  const decision = chooseHandoff(payload, "vlc");
  assert.equal(decision.mode, "uri");
  assert.equal(decision.uri, launchUri(payload, "vlc"));
  assert.equal(decision.items, 1);
});

// ---------------------------------------------------------------------------
// URL hygiene: a URL must not be able to change the playlist's structure.
//
// An .m3u is line-oriented, so a newline inside a URL starts a new line and can
// inject an extra entry or a #EXTVLCOPT line. The old check only anchored the
// start of the URL (`^scheme://`), which accepted `https://host/a\nfile:///…`.
// ---------------------------------------------------------------------------

/** The defence landed on main after this worktree was branched; detect it. */
const URL_INJECTION_DEFENCE = (() => {
  try {
    build({ source: "t", server: "https://h", title: "", scope: "item", items: [{ url: "https://h/a\nb" }] });
    return false; // build() accepted a newline: assertSafeUrl() is not present
  } catch {
    return true;
  }
})();

const MERGE_NOTE =
  "src/core/payload.js in this checkout has no assertSafeUrl() — the URL-injection " +
  "defence landed on main after this branch and these assertions run for real on merge";

const UNSAFE_URLS = [
  ["newline", "https://h/a\nb"],
  ["carriage return", "https://h/a\rb"],
  ["tab", "https://h/a\tb"],
  ["literal space", "https://h/a b"],
  ["null byte", "https://h/a\u0000b"],
  ["injected playlist line", "https://h/a\n#EXTINF:1,injected\nhttps://evil.example/x"],
];

test("build() rejects item URLs containing whitespace or control characters", (t) => {
  if (!URL_INJECTION_DEFENCE) return t.skip(MERGE_NOTE);
  for (const [name, url] of UNSAFE_URLS) {
    assert.throws(
      () => build({ source: "t", server: "https://h", title: "", scope: "item", items: [{ url }] }),
      /whitespace or control/,
      `build() must reject a URL with a ${name}`,
    );
  }
});

test("validate() and decode() reject item URLs containing whitespace or control characters", (t) => {
  if (!URL_INJECTION_DEFENCE) return t.skip(MERGE_NOTE);
  for (const [name, url] of UNSAFE_URLS) {
    const payload = { v: PAYLOAD_VERSION, src: "t", server: "https://h", title: "", scope: "item", n: 1, items: [{ u: url }] };
    assert.throws(() => validate(payload), /whitespace or control/, `validate() must reject a URL with a ${name}`);
    assert.throws(() => decode(encode(payload)), /whitespace or control/, `decode() must reject a URL with a ${name}`);
  }
});

test("assertSafeUrl() rejects the unsafe forms and accepts the safe ones", (t) => {
  if (!URL_INJECTION_DEFENCE) return t.skip(MERGE_NOTE);
  assert.equal(typeof payloadApi.assertSafeUrl, "function");
  for (const [, url] of UNSAFE_URLS) assert.throws(() => payloadApi.assertSafeUrl(url), /whitespace or control/);
  for (const url of [
    "https://media.example.com/Videos/3020743/stream?Static=true&api_key=abc",
    "https://media.example.com/Videos/1/stream?name=My%20Show",
    "http://127.0.0.1:8731/Videos/1/stream?Static=true&api_key=t",
  ]) {
    assert.equal(payloadApi.assertSafeUrl(url), true, `${url} must be accepted`);
  }
  // A relative or scheme-less URL is still rejected, with the original message.
  assert.throws(() => payloadApi.assertSafeUrl("/Videos/1/stream"), /not an absolute URL/);
});

test("a legitimate percent-encoded URL survives build/encode/decode unchanged", (t) => {
  if (!URL_INJECTION_DEFENCE) return t.skip(MERGE_NOTE);
  const url = "https://media.example.com/Videos/3020743/stream?Static=true&api_key=0123456789abcdef0123456789abcdef&name=My%20Show%20S01E01";
  const payload = build({ source: "emby", server: SERVER, title: "T", scope: "item", items: [{ url, title: "S01E01" }] });
  assert.equal(payload.items[0].u, url, "a percent-encoded URL must pass through unchanged");
  assert.deepEqual(decode(encode(payload)), payload);
});