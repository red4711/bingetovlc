# Contributing to bingetovlc

Thanks for helping. This project has one job — hand the *original* file to VLC,
in the right order, every time — and the process below exists to keep that true
across machines. Read [`docs/SPEC.md`](docs/SPEC.md) first: it is the frozen
interface contract, and this document is the workflow around it.

---

## Development setup

**No npm dependencies.** `package.json` declares none, and none should be added.
The toolchain is Node and Python only:

| Requirement | Version |
|---|---|
| Node | `>=22` (declared in `package.json` `engines`) |
| Python | 3.x (`python3`) |
| Windows + PowerShell | only needed to exercise the handler locally |

```bash
git clone https://github.com/red4711/bingetovlc.git
cd bingetovlc
```

Nothing to install. The scripts:

| Command | What it does |
|---|---|
| `python3 tools/build.py` | concatenates `src/` into the single-file `dist/bingetovlc.user.js` (Tampermonkey needs one file) |
| `npm run build` | alias for `python3 tools/build.py` |
| `node --test "tests/unit/**/*.test.mjs"` | unit tests |
| `npm test` | alias for the unit glob above |
| `node --test "tests/e2e/**/*.test.mjs"` | end-to-end: fake Emby server plus a real Chrome |
| `npm run vectors` | regenerate `tests/fixtures/vectors.json` |
| `npm run vectors:verify` | check the committed vectors against the JavaScript |
| `npm run test:e2e` | alias for the e2e run |
| `npm run vectors` | regenerates `tests/fixtures/vectors.json` |
| `node tools/vectors/verify.mjs` | checks `vectors.json` against the JavaScript implementation |

`src/` is authored as small ES modules and concatenated into
`dist/bingetovlc.user.js`; every module must be importable by Node **with no DOM
present**, which is how the unit tests exercise it (see `SPEC.md` §5).

---

## The golden vectors

`tests/fixtures/vectors.json` is the conformance contract. Each vector is a
`{ payload, base64, uri, m3u, … }` tuple, generated from realistic shapes — a
28-episode season, ~100-character `/Videos/{id}/stream` URLs, unicode titles.

### Why it must never be hand-edited

Three **independent implementations** must produce identical bytes for these
vectors:

1. **JavaScript** — `src/core/*`, asserted by `node --test`.
2. **Python** — `tools/playlist/conformance.py`, the reference decoder.
3. **PowerShell** — `tools/windows/bingetovlc-handler.ps1 -SelfTest`, asserted
   on `windows-latest` in CI.

The file is *generated*, not authored. If you edit it by hand, you are not
creating a contract, you are writing down the answer you happen to expect — and
the Python and PowerShell implementations will then be asserted against a
fiction. Regenerate it instead:

```bash
npm run vectors        # node tools/vectors/generate.mjs
node tools/vectors/verify.mjs
```

`tools/vectors/generate.mjs` derives every field (`base64`, `uri`, `m3u`,
`m3uShareable`, `handoff`, `uriLength`, `expectedIds`) from the JavaScript code.
`tools/vectors/verify.mjs` then asserts the invariants that matter to a user:
the payload round-trips, encoding is byte-stable, the M3U has one `#EXTINF` and
one URL per item, the **shareable M3U never leaks a token**, the declared queue
order and de-duplication hold, and a 90-episode series is *not* attempted as a
URI.

### The rule that keeps the wrong-episode bug from shipping

The JavaScript, the Python reference decoder and the PowerShell handler **must
agree byte-for-byte** on every vector. Divergence between any two is a release
blocker. The bug class this catches is "the playlist plays the wrong episodes on
someone else's machine" — a corruption that is invisible on the developer's box
and only appears in the handoff on a user's.

If you change anything that affects the payload or the M3U — the codec, the key
names, the serialiser, the ordering — expect `vectors.json` to change. That is a
**spec change**: bump `PAYLOAD_VERSION` when the format changes, update
`docs/SPEC.md`, then regenerate.

---

## Tests

