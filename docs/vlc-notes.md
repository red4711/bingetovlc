# Verified notes on VLC and on Windows URI hand-off

Everything here was checked against primary sources — VLC's own source tree
(`3.0.x` branch, version 3.0.25-dev), Chromium's source, and Microsoft's
documentation — because each item changed a design decision or a line of
user-facing text. Claims that could not be confirmed are labelled.

## The one that changed the design: the Windows URI length cap

Chromium hands an external-protocol URI to the operating system through
`ShellExecuteA` on Windows. That call is bound by `INTERNET_MAX_URL_LENGTH`,
about 2,046 characters (Windows itself also truncates at 2,083; IEInternals
measured silent truncation at that mark on Windows 8.1).

The failure mode is the worst kind: **over the limit, Chrome still shows its
permission prompt, and then nothing happens when the user accepts.** No error, no
playlist, no clue.

* Raymond Chen on `ShellExecute` and `INTERNET_MAX_URL_LENGTH`:
  <https://devblogs.microsoft.com/oldnewthing/20031210-00>
* IEInternals, "URL length limits":
  <https://learn.microsoft.com/en-us/archive/blogs/ieinternals/url-length-limits>
* Process-wide 32,767-character `CreateProcess` limit (not the binding one here):
  <https://learn.microsoft.com/en-us/troubleshoot/windows-client/shell-experience/command-line-string-limitation>

**Consequence now baked into the project:** `MAX_URI_LENGTH = 1800`, and the
payload carries item ids rather than full stream URLs. Measured: a 28 episode
season is 5,471 bytes as URLs and 1,584 bytes as ids (values from the browser
test). The `.m3u` download path has no such limit and is used for anything bigger.

## How Chromium transforms the URI before the handler sees it

`ShellExecuteA` receives the URI after `base::EscapeExternalHandlerValue()`:
everything outside alphanumerics, `-_.!~*'()`, the restricted set
`;/?:@&=+$,#[]` and valid `%XX` escapes is percent-encoded.

* <https://github.com/chromium/chromium/blob/main/base/strings/escape.h>
* call site:
  <https://github.com/chromium/chromium/blob/main/chrome/browser/external_protocol/external_protocol_handler.cc>

