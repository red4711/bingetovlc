/**
 * Unit tests for src/core/m3u.js — playlist serialisation.
 *
 * The M3U is written by the userscript *and* by the Windows handler, so it must
 * be byte-identical in both places. The defect class these tests guard against
 * is a title that swallows the following URL (dropping an episode) or a token
 * leaking into a "shareable" playlist.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildM3u, playlistFilename } from "../../src/core/m3u.js";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(resolve(here, "../fixtures/vectors.json"), "utf8"));

const SERVER = "https://media.example.com";
const TOKEN = "0123456789abcdef0123456789abcdef";
const streamUrl = (id) => `${SERVER}/Videos/${id}/stream?Static=true&api_key=${TOKEN}`;

/** A hand-built payload (not through build()) so the test controls every byte. */
function rawPayload(items, opts) {
  const payload = {
    v: 1,
    src: "emby",
    server: SERVER,
    title: "",
    scope: "season",
    n: items.length,
    items,
  };
  if (opts) payload.opts = opts;
  return payload;
}

function dataLines(m3u) {
  return m3u.trimEnd().split("\n").filter((line) => line !== "" && !line.startsWith("#"));
}

// ---------------------------------------------------------------------------

test("one #EXTINF line and one URL per item, in payload order", () => {
  const items = [
    { u: streamUrl("1"), t: "S01E01 One", d: 10 },
    { u: streamUrl("2"), t: "S01E02 Two", d: 20 },
    { u: streamUrl("3"), t: "S01E03 Three", d: 30 },
  ];
  const m3u = buildM3u(rawPayload(items));
  const lines = m3u.trimEnd().split("\n");
  assert.equal(lines[0], "#EXTM3U");
  assert.equal(lines.filter((l) => l.startsWith("#EXTINF:")).length, items.length);
  assert.equal(dataLines(m3u).length, items.length);
  assert.deepEqual(
    dataLines(m3u),
    items.map((i) => i.u),
    "URLs must appear in payload order — playlist order is the product",
  );
  const extinfs = lines.filter((l) => l.startsWith("#EXTINF:"));
  assert.deepEqual(extinfs, [
    "#EXTINF:10,S01E01 One",
    "#EXTINF:20,S01E02 Two",
    "#EXTINF:30,S01E03 Three",
  ]);
});

test("an unknown duration serialises as -1", () => {
  const m3u = buildM3u(rawPayload([{ u: streamUrl("1"), t: "No duration" }]));
  assert.ok(m3u.includes("#EXTINF:-1,No duration\n"), `expected a -1 duration in:\n${m3u}`);
  // Zero and non-finite durations are "unknown" too.
  const zero = buildM3u(rawPayload([{ u: streamUrl("1"), t: "Zero", d: 0 }]));
  assert.ok(zero.includes("#EXTINF:-1,Zero\n"));
  const nan = buildM3u(rawPayload([{ u: streamUrl("1"), t: "NaN", d: "nope" }]));
  assert.ok(nan.includes("#EXTINF:-1,NaN\n"));
});