* Unit tests run with `node --test` and **no DOM**. Core modules must not reach
  for `document`, `window` or `btoa`; the codec is pure JS on purpose (see
  `src/core/payload.js`).
* End-to-end tests (`tests/e2e/`) run a fake Emby server plus a real Chrome.
* Add a test with every behaviour change. Ordering/scope changes need a vector;
  parser/serialiser changes need a vector and a unit test.

---

## Pull request expectations

A pull request should be reviewable without the reviewer running it, and testable
by whoever picks it up next.

- [ ] **Tests pass**: `node --test "tests/unit/**/*.test.mjs"`, and `node --test "tests/e2e/**/*.test.mjs"` when the
      change touches the handoff.
- [ ] **Vectors regenerated** if any interface-visible output changed, and
      `node tools/vectors/verify.mjs` is green.
- [ ] **`docs/SPEC.md` updated and `PAYLOAD_VERSION` bumped** if the payload or
      M3U format changed.
- [ ] **Troubleshooting updated**: any new failure mode you discovered belongs in
      [`docs/troubleshooting.md`](docs/troubleshooting.md), even if you also
      fixed it — the next person will hit the old build.
- [ ] **`docs/how-it-works.md` updated** for any new behaviour, with the evidence
      behind it. Numbers and API behaviour must be observed, not assumed; mark
      anything unverified with *untested* or *not verified*.
- [ ] **Adapter changes** follow [`docs/adapters.md`](docs/adapters.md), including
      its checklist.
- [ ] Do not edit `README.md` or `docs/SPEC.md` gratuitously. `SPEC.md` changes
      are contract changes and need the version bump above.

---

## Commit messages

Imperative mood, and explain the **why**. The subject line says what the change
does; the body says why it was necessary — usually a user-visible symptom.

```
fix: drop Virtual items before building the queue

A season listing includes announced-but-not-downloaded episodes. Their
stream URL returns 404, so a whole-season binge stalled part-way through.
Filter on LocationType and empty Path in orderItems.
```

```
refactor: build the stream URL instead of reading DirectStreamUrl

A live 4.10 server returned DirectStreamUrl: None for both an episode and
a movie, so there was nothing to play. Build the URL by hand; it returns
the original file byte-for-byte (206 + Content-Range + EBML magic).
```

```
docs: record the Series/Season PlaybackInfo 500

Queueing a whole show cannot ask the series for a stream: the server
replies 500 (Unable to cast Series to IHasMediaSources). Document the
branch-before-you-ask rule.
```

Style notes:

* Imperative subject (`fix:`, `feat:`, `docs:`, `refactor:`, `test:`,
  `chore:`), lower case, no trailing period.
* No "this commit", "I", or a restatement of the diff. Say why.
* If the change is a spec change, say so in the body.

---

## Reporting a bug

See [`docs/troubleshooting.md`](docs/troubleshooting.md) §13 for what to include
(versions, page type, handoff path, Diagnostics output, handler log, and a
**token-stripped** playlist). For a security issue, do not open a public issue —
follow [`SECURITY.md`](SECURITY.md).

## License

Contributions are accepted under the MIT license — see [`LICENSE`](LICENSE).

## Local test hygiene

The end-to-end suite binds two ports: `8731` for the fake Emby server and `9331` for
Chromium's DevTools endpoint. If a run is interrupted, the next one fails immediately
with `port 8731 is already in use` even though the suite itself is fine. Clear the
leftovers and re-run:

```bash
for p in 8731 9331; do
  pid=$(ss -ltnp 2>/dev/null | grep ":$p " | sed -E 's/.*pid=([0-9]+).*/\1/' | head -1)
  [ -n "$pid" ] && kill "$pid"
done
node --test "tests/e2e/**/*.test.mjs"
```

The suite also refuses to run silently against a stale build: `tests/e2e/run-e2e.mjs`
copies `dist/bingetovlc.user.js` into a temporary served directory at the start, and
skips with a clear message when the build is missing. Run `python3 tools/build.py`
first after touching `src/`.