Practical results: `?`, `&`, `=`, `+`, `/` survive verbatim; a bare `%` becomes
`%25`; spaces become `%20`; the scheme is lowercased during URL parsing
(<https://url.spec.whatwg.org/#concept-basic-url-parser>). This is exactly why the
payload is base64url (`A-Za-z0-9-_` only) — nothing in it can be rewritten.

Also from that source: **a user gesture is required**, and Chromium remembers an
allow decision per origin only for potentially-trustworthy origins. The dialog's
"Always open" checkbox was removed in Chrome 77 and now requires the
`ExternalProtocolDialogShowAlwaysOpenCheckbox` policy.

A web page cannot register a scheme for itself:
`navigator.registerProtocolHandler` accepts only `web+…` or a fixed safelist
(`mailto`, `tel`, `magnet`, …), so OS registration is mandatory. See
<https://developer.mozilla.org/en-US/docs/Web/API/Navigator/registerProtocolHandler>.

**Machinery the project therefore uses:** handler registered per-user under
`HKCU\Software\Classes\<scheme>` with an empty `URL Protocol` value and
`shell\open\command` = `"…" "%1"`. The per-user key shadows a machine-wide one for
that user only (<https://learn.microsoft.com/en-us/windows/win32/sysinfo/merged-view-of-hkey-classes-root>).

## VLC's command line: what exists and what does not

Read from the `3.0.x` tree; option definitions are in `src/libvlc-module.c` and
`modules/access/http/access.c`.

| Option | Status | Note |
|---|---|---|
| `--http-referrer` | exists | sent as `Referer:`; inherited by the adaptive (HLS) client, see below |
| `--http-user-agent` | exists | format is `Name/version` |
| `--http-cookie` | **does not exist** | cookies live in an internal cookie-jar variable, not a CLI string; there is no cookie-file option either. A cookie-gated stream cannot be handed to VLC by URL alone |
| `--play-and-exit` | exists, default off | "Exit if there are no more items in the playlist" |
| `--one-instance` | exists, default off | reuses the running instance via a named mutex and `WM_COPYDATA` |
| `--started-from-file` | exists, default off | set by a file association; pairs with `--one-instance-when-started-from-file` (default on) |
| `--fullscreen` | exists, default off | |
| `--no-video-title-show` | exists | the option is `video-title-show`, default on |
| start playback at playlist item N | **does not exist** | there is no such CLI option in 3.0.x or master. The handler therefore logs "unsupported" instead of guessing, and the userscript instead sends a queue that starts where the user asked |

`#EXTVLCOPT:` in an M3U is not a whitelist: the m3u demuxer appends everything
after the colon as an item option
(<https://github.com/videolan/vlc/blob/3.0.x/modules/demux/playlist/m3u.c>), and
item options are inherited by the access and demux children. So
`network-caching=`, `http-referrer=` and `http-user-agent=` all work per entry,
which is what the generic adapter relies on.

## Does the VLC Windows installer register `vlc://`?

**No.** The NSIS installer only writes file-extension associations; the single
`vlc://` string in it is the internal reset command `vlc://quit`
(<https://github.com/videolan/vlc/blob/3.0.x/extras/package/win32/NSIS/vlc.win32.nsi.in>).

Inside VLC, `vlc://` is an internal MRL handled by the `idummy` access module:
`vlc://quit`, `vlc://nop`, `vlc://pause[:seconds]`, anything else is an error
(<https://github.com/videolan/vlc/blob/3.0.x/modules/access/idummy.c>). So
`vlc://https://host/x.m3u8` is **not** a URL opener with stock VLC — it only works
because a third-party handler rewrites it. The widely used one is
<https://github.com/stefansundin/vlc-protocol>, which registers `HKCR\vlc` and
launches VLC with the URL.

Two consequences for this project: registering `vlc://` from our installer does not
fight the stock VLC install (there is nothing to fight), but it **can** conflict
with a third-party handler such as vlc-protocol — which is why the installer backs
up any existing key first, and why `bingetovlc://` exists as a free alias.

## HLS behaviour worth knowing

From `modules/demux/hls/` and `modules/demux/adaptive/`:

* Master vs media playlist is decided by the presence of `EXT-X-STREAM-INF`.
* `EXT-X-KEY` **AES-128** is parsed and decrypted.
* `SAMPLE-AES` is enumerated but not implemented, and Widevine/PlayReady/CENC do
  not appear anywhere in the tree — **DRM-protected streams cannot be played**, by
  VLC or by anything built on it.
* Live vs VOD is decided by a trailing `EXT-X-ENDLIST`.

This project does not need any of it for Emby: the static file endpoint returns the
original MKV, not HLS.

## Prior art worth reading

| Project | What it shows |
|---|---|
| <https://github.com/stefansundin/vlc-protocol> (209★) | the OS-handler model this project follows |
| <https://github.com/akiirui/mpv-handler> (413★) | a metadata payload in the URI (base64 + referrer + cookie + quality) — the shape the v2 payload imitates |
| <https://github.com/giuseppe-dandrea/Stream-to-VLC> (32★) | closest analogue: Tampermonkey + a custom `vlcs://` scheme; its issue list is dominated by the browser authorisation prompt and by site breakage |
| <https://github.com/Baldomo/open-in-mpv> (196★) | hardens the handler (http/https only, shell-escaped args) — the class of bug a protocol handler invites |
| <https://github.com/gabreek/mpv-handler-queue> (5★) | a queue belongs in the handler, not in the page |
| <https://github.com/Momo707577045/media-source-extract> (1.9k★) | why `blob:`/MSE playback has no URL to hand to a player at all |

The recurring lesson from all of them: **the site wins sometimes** (anti-hotlink,
adblock, DRM) and the honest design is to detect that and say so, rather than fail
silently.
