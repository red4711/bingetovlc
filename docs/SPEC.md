# bingetovlc — interface spec (frozen v1)

This file is the contract between the userscript, the Windows protocol handler,
and the test suite. Change it only by bumping `PAYLOAD_VERSION`.

## 1. Product behaviour

| Page the user is on | Default queue | Other scopes offered |
|---|---|---|
| Movie | that one file | none |
| Episode | just that episode | rest of season, whole season, whole show |
| Season | every episode of that season, in order | none |
| Series | every episode of every season, in order | none |

Container types (`Series`, `Season`) deliberately do **not** offer a single-item
scope: their ids have no media sources, and asking Emby for the stream returns
HTTP 500 (see section 4, rule 1). `normalizeScope()` always returns the first
allowed scope for the type, and `availableScopes(type)[0]` is the default, so
landing on a season queues the season without the user choosing anything.

Everything is **direct play**: the URL handed to VLC is the original file
byte-for-byte, no transcode, no remux, no segment re-muxing.

## 2. Handoff mechanism (no background process)

The userscript navigates to a custom URI. A registered Windows protocol handler
receives it, decodes the payload, writes a temporary `.m3u`, and launches VLC.

```
vlc://open?d=<base64url(json)>
bingetovlc://open?d=<base64url(json)>
```

* `vlc://` is the primary scheme because that is what users expect; it is
  registered per-user (HKCU) so it overrides any machine-wide handler for the
  current user only.
* `bingetovlc://` is registered as well, as the collision-free alias.
* `base64url` = RFC 4648 §5 alphabet (`A-Za-z0-9-_`), **padding stripped**.
  Only URI-safe characters, so nothing in the payload can be mangled by the
  browser, the shell or the registry.
* The handler also accepts a manual single-item form:
  `vlc://open?url=<percent-encoded-absolute-url>&t=<title>`.

### Payload v2

Compact keys: this string travels through a command line, so every byte counts.

```json
{
  "v": 2,
  "src": "emby",
  "server": "https://media.example.com",
  "token": "0123456789abcdef0123456789abcdef",
  "title": "Frieren: Beyond Journey's End",
  "scope": "season",
  "n": 2,
  "items": [
    {"i": "3020743", "t": "S01E01 The Journey's End", "d": 1560, "s": 1, "e": 1},
    {"i": "3020744", "s": 1, "e": 2}
  ],
  "opts": {"fs": false, "one": true, "exit": false, "start": 0}
}
```

* `items[].i` — the Emby item id. **This is the important change from v1**, which
  carried complete stream URLs: a 28 episode season was 5,471 bytes as URLs but is
  about 1,600 bytes as ids, and Windows caps an external-protocol URI at roughly
  2,046 characters (see `MAX_URI_LENGTH`). With URLs the season queue would have
  failed on Windows by doing nothing at all. The handler builds each URL as
  `{server}/Videos/{id}/stream?Static=true&api_key={token}`.
* `items[].u` — an absolute URL, still supported for payload v1 and for the
  generic adapter, which has no authenticated API to resolve an id against. It must
  contain **no whitespace and no control characters**: `validate()` and `build()`
  reject such a URL, because a newline inside it would start a new line in the
  generated playlist and could inject extra entries or `#EXTVLCOPT` lines.
  `buildM3u()` strips control characters as a second layer, for payloads assembled
  elsewhere. Percent-encode anything unusual rather than embedding it literally.
* `server` + `token` — required whenever any item uses `i`, because an id is only
  resolvable against an authenticated server. The token charset is restricted to
  `[A-Za-z0-9._~-]`: those are the characters every implementation can place in a
  URL without percent-encoding, so the JavaScript, PowerShell and Python builds
  cannot disagree about escaping.
* `items[].t` — display title. `items[].d` — duration in seconds. Both optional.
* `items[].s` / `items[].e` — season and episode numbers. Two bytes each, and they
  are what lets the handler label a queue `S01E03` when the titles had to be
  dropped to fit the URI budget.
* `opts.fs` fullscreen, `opts.one` reuse a running VLC instance,
  `opts.exit` close VLC when the playlist ends, `opts.start` 1-based index.

#### Fitting the URI budget

`build()` calls `fitToBudget()` before it returns, so a caller cannot forget it. If
the URI would exceed `MAX_URI_LENGTH` (1,800), the payload is trimmed in this order:

1. **Titles** (`t`) are dropped, and `trimmed: "titles"` is recorded. The `s`/`e`
   numbers reproduce the useful part of a title (`S01E03`) in two bytes each.
2. **Durations** (`d`) are dropped next, recorded as `trimmed: "titles+durations"`.

Ids are never dropped: they are the only part the handler cannot reconstruct. If
the payload is still over budget, `chooseHandoff()` sends the queue to the
downloaded-`.m3u` path, which has no length limit — and there the payload is built
with `budget: null`, so the downloaded file keeps its full titles.

## 3. Generated M3U (written by the handler, and by the download fallback)

```
#EXTM3U
#EXTINF:1560,S01E01 The Journey's End
#EXTVLCOPT:network-caching=<ms>        <- only if opts.cache set
https://.../Videos/3020743/stream?Static=true&api_key=...
```

Rules:

* `#EXTINF` duration is omitted when unknown: `#EXTINF:-1,<title>`.
* A title containing a newline is folded to a space; `,` is allowed (the title
  is the text after the first comma of `#EXTINF`).
* Header options (`http-referrer`, `http-user-agent`) are only emitted when the
  payload carries them (`opts.referrer` / `opts.ua`, used by the generic
  adapter, never by Emby).
* File written to `%LOCALAPPDATA%\bingetovlc\playlists\bingetovlc-<utcstamp>-<rand>.m3u`.
  It contains an API token, so it is deleted when VLC exits (unless `-KeepPlaylist`).

## 4. Emby API contract (verified against a live 4.10.0.40 server)

Server address, token and user id come from the web client's own globals
(`ApiClient.serverAddress()`, `ApiClient.accessToken()`,
`ApiClient.getCurrentUserId()`) so the script is host-agnostic — it works on
`app.emby.media`, on any custom domain, on LAN addresses and on 4.x as well as
the newer `apploader.js` client generation.

| Purpose | Request |
|---|---|
| item + type | `GET {server}/Users/{uid}/Items/{itemId}` |
| season's episodes | `GET {server}/Users/{uid}/Items?ParentId={seasonId}&IncludeItemTypes=Episode&Recursive=false&SortBy=ParentIndexNumber,IndexNumber&Fields=ParentIndexNumber,IndexNumber,Path,RunTimeTicks&Limit=500` |
| series' episodes | `GET {server}/Shows/{seriesId}/Episodes?UserId={uid}&Fields=ParentIndexNumber,IndexNumber,Path,RunTimeTicks&SortBy=ParentIndexNumber,IndexNumber` |
| series' seasons | `GET {server}/Shows/{seriesId}/Seasons?UserId={uid}&Fields=IndexNumber,ChildCount` |
| direct-play URL | `GET {server}/Videos/{itemId}/stream?Static=true&api_key={token}` |

Hard-won rules (each one cost a real request to discover):

1. **Branch on `Type` before asking for a stream.** `PlaybackInfo` on a
   `Series` or `Season` returns **HTTP 500** (`Unable to cast object of type
   Series to type IHasMediaSources`). Only `Movie`/`Episode`/`Video` items have
   media sources.
2. **Do not use `PlaybackInfo.DirectStreamUrl`.** A live 4.10 server returned
   `DirectStreamUrl: None` for both an episode and a movie. Build the URL:
   `{server}/Videos/{id}/stream?Static=true&api_key={token}`.
3. **Do not pass `MediaSourceId` unless you have a real one** — a wrong value
   yields `HTTP 400 Value cannot be null. (Parameter 'mediaSource')`. Emby's own
   video-streaming documentation lists `MediaSourceId` *and* `PlaySessionId` as
   required for `/Videos/{id}/stream`, but Emby's OpenAPI specification omits both,
   and a live probe against 4.10.0.40 settled it: `Static=true` with neither returns
   `206` and the original bytes. The project therefore sends neither — only
   `api_key` — because an invented `MediaSourceId` is a hard failure while an
   omitted one is demonstrably fine.
4. **Never request `Fields=…MediaSources…` for a whole season.** 28 episodes
   with `Fields=MediaSources,Overview` produced a >200 KB response body. Lists
   use minimal fields; per-item detail is fetched only when needed.