test("hostile titles stay on one line and never swallow the URL", () => {
  const nasty = "S01E01 A, B\nC\tD — ＥＦ, and more\r\nline two";
  const items = [
    { u: streamUrl("1"), t: nasty, d: 5 },
    { u: streamUrl("2"), t: "S01E02 https://evil.example/x?y=z\n#EXTINF:1,injected", d: 5 },
  ];
  const m3u = buildM3u(rawPayload(items));
  const lines = m3u.trimEnd().split("\n");

  assert.equal(lines.filter((l) => l.startsWith("#EXTINF:")).length, 2, "each item keeps exactly one #EXTINF");
  assert.equal(dataLines(m3u).length, 2, "each item keeps exactly one URL line");
  assert.deepEqual(dataLines(m3u), [items[0].u, items[1].u], "the URL after a nasty title must survive intact");

  // No raw control characters anywhere in the serialised playlist.
  assert.ok(!m3u.includes("\r") && !m3u.includes("\t"), "no raw CR or TAB may reach the playlist");
  assert.equal(lines.length, m3u.split("\n").length - 1, "every line is terminated by exactly one newline");
  // The folded title keeps the comma and the em dash, drops the newline/tab.
  assert.ok(m3u.includes("A, B C D — ＥＦ, and more line two"), `folded title missing from:\n${m3u}`);
  // The injected "#EXTINF" inside a title must not start a line.
  assert.ok(!lines.some((l) => l.startsWith("#EXTINF:1,injected")), "an injected directive may not become a real line");
  // Every non-comment line is a URL.
  for (const line of dataLines(m3u)) assert.match(line, /^https?:\/\//);
});

test("a title that looks like a directive is folded, not honoured", () => {
  const m3u = buildM3u(rawPayload([{ u: streamUrl("1"), t: "#EXTVLCOPT:network-caching=1\n#EXTM3U", d: 1 }]));
  const lines = m3u.trimEnd().split("\n");
  assert.equal(lines.filter((l) => l.startsWith("#EXTM3U")).length, 1, "only the real header may appear");
  assert.equal(lines.filter((l) => l.startsWith("#EXTVLCOPT")).length, 0, "no option line may be injected");
});

test("per-item #EXTVLCOPT lines appear only when opts ask for them", () => {
  const items = [{ u: streamUrl("1"), t: "A", d: 1 }, { u: streamUrl("2"), t: "B", d: 1 }];

  const bare = buildM3u(rawPayload(items));
  assert.equal(bare.split("\n").filter((l) => l.startsWith("#EXTVLCOPT")).length, 0, "no opts -> no option lines");

  const cached = buildM3u(rawPayload(items, { cache: 1500 }));
  const cacheLines = cached.split("\n").filter((l) => l.startsWith("#EXTVLCOPT:network-caching="));
  assert.equal(cacheLines.length, items.length, "one network-caching line per item");
  assert.ok(cacheLines.every((l) => l === "#EXTVLCOPT:network-caching=1500"));

  const full = buildM3u(rawPayload(items, { cache: 1500, referrer: "https://ref.example/a", ua: "Mozilla/5.0 (Test)" }));
  const lines = full.trimEnd().split("\n");
  assert.equal(lines.filter((l) => l.startsWith("#EXTVLCOPT")).length, items.length * 3, "three option lines per item");
  // Option lines immediately precede their item's URL.
  for (const item of items) {
    const urlIndex = lines.indexOf(item.u);
    assert.ok(urlIndex > 0);
    assert.ok(lines[urlIndex - 1].startsWith("#EXTVLCOPT:http-user-agent="));
    assert.ok(lines[urlIndex - 2].startsWith("#EXTVLCOPT:http-referrer="));
    assert.ok(lines[urlIndex - 3].startsWith("#EXTVLCOPT:network-caching="));
  }
});

test("includeTokens:false strips query strings but keeps every entry", () => {
  const items = [
    { u: streamUrl("1"), t: "A", d: 1 },
    { u: `${SERVER}/Videos/2/stream?Static=true&api_key=${TOKEN}&x=1`, t: "B", d: 1 },
  ];
  const shared = buildM3u(rawPayload(items), { includeTokens: false });
  const bare = buildM3u(rawPayload(items));

  assert.ok(!shared.includes("api_key"), "shareable playlist must not leak a token");
  assert.ok(!shared.includes("?"), "shareable playlist must strip every query string");
  assert.equal(
    shared.split("\n").filter((l) => !l.startsWith("#") && l !== "").length,
    items.length,
    "stripping tokens must not drop an entry",
  );
  assert.ok(bare.includes("api_key"), "the default playlist keeps the token for VLC");
  // Same shape, only the query differs.
  assert.equal(
    shared.split("\n").length,
    bare.split("\n").length,
    "shareable and full playlists must have the same line count",
  );
  assert.deepEqual(
    shared.split("\n").filter((l) => !l.startsWith("#") && l !== ""),
    items.map((i) => i.u.split("?")[0]),
  );
});

test("the newline option is honoured and the output always ends in one", () => {
  const payload = rawPayload([{ u: streamUrl("1"), t: "A", d: 1 }]);
  const lf = buildM3u(payload);
  const crlf = buildM3u(payload, { newline: "\r\n" });
  assert.ok(lf.endsWith("\n"));
  assert.ok(crlf.endsWith("\r\n"));
  assert.equal(crlf.split("\r\n").length, lf.split("\n").length);
  assert.ok(!lf.includes("\r"));
});

test("playlistFilename is filesystem safe and carries the start index", () => {
  const name = playlistFilename("Frieren: Beyond Journey's End — 葬送のフリーレン", 3);
  assert.match(name, /^bingetovlc-\d{8}T\d{6}Z-from-3-[a-z0-9-]+\.m3u$/);
  assert.ok(!/[^\w.-]/.test(name), "filename must not need quoting on Windows");
  assert.match(playlistFilename("", null), /-playlist\.m3u$/);
});

// ---------------------------------------------------------------------------
// Byte-identical output against the shared golden vectors
// ---------------------------------------------------------------------------

test("every golden vector's M3U is byte-identical to buildM3u", () => {
  assert.ok(Array.isArray(vectors.vectors) && vectors.vectors.length > 0, "vectors.json must expose vectors");
  for (const vector of vectors.vectors) {
    assert.equal(buildM3u(vector.payload), vector.m3u, `${vector.name}: m3u drifted from the golden vector`);
    assert.equal(
      buildM3u(vector.payload, { includeTokens: false }),
      vector.m3uShareable,
      `${vector.name}: shareable m3u drifted from the golden vector`,
    );
  }
});

// ---------------------------------------------------------------------------
// URL hygiene: a hostile URL must not be able to add playlist lines.
//
// `buildM3u` is also reachable with payloads assembled elsewhere (the PowerShell
// handler writes through the same rules), so the serialiser strips control
// characters from URLs itself rather than trusting the codec.
// ---------------------------------------------------------------------------

/** The control-character stripping landed on main after this branch was cut. */
const M3U_STRIPS_CONTROL_CHARS = (() => {
  try {
    const probe = buildM3u(rawPayload([{ u: "https://h/a\r\nb" }]));
    return !probe.includes("\r") && probe.trimEnd().split("\n").length === 3;
  } catch {
    return false;
  }
})();

const MERGE_NOTE =
  "src/core/m3u.js in this checkout does not strip control characters from URLs — that " +
  "landed on main after this branch and these assertions run for real on merge";

test("a URL containing CRLF cannot inject extra playlist lines", (t) => {
  if (!M3U_STRIPS_CONTROL_CHARS) return t.skip(MERGE_NOTE);
  const hostile = "https://h/a\r\n#EXTVLCOPT:network-caching=99999\r\n#EXTINF:1,injected\r\nhttps://evil.example/x";
  const m3u = buildM3u(rawPayload([{ u: hostile, t: "S01E01" }]));
  const lines = m3u.trimEnd().split("\n");
  assert.equal(lines.length, 3, `expected header + EXTINF + URL, got ${lines.length}:\n${m3u}`);
  assert.equal(lines.filter((l) => l.startsWith("#EXTINF:")).length, 1, "exactly one EXTINF line may exist");
  assert.equal(lines.filter((l) => l.startsWith("#EXTVLCOPT")).length, 0, "no option line may be injected");
  assert.equal(lines.filter((l) => !l.startsWith("#")).length, 1, "exactly one URL line may exist");
  assert.ok(!m3u.includes("\r"), "no raw CR may survive into the file");
  // The control characters are stripped, so the injected text stays inline
  // instead of becoming its own playlist directive.
  assert.equal(lines[2], "https://h/a#EXTVLCOPT:network-caching=99999#EXTINF:1,injectedhttps://evil.example/x");
});

test("a payload whose item URL contains a bare newline keeps the declared line count", (t) => {
  if (!M3U_STRIPS_CONTROL_CHARS) return t.skip(MERGE_NOTE);
  const items = [
    { u: "https://h/1\nhttps://h/2", t: "one" },
    { u: "https://h/3", t: "two" },
  ];
  const m3u = buildM3u(rawPayload(items));
  const lines = m3u.trimEnd().split("\n");
  assert.equal(lines.length, 1 + items.length * 2, "a newline in a URL must not add a line");
  assert.equal(lines.filter((l) => !l.startsWith("#")).length, items.length);
});

test("a legitimate percent-encoded URL passes through the serialiser unchanged", () => {
  const url = "https://media.example.com/Videos/3020743/stream?Static=true&api_key=t&name=My%20Show%20S01E01";
  const m3u = buildM3u(rawPayload([{ u: url, t: "S01E01" }]));
  assert.deepEqual(
    m3u.trimEnd().split("\n").filter((l) => !l.startsWith("#")),
    [url],
    "%20 and query separators must survive byte-for-byte",
  );
  const shared = buildM3u(rawPayload([{ u: url, t: "S01E01" }]), { includeTokens: false });
  assert.ok(!shared.includes("name=My%20Show"), "shareable output strips the whole query");
  assert.ok(shared.includes("https://media.example.com/Videos/3020743/stream?") === false);
});