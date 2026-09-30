# Writing an adapter

An **adapter** turns "the page the user is looking at" into "the items VLC
should play". The Emby adapter is the reference implementation; a generic HLS /
DOM adapter exists alongside it as the experimental path for non-Emby pages.
This document is what you need to add a third.

Read [`SPEC.md`](SPEC.md) §5 (module layout, frozen signatures) and
[`how-it-works.md`](how-it-works.md) §7 (ordering and playability) first —
everything below is a consequence of those two.

---

## 1. Where adapters live

| Adapter | File (per [`SPEC.md`](SPEC.md) §5) | Source |
|---|---|---|
| Emby | `src/core/emby/adapter.js` | `src` = `"emby"` |
| Generic HLS / DOM (experimental) | `src/core/generic/adapter.js` | `src` = `"generic"` |

The two share the core modules:

* `src/core/payload.js` — version, base64url codec, `build`, `launchUri`,
  `estimatedUriLength`, `chooseHandoff`.
* `src/core/m3u.js` — M3U serialisation.
* `src/core/ordering.js` — `orderItems`, `scopeItems`, `episodeLabel`,
  `durationSeconds`.

An adapter does **not** encode, build a URI, write an `.m3u`, touch the registry,
or launch VLC. It produces a payload object (or the arguments to `build()`);
the core and the Windows handler do the rest.

---

## 2. What an adapter must return

An adapter's job is to feed `build()` and `scopeItems()`. Its output is:

* every item it wants queued, as `{ url, title, duration }` (long keys) or
  `{ u, t, d }` (short keys — `build()` normalises either spelling);
* the queue metadata: `source` (a short `src` tag), `server`, `title`, `scope`;
* optional `opts` (`fs`, `one`, `exit`, `cache`, `referrer`, `ua`, `start`).

`build()` — frozen in [`SPEC.md`](SPEC.md) §5 — produces the payload:

```js
build({ source, server, title, scope, items, opts }) -> payload object
```

Per item, `build()` requires an absolute URL and accepts an optional title and
duration. It normalises titles to a single line and durations to non-negative
integers. A payload with no items throws.

`scopeItems()` — also frozen — maps page context to a queue:

```js
scopeItems({ item, itemType, children, scope, startId }) -> { items, title, scope }
```

An adapter that is not Emby does not have to use `scopeItems`, but if it has a
notion of "container + children" it should, because that is where ordering and
deduplication live.

### An adapter must never

* emit a relative URL — `validate()` rejects anything that is not
  `scheme://…` (an absolute URL);
* emit an item it has not confirmed is playable (§3);
* put a token anywhere except the item URL — the token belongs in the query
  string, not in a header the handler cannot set for Emby (see
  [`how-it-works.md`](how-it-works.md) §1.3);
* reorder items after `orderItems()` has run.

---

## 3. Ordering and playability rules

Every adapter, Emby or not, must respect these. They exist because the product
promise is "queue the whole season, in the right order" — not "queue whatever
the API returned".

Run container children through `orderItems()` before building the payload. It
applies, in priority order:

1. **Sort** by `(ParentIndexNumber, IndexNumber)` — season, then episode.
2. **Fall back** to `AiredEpisodeNumber`, then the numeric `Id`, so items
   missing index metadata still get a stable position.
3. **Deduplicate** by `Id`, because a season query and a series query can
   overlap.
4. **Drop unplayable items** via `isPlayable()`.

### 3.1 The playability rules (do not skip these)

| Condition | Why it must be dropped |
|---|---|
| `LocationType == "Virtual"` | The item is announced (metadata exists) but has no file on disk. Requesting its stream produces `500`/`404` from Emby. |
| `Path` is empty | There is no file behind the item. |
| a URL that is not absolute | `validate()` will reject the whole payload; one bad item loses the whole queue. |

An adapter for a non-Emby source still has the same two failure shapes in some
form: "the entry exists in the catalogue but no media is reachable", and "the
media record has no source". Filter those out rather than queueing a URL that
will stall VLC mid-binge. The observable Emby symptom is documented in
[`troubleshooting.md`](troubleshooting.md) §4.

---

## 4. The generic adapter's extra options

The Emby adapter needs no header options: the token is in the URL. A generic
source may be referrer-locked or user-agent-gated, so the generic adapter is the
one that sets:

| `opts` key | Emitted as (per [`SPEC.md`](SPEC.md) §3) |
|---|---|
| `cache` | `#EXTVLCOPT:network-caching=<ms>` |
| `referrer` | `#EXTVLCOPT:http-referrer=<value>` |
| `ua` | `#EXTVLCOPT:http-user-agent=<value>` |

Only set these when the source actually requires them. Header options that are
not needed are noise in the playlist, and `#EXTVLCOPT` lines are written verbatim
into a text file.

For an HLS source (`…/master.m3u8`), the item URL is the manifest URL and VLC
handles the rest. Set `cache` if the source is jittery.

---

## 5. Detection, not assumption

The Emby adapter detects the web client at runtime rather than assuming a script
path or a global object name, because at least two client generations exist and
serve different files. See [`how-it-works.md`](how-it-works.md) §10 — that
section also records the one part of this design that is **not verified** (when
the `ApiClient` global becomes available). A new adapter should follow the same
principle: probe for what you need, do not assume a fixed layout, and document
what you were unable to verify.

---

## 6. Checklist for contributing an adapter

- [ ] New module under `src/core/<source>/adapter.js`; `src` tag is a short
      lowercase string (`"emby"`, `"generic"`, your source).
- [ ] Imports from `src/core/payload.js`, `src/core/m3u.js`,
      `src/core/ordering.js`; does not reimplement the codec or the serialiser.
- [ ] Calls `build({ source, server, title, scope, items, opts })`; does not
      encode or build a URI itself.
- [ ] Sends container children through `orderItems()`.
- [ ] Drops `LocationType == "Virtual"`, empty-`Path` and non-absolute-URL items.
- [ ] Emits only absolute `http(s)` (or other scheme) item URLs.
- [ ] Sets `opts.cache` / `referrer` / `ua` only when the source needs them.
- [ ] Detects page/client shape at runtime; no hard-coded paths or globals.
- [ ] Adds at least one conformance vector for the new source — see
      [`../CONTRIBUTING.md`](../CONTRIBUTING.md) and `SPEC.md` §7. Run
      `npm run vectors` to regenerate; **never hand-edit**
      `tests/fixtures/vectors.json`.
- [ ] Unit tests import the adapter **with no DOM present** (that is how the
      core is exercised; see `SPEC.md` §5).
- [ ] Documents any behaviour you could not verify, using the words *untested*
      or *not verified*.
- [ ] Cross-links any new user-facing behaviour into
      [`how-it-works.md`](how-it-works.md) and
      [`troubleshooting.md`](troubleshooting.md).

---

## Related documents

* [`SPEC.md`](SPEC.md) — module layout, frozen signatures, payload and M3U rules.
* [`how-it-works.md`](how-it-works.md) — the API findings an Emby adapter relies
  on.
* [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — build, test and vector workflow.
* [`troubleshooting.md`](troubleshooting.md) — the failure modes these rules
  prevent.