5. **`/Users/Me` is Jellyfin, not Emby** — it returns HTTP 500
   `Unrecognized Guid format`. Resolve the user from the web client globals, or
   fall back to `GET /Users` (admin token) and pick an administrator.
6. **Skip items with `LocationType == "Virtual"`** (missing/upcoming episodes
   with no file) and items whose `Path` is empty. They cannot be direct played.
7. Ordering key is `(ParentIndexNumber, IndexNumber)`, falling back to
   `AiredEpisodeNumber`, then `Id` — for stable ordering without duplicates. Note
   that `SortBy=ParentIndexNumber,IndexNumber` is **not** in Emby's documented
   `SortBy` option list, even though a live server honoured it (28 of 28 episodes,
   38 of 38 across two seasons, in order). The code therefore does not depend on it:
   the response order is re-sorted locally, so an undocumented sort key silently
   ceasing to work costs nothing.
9. Nothing reports playback progress back to Emby. The handler starts VLC and exits;
   VLC speaks no Emby protocol, and `/Sessions/Playing` is never called. So an
   episode watched through bingetovlc is **not** marked watched, `Resume`/`NextUp` do
   not advance, and the "skip already-watched" setting only knows what the Emby web
   player recorded. Whether Emby would eventually drop a `Static=true` stream that
   reports no progress is undocumented and not exercised here; the requests this
   project makes all completed within normal response times.
8. Auth: `api_key` works as a query parameter everywhere the script needs it,
   including the streaming endpoint (verified with a byte-range request).
   Without it the stream is **HTTP 401**.

### Verified stream proof (no transcode)

```
GET /Videos/3020743/stream?Static=true&api_key=***   Range: bytes=0-16383
→ 206 Partial Content
  Content-Type: video/x-matroska
  Content-Range: bytes 0-16383/3500835068
  Accept-Ranges: bytes
  first 4 bytes: 1a45dfa3   (EBML/Matroska container magic)
```

Same for `?static=true` (case-insensitive), `/Videos/{id}/original.mkv` and
`/Items/{id}/Download`. The advertised `Size` of 3,500,835,068 bytes equals the
`Content-Range` total, i.e. byte-exact passthrough of the original MKV with
embedded ASS subtitles and multiple audio tracks intact.

## 5. Module layout

`src/` is authored as small ES modules and concatenated by `tools/build.py` into
the single-file `dist/bingetovlc.user.js` (a Tampermonkey userscript must be one
file). Every module must be importable by Node with no DOM present, which is how
the unit tests exercise it.

```
src/meta.js               userscript header (@name/@match/@grant/@connect)
src/core/payload.js       version, base64url encode/decode, build, URI building
src/core/m3u.js           M3U serialisation
src/core/handoff.js       scheme selection, length budget, launch + .m3u fallback
src/core/ordering.js      episode ordering / dedupe / scope assembly
src/core/emby/api.js      ApiClient resolution, item fetch, stream URL builder
src/core/emby/adapter.js  type branching -> playlist for item/season/series
src/core/generic/adapter.js  experimental: DOM/HLS sniffing for non-Emby pages
src/ui/panel.js           floating panel, buttons, playlist preview
src/ui/settings.js        persisted settings (GM_setValue)
src/main.js               bootstrap + SPA navigation watching
```

Frozen function signatures:

```js
// src/core/payload.js
PAYLOAD_VERSION                       // 1
build({source, server, title, scope, items, opts}) -> payload object
encode(payload)                       -> string (base64url, no padding)
decode(string)                       -> payload object | throws
launchUri(payload, scheme='vlc')      -> 'vlc://open?d=...'
estimatedUriLength(payload)           -> number

// src/core/m3u.js
buildM3u(payload, {includeTokens=true, newline='\n'}) -> string

// src/core/ordering.js
orderItems(items)                     -> new array, sorted, deduped by Id
scopeItems({item, itemType, children, scope}) -> {items, title, scope}

// src/core/emby/api.js
streamUrl(server, itemId, token)      -> absolute URL
itemUrl(server, uid, itemId, {parentId, fields, limit, sortBy, includeTypes}) -> URL
resolveSession(pageWindow)            -> {server, token, uid} | null
```

## 6. Windows handler contract

`tools/windows/bingetovlc-handler.ps1`

