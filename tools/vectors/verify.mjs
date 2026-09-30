#!/usr/bin/env node
/**
 * Verify tests/fixtures/vectors.json against the JavaScript implementation.
 *
 * This is the gate CI runs on every platform. It checks the invariants that
 * actually matter to a user, not just "the code ran":
 *
 *   - every vector's base64 decodes back to an identical payload
 *   - re-encoding is byte-stable (so the Python and PowerShell implementations
 *     have exactly one correct answer to match)
 *   - the M3U has one #EXTINF and exactly one URL per item, plus the per-item
 *     #EXTVLCOPT lines the payload asks for
 *   - the shareable M3U never leaks a token
 *   - the queue order, the de-duplication and the Virtual-item filtering are
 *     the ones the vector declares
 *   - the handoff decision matches what the vector promises (a 90 episode
 *     series must NOT be attempted as a URI)
 *
 * Run: node tools/vectors/verify.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { decode, encode, launchUri, chooseHandoff, resolveItemUrl } from "../../src/core/payload.js";
import { buildM3u } from "../../src/core/m3u.js";

const here = dirname(fileURLToPath(import.meta.url));
const vectorsPath = resolve(here, "../../tests/fixtures/vectors.json");
const doc = JSON.parse(readFileSync(vectorsPath, "utf8"));

let checks = 0;
const failures = [];

function assert(condition, message) {
  checks++;
  if (!condition) failures.push(message);
}

function expectedM3uLines(payload) {
  const opts = payload.opts || {};
  const perItemOptions = ["cache", "referrer", "ua"].filter((key) => opts[key]).length;
  return 1 + (payload.title ? 1 : 0) + payload.items.length * (2 + perItemOptions);
}

for (const vector of doc.vectors) {
  const { name, payload, base64, uri, m3u, m3uShareable } = vector;

  assert(decode(base64).items.length === payload.items.length, `${name}: base64 does not decode to the same item count`);
  assert(JSON.stringify(decode(base64)) === JSON.stringify(payload), `${name}: decoded payload differs from the source payload`);
  assert(encode(decode(base64)) === base64, `${name}: encoding is not byte-stable`);
  assert(launchUri(payload, "vlc") === uri, `${name}: launchUri is not byte-stable`);
  assert(/^[A-Za-z0-9_-]+$/.test(base64), `${name}: base64url left the URI-safe alphabet`);
  assert(!base64.includes("="), `${name}: base64url should be unpadded`);

  const lines = m3u.trimEnd().split("\n");
  assert(lines[0] === "#EXTM3U", `${name}: m3u must start with #EXTM3U`);
  assert(
    lines.length === expectedM3uLines(payload),
    `${name}: m3u has ${lines.length} lines, expected ${expectedM3uLines(payload)}`,
  );
  assert(
    lines.filter((line) => line.startsWith("#EXTINF:")).length === payload.items.length,
    `${name}: one #EXTINF per item expected`,
  );
  const urls = lines.filter((line) => !line.startsWith("#"));
  assert(urls.length === payload.items.length, `${name}: one URL per item expected`);
  assert(
    urls.every((url, index) => url === resolveItemUrl(payload, payload.items[index])),
    `${name}: URLs must appear in payload order (playlist order is the product)`,
  );
  assert(!m3uShareable.includes("api_key"), `${name}: shareable m3u leaked a token`);
  assert(!m3uShareable.includes("token="), `${name}: shareable m3u leaked a query token`);
  assert(
    m3uShareable.split("\n").filter((line) => !line.startsWith("#") && line !== "").length === payload.items.length,
    `${name}: shareable m3u changed the number of entries`,
  );

  if (vector.expectedIds) {
    const ids = urls.map((url) => (url.match(/Videos\/([^/]+)\/stream/) || [])[1]);
    assert(
      JSON.stringify(ids) === JSON.stringify(vector.expectedIds),
      `${name}: queue order is ${ids.join(",")} but the vector declares ${vector.expectedIds.join(",")}`,
    );
    assert(new Set(ids).size === ids.length, `${name}: duplicate items survived into the queue`);
  }

  if (vector.handoff) {
    const decision = chooseHandoff(payload, "vlc");
    assert(decision.mode === vector.handoff.mode, `${name}: handoff is ${decision.mode}, expected ${vector.handoff.mode}`);
    if (vector.handoff.reason) {
      assert(decision.reason === vector.handoff.reason, `${name}: handoff reason is ${decision.reason}`);
    }
  }

  if (vector.uriLength !== undefined) {
    assert(uri.length === vector.uriLength, `${name}: uri length drifted (${uri.length} != ${vector.uriLength})`);
  }
}

if (failures.length) {
  console.error(`FAIL: ${failures.length} of ${checks} checks failed`);
  for (const failure of failures) console.error("  - " + failure);
  process.exit(1);
}

console.log(`ok: ${checks} checks across ${doc.vectors.length} vectors`);
for (const vector of doc.vectors) {
  const decision = chooseHandoff(vector.payload, "vlc");
  console.log(
    `  ${vector.name.padEnd(24)} items=${String(vector.payload.items.length).padStart(2)} uri=${String(vector.uri.length).padStart(6)}B handoff=${decision.mode}${decision.reason ? "(" + decision.reason + ")" : ""}`,
  );
}
