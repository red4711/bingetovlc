# bingetovlc — interface spec (frozen v1)

This file is the contract between the userscript, the Windows protocol handler,
and the test suite. Change it only by bumping `PAYLOAD_VERSION`.

## 1. Product behaviour

| Page the user is on | Handoff |
|---|---|
| Movie | 1-item playlist |
| Episode | configurable: `item` (just this) / `rest-of-season` (this + the rest of its season) |
| Season | every episode of that season, in order |
| Series | every episode of every season, in order (season, then episode) |

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

### Payload v1

Compact keys: this string travels through a command line, so every byte counts.

```json
{
  "v": 1,
  "src": "emby",
  "server": "https://media.example.com",
  "title": "Frieren: Beyond Journey's End",
  "scope": "season",
  "items": [
    {"u": "https://media.example.com/Videos/3020743/stream?Static=true&api_key=...",
     "t": "S01E01 The Journey's End",
     "d": 1560}
  ],
  "opts": {"fs": false, "one": true, "exit": false, "start": 0}
}
```

* `items[].u` — absolute URL, already authenticated (query-param token), so VLC
  needs no headers, no cookies and no browser session.
* `items[].t` — display title for the playlist entry.
* `items[].d` — duration in seconds (integer, optional).
* `opts.fs` fullscreen, `opts.one` reuse a running VLC instance,
  `opts.exit` close VLC when the playlist ends, `opts.start` 1-based index.

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
   yields `HTTP 400 Value cannot be null. (Parameter 'mediaSource')`.
4. **Never request `Fields=…MediaSources…` for a whole season.** 28 episodes
   with `Fields=MediaSources,Overview` produced a >200 KB response body. Lists
   use minimal fields; per-item detail is fetched only when needed.
5. **`/Users/Me` is Jellyfin, not Emby** — it returns HTTP 500
   `Unrecognized Guid format`. Resolve the user from the web client globals, or
   fall back to `GET /Users` (admin token) and pick an administrator.
6. **Skip items with `LocationType == "Virtual"`** (missing/upcoming episodes
   with no file) and items whose `Path` is empty. They cannot be direct played.
7. Ordering key is `(ParentIndexNumber, IndexNumber)`, falling back to
   `AiredEpisodeNumber`, then `Id` — for stable ordering without duplicates.
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
