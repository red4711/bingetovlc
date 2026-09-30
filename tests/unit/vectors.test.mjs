/**
 * Runs tools/vectors/verify.mjs as a child process and independently re-checks
 * the one structural invariant that a user would notice: the M3U has exactly
 * one line per expected playlist line, so no entry is silently swallowed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildM3u } from "../../src/core/m3u.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const vectorsPath = resolve(repo, "tests/fixtures/vectors.json");
const verifyScript = resolve(repo, "tools/vectors/verify.mjs");

const vectorDoc = JSON.parse(readFileSync(vectorsPath, "utf8"));

/** The line count the M3U must have for a payload (mirrors verify.mjs). */
function expectedLineCount(payload) {
  const opts = payload.opts || {};
  const perItemOptions = ["cache", "referrer", "ua"].filter((key) => opts[key]).length;
  return 1 + (payload.title ? 1 : 0) + payload.items.length * (2 + perItemOptions);
}

test("tools/vectors/verify.mjs exits 0", () => {
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [verifyScript], { cwd: repo, encoding: "utf8" });
  } catch (error) {
    const details = [error.stdout, error.stderr].filter(Boolean).join("\n");
    assert.fail(`tools/vectors/verify.mjs failed (exit ${error.status}):\n${details}`);
  }
  assert.match(stdout, /^ok: \d+ checks across \d+ vectors/m, "verify.mjs must report a clean run");
});

test("every vector's M3U line count matches the declared shape", () => {
  assert.ok(vectorDoc.vectors.length > 0, "vectors.json has no vectors");
  for (const vector of vectorDoc.vectors) {
    const { name, payload } = vector;
    const lines = buildM3u(payload).trimEnd().split("\n");
    const expected = expectedLineCount(payload);
    assert.equal(lines.length, expected, `${name}: expected ${expected} M3U lines, got ${lines.length}`);

    // Sanity: the recurrence really does describe the file, per line kind.
    const header = lines.filter((line) => line === "#EXTM3U").length;
    const playlists = lines.filter((line) => line.startsWith("#PLAYLIST:")).length;
    const extinfs = lines.filter((line) => line.startsWith("#EXTINF:")).length;
    const options = lines.filter((line) => line.startsWith("#EXTVLCOPT:")).length;
    const urls = lines.filter((line) => !line.startsWith("#")).length;
    assert.equal(header, 1, `${name}: exactly one #EXTM3U`);
    assert.equal(playlists, payload.title ? 1 : 0, `${name}: #PLAYLIST only when a title exists`);
    assert.equal(extinfs, payload.items.length, `${name}: one #EXTINF per item`);
    assert.equal(urls, payload.items.length, `${name}: one URL per item`);
    assert.equal(
      header + playlists + extinfs + options + urls,
      lines.length,
      `${name}: every line must be one of header/playlist/extinf/opt/url`,
    );
  }
});

test("the golden vectors are unmodified by a round trip through the codec", () => {
  for (const vector of vectorDoc.vectors) {
    assert.equal(buildM3u(vector.payload), vector.m3u, `${vector.name}: M3U drifted`);
    assert.match(vector.base64, /^[A-Za-z0-9_-]+$/, `${vector.name}: base64 must stay URI-safe and unpadded`);
  }
});