* Input: the full URI as `$args[0]` (registry passes `"%1"`).
* Accepts `vlc://`, `bingetovlc://`; path `open`; query `d` or `url`+`t`.
* Exit codes: `0` success, `2` malformed URI, `3` bad payload, `4` VLC not found,
  `5` write failure. Always logged to `%LOCALAPPDATA%\bingetovlc\logs\handler.log`.
* `-SelfTest`: decode a URI argument and print the exact M3U to stdout without
  launching VLC (this is what CI asserts against the conformance vectors).
* `-Diagnostics`: interactive report (VLC path, scheme registration, last error).

`tools/windows/install.ps1 [-Uninstall] [-DryRun] [-Scheme vlc,bingetovlc] [-VlcPath X]`

* Backs up any pre-existing scheme key to
  `%LOCALAPPDATA%\bingetovlc\backup\<scheme>-<utcstamp>.reg` before overriding it,
  and restores it on `-Uninstall`.
* Registers `HKCU\Software\Classes\<scheme>` with `URL Protocol`, `DefaultIcon`
  and `shell\open\command`.
* Detects VLC automatically (`%ProgramFiles%\VideoLAN\VLC\vlc.exe`,
  `%ProgramFiles(x86)%...`, `HKLM\SOFTWARE\VideoLAN\VLC`), and can be told
  explicitly.
* `-DryRun` prints the exact registry operations without touching the registry.

## 7. Conformance vectors

`tests/fixtures/vectors.json` holds `{payload, base64, m3u, uri}` tuples.
Three independent implementations must agree on them:

1. JavaScript (`src/core/*`, tested by `node --test`)
2. Python (`tools/playlist/conformance.py`, the reference decoder)
3. PowerShell (`tools/windows/bingetovlc-handler.ps1 -SelfTest`, asserted on
   `windows-latest` in CI)

Divergence between any two is a release blocker — the bug class this catches is
"playlist plays the wrong episodes on someone else's machine".

## 8. UI and test contract

The end-to-end test drives the real userscript in a real browser, so the DOM
surface and the observation hook are part of the interface, not an implementation
detail. Renaming one of these breaks CI on purpose.

| Selector | Meaning |
|---|---|
| `#bingetovlc-panel` | panel root |
| `#bingetovlc-summary` | one-line description of the current queue |
| `#bingetovlc-status` | last status or error message (class `bingetovlc-error` / `bingetovlc-warn`) |
| `#bingetovlc-list` | the queued entries, in order |
| `#bingetovlc-play` | queue this item and hand it to VLC |
| `#bingetovlc-preview` | build the queue and show the URI, launch nothing |
| `#bingetovlc-download` | save the queue as an `.m3u` |
| `#bingetovlc-uri` | the produced URI, or a description of why a file is used instead |
| `#bingetovlc-scope` | scope selector; its option values are the scope names |
| `#bingetovlc-diagnostics` | copy a token-redacted report |
| `#bingetovlc-banner` | transient outcome banner (created on demand) |

Observation hook: when the page sets `window.__BINGETOVLC_TEST_MODE__ = true`
**before the script runs**, no navigation to the custom scheme is attempted and a
`bingetovlc:handoff` CustomEvent is dispatched on `document` instead, whose
`detail` carries `{uri, payload, mode, reason, scheme}`. Headless Chrome cannot
complete an external protocol launch, so this is the only way to assert the queue
that *would* have reached VLC — and `#bingetovlc-uri` carries the same URI for a
DOM-level assertion.

Debug surface: on an Emby page the script exposes `window.bingetovlc` with
`{version, state, refresh(), report()}`. `report()` returns the same
token-redacted text as the Copy report button.

Runtime scope defaults are asserted by the end-to-end test, live in a real
Chromium against a stubbed Emby API:

| Scenario | Asserted result |
|---|---|
| Season page | 28 items, `S01E01` first, `S01E28` last, Virtual episode excluded |
| Series page | 28 items, ordered |
| Movie page | exactly 1 item |
| Episode page | exactly 1 item |
| Episode, scope `rest-of-season` | 26 items, starting at that episode |
| Episode, scope `season` | 28 items and `opts.start == 3` (1-based index of that episode) |

No request URL may contain the server address twice (a regression guard: the
first implementation produced `http://hosthttp://host/Shows/...` and queued
nothing).
