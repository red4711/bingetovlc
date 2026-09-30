# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Pre-1.0.** bingetovlc has not reached 1.0. Interfaces — the payload format,
> the M3U rules, the handler contract — may change between minor versions, and
> the payload version is bumped when they do. Until 1.0, pin to a commit or tag
> rather than assuming compatibility across releases.

## [0.3.1] - 2026-09-30

### Fixed

* **Double-clicking the handler did not install anything.** With no arguments it
  fell through to the URI path, logged `URI rejected: no URI argument was
  supplied` and exited 2 — while the documentation said it would register and
  confirm with a dialog. It now asks, registers, and reports the outcome in a
  message box. Found after the first real installation on Windows, where the
  registry check confirmed the PowerShell handler had been registered and then
  blocked by antivirus.
* The handler reported version `1.0.0`, which this project never released,
  because the string was hard-coded. It is now injected from `package.json` by
  the build, so a bug report cannot quote a version that does not exist.
* The discovered VLC path read `C:\Program Files\VideoLAN\VLC/vlc.exe` — a joined
  path mixing separators. The launch tolerated it; the `DefaultIcon` value
  written to the registry did not, so the scheme had no usable icon.
* The install summary promised Chrome's **Always allow** checkbox, which Chrome
  removed in version 77. The text now describes what actually happens.

## [0.3.0] - 2026-09-30

### Changed

* **The Windows protocol handler is now a native executable, and it is the
  default.** `tools/windows/bingetovlc-handler.exe` (built from
  `tools/windows/launcher.c`) launches `vlc.exe` directly, and the registered
  command line is just `"…\bingetovlc-handler.exe" "%1"` — **no script host in
  the runtime path**. The previous default,
  `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy
  Bypass -File …`, is precisely the command-line shape antivirus/EDR heuristics
  flag; on a machine that reported "clicking *Play in VLC* does nothing", it was
  blocked and the handler never ran. The exe removes that signature from the
  runtime path entirely.
* **Installing needs no PowerShell.** `bingetovlc-handler.exe --install`
  registers the `vlc` and `bingetovlc` schemes per-user itself, and `--uninstall`
  restores any key it overrode — so a machine whose PowerShell is blocked can
  still install the handler. `tools/windows/install.ps1` now takes
  `-Handler auto|exe|powershell` (default `auto` = the exe when it sits beside the
  script) and delegates to `bingetovlc-handler.exe --install` / `--uninstall` /
  `--diagnostics`. `-Uninstall`, `-DryRun`, `-Diagnostics` and `-Scheme` are
  unchanged, and the `reg.exe export` backup-before-override behaviour is kept by
  both handlers. The `.reg` templates now point at the exe.
* **The PowerShell handler is kept as an alternative implementation** of the same
  contract (`docs/SPEC.md` §3/§6/§7), selected with `-Handler powershell`. It is
  no longer the default.

### Added

* `tools/windows/launcher.c` and `tools/windows/build-launcher.sh` — the native
  handler's source and its build (pinned **Zig 0.13.0**; Zig is the only compiler
  needed).
* `tools/windows/selftest-launcher.ps1` — the exe's conformance entry point,
  per-vector PASS/FAIL against `tests/fixtures/vectors.json`, non-zero exit on
  mismatch.
* A `windows-native-handler` CI job: builds the exe on `windows-latest` with Zig
  0.13.0, asserts it against the same vectors the PowerShell handler uses, and
  uploads it as the `bingetovlc-handler-windows-x86_64` artefact.

### Notes

* The exe is **unsigned**. Windows Defender / SmartScreen may inspect it or prompt
  on first run; the source and the CI build that produced the artefact are
  published so the binary can be verified or rebuilt rather than trusted.
* The exe's `--selftest` path is Windows-API free (no registry, no VLC launch) and
  also builds on Linux, so the decode/M3U contract is testable off Windows.

## [0.2.1] - 2026-09-30

### Fixed

* **"Failed to fetch" with an empty queue dropdown on the Emby Connect web
  client.** The credential fallback trusted a single stored address, which on a
  real installation was a Docker address (`http://172.20.0.10:8096`) while the
  page was the https client at `app.emby.media`. The browser refuses that request
  twice over — plain http from an https page is mixed content, and a private
  address is unreachable from a public page — so every request died before it was
  sent and the only visible symptom was an empty scope dropdown.

  The session now collects **every** address the stored server entry knows,
  prefers the entry for the `serverId` the page is showing, discards addresses
  the browser cannot use, and settles on the first one that answers
  `/System/Info/Public`. A refused request now names the address it tried and
  where that address came from, instead of reporting the browser's two-word
  failure.

* The reachability probe validates the response body, not just the status: a
  single-page host answers `200` with HTML for unknown paths, so Emby Connect's
  own app host looked like a valid server.

### Added

* An end-to-end scenario for the reported shape: no `ApiClient`, credentials
  recovered from `localStorage`, first stored address unreachable. It asserts the
  session is recovered *and* settles on an address that answers.
* Unit tests for address selection, including the exact reported combination.

## [0.2.0] - 2026-09-30

### Fixed

* **The settings panel was inside the Settings button.** `addOption()` appended
  the controls into the disclosure button instead of the container it controls,
  so the button grew to fit them (stretching the Download button beside it into a
  390px empty slab) and clicking Settings showed and hid an element that was
  always empty. The controls now live in the container, and `aria-expanded`
  follows the state.
* **A long queue rendered as invisible text.** Flex items with a non-visible
  `overflow` lose their automatic minimum size, so a bounded-height column shrank
  them instead of scrolling: the summary measured 3px tall and each queue row
  4px, with the text clipped. Rows now keep their natural height and the panel
  body scrolls.
* **The panel could grow off the top of the screen.** A 28-episode queue made it
  704px tall in a 577px window, hiding its own header and controls. It is capped
  to the viewport now, with internal scrolling.
* The hand-off URI heading no longer appears when the URI block is hidden, and
  collapsing leaves a 58px pill rather than the header plus the footer.
* Emby navigation is picked up from the client's own `viewbeforeshow`/`viewshow`
  events instead of a poll-only `hashchange` watch, so the panel stops showing
  the previously viewed item. The stored-credential fallback now handles the real
  `servercredentials3` shape.

### Changed

* The panel was rebuilt around one primary action: full-width **Play in VLC**,
  secondary actions in one row, and footer actions demoted to a third tier.
  Settings are grouped under **VLC** and **Advanced** and styled consistently
  (checkboxes, a dropdown with its own arrow, focus outlines everywhere).
* The panel never prints a meaningless `unknown` runtime, counts are pluralised,
  and the queue count moved to the queue header instead of repeating in the
  summary.
* The transient banner shares the panel's styling and can be dismissed directly.

### Added

* Seven panel-layout assertions to the end-to-end test, since neither layout bug
  above was reachable by a DOM-level check: control location, `aria-expanded`,
  measured row heights, viewport fit, and the collapsed state.

## [0.1.0] - 2026-09-30

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

[0.3.1]: https://github.com/red4711/bingetovlc/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/red4711/bingetovlc/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/red4711/bingetovlc/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/red4711/bingetovlc/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/red4711/bingetovlc/releases/tag/v0.1.0
