/**
 * node:test wrapper around the end-to-end runner, so `node --test tests/e2e/`
 * (and `npm run test:e2e`) exercise the real Chrome + fake Emby flow.
 *
 * Skips loudly — and exits 0 — when there is no Chromium binary or no built
 * userscript to load, because neither is a failure of this repository's source.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { runE2e, writeArtifacts } from "./run-e2e.mjs";

test("end-to-end: fake Emby + headless Chrome hand off the right playlist", { timeout: 120000 }, async (t) => {
  const result = await runE2e({ quiet: false });

  if (result.skipped) {
    console.log(`SKIP: ${result.reason}`);
    writeArtifacts({ skipped: true, reason: result.reason });
    t.skip(result.reason);
    return;
  }

  const artifact = writeArtifacts(result);
  if (artifact) console.log(`artifacts: ${artifact}`);

  assert.equal(
    result.failures.length,
    0,
    `${result.failures.length} of ${result.assertions.length} e2e assertions failed:\n` +
      result.failures.map((f) => `  - ${f.name}${f.detail ? ` (${f.detail})` : ""}`).join("\n"),
  );
});