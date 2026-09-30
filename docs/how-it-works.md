# How bingetovlc works

This document is the engineering story behind every design decision in the
project. Nothing here is asserted without the observation that forced it. Where
an observation is missing — where a behaviour has not been tested against a real
server — this document says so.

The interface contract itself is in [`SPEC.md`](SPEC.md). The user-facing
overview is in [`../README.md`](../README.md). If this document and `SPEC.md`
disagree about an interface, `SPEC.md` wins and this file is a bug.

All observations below were made with real requests against a live Emby
**4.10.0.40** server (the project owner's server is named *Sayuri*), unless a
line is explicitly marked **not verified**.

---

## 1. The one URL that matters

Every Emby item that has a file on disk exposes a file endpoint that bypasses
the streaming pipeline:

```
GET {server}/Videos/{itemId}/stream?Static=true&api_key={token}
```

With `Static=true`, Emby serves the container as it sits on disk. That is what
makes the project possible: no transcode, no remux, no server CPU per viewer.

### 1.1 The byte-exactness proof

A single range request is enough to prove that what comes back is the original
file and not a transcode. The probe below requested the first 16 KiB:

| Field | Observed value |
|---|---|
| Request | `GET /Videos/3020743/stream?Static=true&api_key=…` with `Range: bytes=0-16383` |
| Status | `206 Partial Content` |
| `Content-Type` | `video/x-matroska` |
| `Content-Range` | `bytes 0-16383/3500835068` |
| `Accept-Ranges` | `bytes` |
| First four bytes of the body | `1a45dfa3` (EBML / Matroska container magic) |

Three independent facts make this conclusive:

1. **`Content-Range` carries the full original size.** The total is
   `3500835068` bytes, and `3500835068` is also the `MediaSource.Size` Emby
   reports for the same item, with `Container` reported as `mkv`. A transcoder
   would not advertise a non-zero, range-servable total equal to the source
   file's size.
2. **The bytes are real Matroska.** `1a45dfa3` is the EBML header magic. A
   transcode to HLS would return a segment or a manifest, not an EBML header.
3. **Range requests are honoured.** `Accept-Ranges: bytes` plus a `206` means
   VLC can seek, which is the difference between "opens" and "usable as a
   player".

**Consequence.** Multi-audio, embedded ASS subtitles and font attachments
survive, because the bytes handed to VLC are the container VLC already knows how
to read. The web player has to transcode or remux to fit its own playback
constraints; a desktop player does not.

### 1.2 The endpoint is not fussy about spelling

The same file was fetched through several equivalent forms. Each returned
`206` with the same body:

| Variant | Result |
|---|---|
| `?Static=true` (capital) | 206 |
| `?static=true` (lowercase) | 206 |
| `/Videos/{itemId}/original.mkv` | 206 |
| `/Items/{itemId}/Download` | 206 |

The script uses `Static=true` because the casing matches the parameter as
documented, but the endpoint does not require it.

### 1.3 What authentication does and does not change

| Request | Result |
|---|---|
| No token at all | **401** |
| Token as `api_key=…` query parameter | **206** |
| Token as an `X-Emby-Token` header and no query parameter | **206** |

This is the fact the whole handoff design rests on: **VLC needs nothing but the
URL**. No cookies, no browser session, no headers. The token travels in the
query string, so a bare `vlc.exe "<url>"` is enough. Drop the token and the
server answers `401`, which is exactly the failure a user sees inside VLC when
their token is wrong or revoked (see
[`troubleshooting.md`](troubleshooting.md)).

### 1.4 The one parameter that must not be guessed

Passing a wrong `MediaSourceId` to the static endpoint does not fall back to a
default. It fails:

```
HTTP 400  Value cannot be null. (Parameter 'mediaSource')
```

The script therefore never sends `MediaSourceId` unless it has a real one from a
`PlaybackInfo` response for that exact item. For the normal case it sends none.

---

## 2. Why a URI payload, and why base64url JSON

The handoff is a single URI:

```
vlc://open?d=<base64url(json)>
```

Two schemes are registered: `vlc://` (what users expect) and `bingetovlc://`
(a collision-free alias). Both carry the same payload.

### 2.1 The payload has to survive four changes of representation

The string leaves the browser and passes through:

1. Chrome's external-protocol prompt and OS launch;
2. the Windows registry `shell\open\command` template (`"%1"`);
3. PowerShell's argument parsing;
4. a line-oriented `.m3u` file on disk.

Each layer has its own quoting rules. A payload containing `&`, `%`, `"`,
spaces or newlines can be truncated, split or mangled by any one of them, often
silently.

### 2.2 base64url, padding stripped

`base64url` (RFC 4648 §5) uses the alphabet `A-Za-z0-9-_`. Every character is
URI-safe. There is no `+`, `/`, `=` (padding is stripped), `%`, `&`, `?`, space
or quote anywhere in the encoded payload, so none of the four layers above has
anything to escape. The full JSON queue travels as one argument.

The codec (`src/core/payload.js`) is deliberately tolerant on the way in — it
accepts padding, `+`/`/`, whitespace and percent-escapes — because a browser
might hand over one of those forms anyway. It is strict about the way out: the
emitted alphabet is only `A-Za-z0-9-_`.

### 2.3 Truncation detection

A long URI can be cut off somewhere in the chain without any layer reporting an
error. "The playlist plays the wrong episodes" is the bug class this project
exists to prevent, and a truncation is how it would happen.

Two independent signals guard against it:

* **The declared item count.** `build()` writes `n` = number of items, and
  `validate()` rejects a payload where `n` does not equal `items.length`. A
  payload cut in half fails this check rather than producing a short queue.
* **Leftover bits.** A correct base64url encoding of a whole payload never has
  non-zero trailing bits. If the final partial group is non-zero, the input was
  truncated or corrupted, and decoding throws instead of guessing.

Decoding failures surface to the user verbatim — every caller in the script
shows the message rather than a generic error.

---

## 3. The handoff, end to end

There is no background process. A per-user registry key registers the schemes,
and the handler runs only for the fraction of a second needed to write the
playlist and start VLC.

The handler is the native executable `tools/windows/bingetovlc-handler.exe`
(built from `tools/windows/launcher.c`). It replaced the earlier PowerShell
handler, whose registered command line — `powershell.exe -NoProfile
-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File …` — is exactly
the signature antivirus heuristics flag; on the reporting machine it was blocked,
so the handler never ran. The exe has **no script host in the runtime path** and
can register itself (`bingetovlc-handler.exe --install`). The PowerShell handler
(`tools/windows/bingetovlc-handler.ps1`) stays in the tree as an alternative
implementation of the same contract.

```
 userscript (browser)        Windows registry           handler (native exe)              VLC
      │                            │                           │                          │
      │ user clicks "Play in VLC"   │                           │                          │
      │ build payload (JSON)        │                           │                          │
      │ encode -> base64url         │                           │                          │
      │ chooseHandoff(payload)      │                           │                          │
      │   ├─ mode = uri ───────────>│  vlc://open?d=<b64url>     │                          │
      │   └─ mode = download        │                           │                          │
      │        -> hand user an .m3u │                           │                          │
      │                             │  HKCU\Software\Classes\vlc │                          │
      │                             │  \shell\open\command       │                          │
      │                             │      = handler "%1"        │                          │
      │                             │──────────────────────────>│                          │
      │                             │                           │ decode base64url         │
      │                             │                           │ parse JSON               │
      │                             │                           │ validate v1 + items      │
      │                             │                           │ write temp .m3u          │
      │                             │                           │─────────────────────────>│
      │                             │                           │ vlc.exe "<temp>.m3u"     │
      │                             │                           │ wait for VLC to exit     │
      │                             │                           │ delete temp .m3u         │
      │                             │                           │ exit 0/2/3/4/5           │
```

* The handler accepts `vlc://` and `bingetovlc://`, path `open`, and either
  query `d` (the payload) or the manual single-item form `url=…&t=…`.
* Exit codes: `0` success, `2` malformed URI, `3` bad payload, `4` VLC not
  found, `5` write failure. Every run is logged to
  `%LOCALAPPDATA%\bingetovlc\logs\handler.log`.
* The temporary `.m3u` lives under `%LOCALAPPDATA%\bingetovlc\playlists\` and is
  deleted when VLC exits, unless `--keep-playlist` (the exe) or `-KeepPlaylist`
  (the script) is used. See [`security.md`](security.md) for why that timing
  matters.

### 3.1 Why no background service

A service or a localhost port would add a process that runs permanently, a port
to defend, a lifecycle to supervise and an install-time privilege question.
None of that buys anything the registry already provides: Windows launches the
handler on demand, it does the work, it exits. The handler is on the clock for
one file write and one process spawn — and being a native exe, it starts without
a script-host interpreter in that window at all.

### 3.2 Choosing URI vs download

`chooseHandoff(payload)` returns the handoff mode:

| Condition | Mode | Reason |
|---|---|---|
| `items.length > 200` | `download` | `too-many-items` |
| encoded URI longer than `1800` bytes | `download` | `uri-too-long` |
| otherwise | `uri` | — |

`MAX_URI_LENGTH = 1800` is **not** a preference — it is imposed by Windows.
Chromium hands an external-protocol URI to the shell with `ShellExecuteA`, which is
bound by `INTERNET_MAX_URL_LENGTH` (about 2,046 characters), and over that length
Chrome shows its permission prompt and then does nothing at all. See
[`vlc-notes.md`](vlc-notes.md) for the citations. The payload therefore carries item
ids rather than stream URLs, `MAX_URI_ITEMS = 200` is only a secondary guard, and a
whole large series still
falls back to a downloaded `.m3u` the user double-clicks. Both paths produce the
same playlist, and on the download path the payload is rebuilt without the URI
budget, so the file keeps its full episode titles.

---

## 4. Branching on item type before asking for a stream

Emby's `PlaybackInfo` is the obvious place to ask "how do I play this?" It works
for media-bearing items and fails hard for containers.

| Item type | Result |
|---|---|
| `Episode` | `200`, `SupportsDirectPlay: true`, `SupportsDirectStream: true`, `Container: mkv`, **`DirectStreamUrl: None`** |
| `Movie` | same: `200`, direct play/stream supported, `Container: mkv`, `DirectStreamUrl: None` |
| `Series` | **`500`** — `Unable to cast object of type MediaBrowser.Controller.Entities.TV.Series to type MediaBrowser.Controller.Entities.IHasMediaSources` |
| `Season` | **`500`** — same cast failure |

Only `Movie`, `Episode` and `Video` items have media sources. A `Series` or a
`Season` is a container. The script therefore reads the item's `Type` first and
only asks for a stream URL for a media-bearing type. A container is resolved to
its child episodes instead (see §6).

This is why a "queue the whole show" action cannot be implemented as "ask the
series for its stream": there is no such stream, and the server answers with a
`500` rather than an empty result.

A related dead end:

```
GET {server}/Users/Me
→ HTTP 500  Unrecognized Guid format
```

`/Users/Me` is a **Jellyfin** endpoint, not an Emby one. The script never calls
it. It resolves the user from the web client's own globals, or falls back to
`GET /Users` (which requires an admin token) and picks an administrator.

---

## 5. Why the URL is built by hand instead of using `DirectStreamUrl`

`PlaybackInfo` returns a `DirectStreamUrl` field, and it would be reasonable to
expect that to be the URL to play. On a live 4.10 server it was **not**:

> `DirectStreamUrl: None` for both an episode and a movie.

The field was empty for both media-bearing types tested, so a script that
depended on it would have had nothing to play. Instead `streamUrl()` builds the
URL directly from the item id and the session token:

```js
streamUrl(server, itemId, token)
  -> `${server}/Videos/${itemId}/stream?Static=true&api_key=${token}`
```

This is verifiable against the byte-range proof in §1.1 — the hand-built URL is
the one that returns the original file.

---

## 6. Listing episodes: minimal fields, and the 200 KB failure

### 6.1 The failure

Listing all episodes of a season while requesting `Fields=MediaSources,Overview`
produced a response body larger than **200 KB**, which caused a **JSON parse
failure** in the client as observed. Embedding a full `MediaSource` object —
which includes stream metadata for every audio and subtitle track — for each of
28 episodes is enormous, and the failure mode is not a clean error: the body
arrives, and parsing it fails.

**The rule.** List endpoints use minimal fields — only what ordering, labelling
and stream-URL construction need:

```
Fields=ParentIndexNumber,IndexNumber,Path,RunTimeTicks
```

Per-item detail is fetched separately, and only when a decision actually needs
it. (Listing a whole season of 28 episodes through `Items` with minimal fields
returned exactly 28 items, in order.)

### 6.2 The two list calls and what they returned

| Call | Observed result |
|---|---|
| `GET {server}/Users/{uid}/Items` with `ParentId={seasonId}`, `IncludeItemTypes=Episode`, `Recursive=false`, `SortBy=ParentIndexNumber,IndexNumber`, minimal `Fields` | 28 items for a 28-episode season, in order |
| `GET {server}/Shows/{seriesId}/Episodes` with `UserId`, minimal `Fields`, `SortBy=ParentIndexNumber,IndexNumber` | all 38 episodes of a two-season show, ordered S01E01…S01E28 then S02E01…S02E10 |

A season page lists its own episodes through `Items?ParentId=…`; a series page
lists every episode through `Shows/{id}/Episodes`. Both come back sorted by
`(ParentIndexNumber, IndexNumber)`, but the script does not trust that order — it
re-sorts locally (§7). That is deliberate: those sort keys are not in Emby's
documented `SortBy` list, so local ordering is the only guarantee the project is
willing to depend on.

---

## 7. Ordering and playability

Ordering is explicit, tested code, not whatever order a response happened to
arrive in. `orderItems()` applies four rules:

1. **Sort** by `(ParentIndexNumber, IndexNumber)` — season, then episode.
2. **Fall back** to `AiredEpisodeNumber`, then the numeric id, so an item
   missing index metadata still lands in a stable, repeatable position.
3. **Deduplicate** by `Id` — a season query and a series query can overlap.
4. **Drop unplayable items** — see below.

The truncation guard in §2.3 catches a *damaged* payload. Ordering and
deduplication catch a *response* that contains more or fewer episodes than the
user expects.

### 7.1 What "unplayable" means

Two shapes of item cannot be direct played and must not be queued:

| Condition | Why |
|---|---|
| `LocationType == "Virtual"` | The episode is announced (metadata exists) but has no file on disk. Emby produces `500`/`404` for its stream. |
| `Path` empty | Same: there is no file behind the item. |

A real season listing from the tested library contained such items; they are
filtered out before the payload is built. Queueing them would produce a visible
stall in VLC mid-binge — see [`troubleshooting.md`](troubleshooting.md).

---

## 8. How a 28 episode season becomes a 1.6 KB URI

This is the clearest case of a measurement changing the design, so it is worth
reading even if you skip the rest of this document.

The same season of 28 episodes is **5,471 bytes** when the payload carries full
stream URLs, and **1,584 bytes** when it carries item ids (both measured; the second
one in the browser test). Only the second works on Windows: Chromium hands the URI
to `ShellExecuteA`, which is capped at about 2,046 characters, and over that length
Chrome shows its permission prompt and then does nothing at all — no playlist and no
error. Payload v1 was the first number, and it would have failed silently on exactly
the feature this project exists for.

The arithmetic that gets there:

* Each item in the JSON is roughly a ~100-character stream URL plus a short
  title and a duration, so on the order of ~150 bytes of JSON per episode.
* `base64url` inflates by 4/3: ~150 bytes of JSON becomes ~200 bytes of encoded
  text.
* 28 × ~200 ≈ 5,600 bytes, minus what compact keys and omitted fields save, lands
  at the observed 5,471.

Two decisions buy that headroom:

* **Compact keys.** `u`, `t`, `d` instead of `url`, `title`, `duration`, and `n`
  instead of `itemCount`. The string travels through a command line; every byte
  counts.
* **No redundant fields.** `Path` is used for the playability check but is not
  copied into the payload; the stream URL is already derived from the id.

At 60 items the budget is 6,000 bytes; a season of 28 is well inside it, and a
90-episode series (≈16.8 KB encoded) is past both the item ceiling and the byte
ceiling and goes down the `.m3u` download path.

---

## 9. The exact API calls the script makes

| Purpose | Method | Request |
|---|---|---|
| item + type | `GET` | `{server}/Users/{uid}/Items/{itemId}` |
| season's episodes | `GET` | `{server}/Users/{uid}/Items?ParentId={seasonId}&IncludeItemTypes=Episode&Recursive=false&SortBy=ParentIndexNumber,IndexNumber&Fields=ParentIndexNumber,IndexNumber,Path,RunTimeTicks&Limit=500` |
| series' episodes | `GET` | `{server}/Shows/{seriesId}/Episodes?UserId={uid}&Fields=ParentIndexNumber,IndexNumber,Path,RunTimeTicks&SortBy=ParentIndexNumber,IndexNumber` |
| series' seasons | `GET` | `{server}/Shows/{seriesId}/Seasons?UserId={uid}&Fields=IndexNumber,ChildCount` |
| direct-play URL | `GET` | `{server}/Videos/{itemId}/stream?Static=true&api_key={token}` |

Probed but **not** used, with the reason:

| Call | Reason not used |
|---|---|
| `POST {server}/Items/{itemId}/PlaybackInfo?UserId={uid}` | Returned `DirectStreamUrl: None`; `500` on `Series`/`Season`. See §4, §5. |
| `GET {server}/Users/Me` | Jellyfin endpoint; `500 Unrecognized Guid format` on Emby. |
| `Fields=…MediaSources…` on list calls | >200 KB response, JSON parse failure. See §6.1. |

The server address, token and user id come from the web client's own globals:
`ApiClient.serverAddress()`, `ApiClient.accessToken()`, `ApiClient.getCurrentUserId()`.
That is what makes the script host-agnostic — it works on `app.emby.media`, on a
custom domain, on a LAN address, and on both web-client generations (§10).

---

## 10. Client detection: the least certain part of the design

Two different Emby web client generations were observed:

| Client | What it serves | Notes |
|---|---|---|
| Self-hosted 4.10 | `web/index.html` with a global `Emby` object; `web/app.js` version `4.10.0.40` | the older generation |
| `app.emby.media` | a different generation at the root; `apploader.js` version `26.0.30`; returns `404` for `web/index.html` | the newer loader generation |

The adapter therefore detects the client at runtime rather than assuming a fixed
script path.

**The uncertainty.** A global `ApiClient` object was **not present in either page
until the client finished booting**. How the script waits for and reads that
object — polling, a mutation observer, or hooking the boot sequence — is a real
design constraint, and the exact timing on a slow or unusual deployment has not
been fully characterised. This is the part of the design most likely to need
adjustment against a client generation that has not been observed. Treat it as
**not verified beyond the two generations above**.

---

## 11. The media this was built against

The tested library held **66,521 movies**, and the server had **24 user
accounts** — context for why list responses must stay small and why per-request
behaviour matters at scale. The media itself is typically:

* 1080p HEVC in MKV;
* multiple audio tracks (AAC and EAC3, English and Japanese);
* embedded ASS subtitles, with font attachments.

Direct play preserves all of it. What VLC does with embedded ASS subtitles and
font attachments is a VLC behaviour, not a bingetovlc one; see
[`troubleshooting.md`](troubleshooting.md) for the observable consequences.

---

## Related documents

* [`SPEC.md`](SPEC.md) — the frozen interface contract (payload v2, M3U rules,
  API contract, module layout).
* [`security.md`](security.md) — the token in the URL, the temporary playlist,
  the registry, and the threat model.
* [`troubleshooting.md`](troubleshooting.md) — symptom, cause, fix.
* [`adapters.md`](adapters.md) — adding another site.
* [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — build, test and vector workflow.