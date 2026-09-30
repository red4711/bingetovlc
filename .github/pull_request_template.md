# Pull request

## What this changes and why

<!-- Imperative summary, then the reason. What user-visible symptom does it fix or add? -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Adapter (new or changed source)
- [ ] Documentation
- [ ] Refactor / internal

## Interface impact

- [ ] This changes the payload format or the M3U rules → `PAYLOAD_VERSION` bumped and `docs/SPEC.md` updated
- [ ] This changes behaviour only → no version bump
- [ ] This changes no interfaces

## Evidence

<!-- For behaviour changes: what did you actually observe? Paste real output, not a summary.
     For API behaviour, state the server version. Mark anything unverified explicitly. -->

```
# e.g. handler -SelfTest output, or a byte-range probe
```

## Checklist

- [ ] `node --test tests/` passes
- [ ] `node --test tests/e2e/` passes (if the handoff changed)
- [ ] `npm run vectors` regenerated `tests/fixtures/vectors.json` if any interface-visible output changed, and `node tools/vectors/verify.mjs` is green
- [ ] `tests/fixtures/vectors.json` was **not** hand-edited
- [ ] JS, Python reference decoder and PowerShell handler agree on every vector
- [ ] New failure modes documented in `docs/troubleshooting.md`
- [ ] New behaviour and its evidence documented in `docs/how-it-works.md`
- [ ] Adapter changes follow `docs/adapters.md` (including its checklist)
- [ ] No npm dependencies added
- [ ] No token appears anywhere in this PR, including test fixtures and logs

## Notes for the reviewer

<!-- Anything uncertain, assumed, or deliberately left out. Say "untested" where true. -->