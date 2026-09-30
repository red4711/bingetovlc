# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Pre-1.0.** bingetovlc has not reached 1.0. Interfaces — the payload format,
> the M3U rules, the handler contract — may change between minor versions, and
> the payload version is bumped when they do. Until 1.0, pin to a commit or tag
> rather than assuming compatibility across releases.

## [Unreleased]

### Added

* **Userscript** (`dist/bingetovlc.user.js`) — a single-file Tampermonkey
  userscript that adds **Play in VLC**, **Preview**, **Play from here** and
  **Copy / Download .m3u** actions to Emby web pages.
* **Windows protocol handler** (`tools/windows/bingetovlc-handler.ps1`) —
  registers the `vlc://` and `bingetovlc://` schemes per-user (HKCU), decodes the
  payload, writes a temporary `.m3u`, launches VLC, and deletes the playlist when
  VLC exits.
* **Direct-play URL building** — `{server}/Videos/{itemId}/stream?Static=true&api_key={token}`,
  verified byte-exact against a live Emby 4.10.0.40 server (`206`,
  `Content-Range bytes 0-16383/3500835068`, `Accept-Ranges: bytes`, EBML magic
  `1a45dfa3`). No transcode, no remux.
* **Season and series queueing** — order by `(ParentIndexNumber, IndexNumber)`,
  deduplicate by id, and drop `LocationType == "Virtual"` and empty-`Path` items.
  An episode page can queue *this episode + the rest of the season*.
* **M3U fallback** — when a queue exceeds the URI budget (200 items or 1800 bytes,
  the latter imposed by Windows' ~2046-character external-protocol limit), the user
  gets a downloaded `.m3u` instead, with the full episode titles intact.
* **Payload v2** — items carry Emby item ids and the handler builds the stream URL.
  This took a 28-episode season from a 5,471-byte URI (over the Windows limit, and
  therefore silently broken there) down to 1,584 bytes. Payload v1 is still accepted.
* **Conformance vectors** (`tests/fixtures/vectors.json`) shared byte-for-byte
  between the JavaScript, the Python reference decoder and the PowerShell
  handler.

### Notes

* Tested against Emby Server **4.10.0.40** and VLC **3.0.x** on Windows 10/11.
  Jellyfin is *not* tested — its API diverges (`/Users/Me`, different stream
  endpoints).
* Two Emby web client generations are detected at runtime; how the script waits
  for the client's `ApiClient` global to appear is the least certain part of the
  design (see [`docs/how-it-works.md`](docs/how-it-works.md) §10).

[Unreleased]: https://github.com/red4711/bingetovlc/commits/main