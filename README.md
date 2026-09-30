# bingetovlc

**Send any Emby episode, season or whole show straight to VLC — direct play, zero transcoding.**

bingetovlc is a single-file Tampermonkey userscript plus a small Windows protocol
handler. On an Emby web page it adds a **Play in VLC** button that queues the
*original file* — a 3.5 GB 1080p HEVC MKV with embedded ASS subtitles arrives in
VLC byte-for-byte, exactly as it sits on the server. No transcoding, no remux,
no re-encoding, no CPU on the server.

| Page you are on | What bingetovlc queues |
|---|---|
| Movie | that one file |
| Episode | just that episode, or *that episode + the rest of the season* |
| Season | every episode of the season, in order |
| Series | every episode of every season, in order |

VLC plays them back-to-back from a temporary playlist, so a whole season binge is
one click.

## Verified, not assumed

| Claim | How it was checked |
|---|---|
| The stream URL is a byte-exact passthrough with no transcode | Byte-range request to a live Emby 4.10.0.40 server: `206`, `video/x-matroska`, `Content-Range: bytes 0-16383/3500835068`, EBML magic `1a45dfa3` |
| The queue order, de-duplication and Virtual-item filtering are right | The built userscript driven in a real headless Chromium against a stubbed Emby API: season → 28 ordered episodes, series → 28, movie → 1, episode → 1, rest-of-season → 26, whole-season-from-here → 28 with `start=3` |
| The Windows handler writes the intended playlist | `tools/windows/selftest.ps1` under PowerShell: 9/9 checks — the 7 golden vectors plus two playlist-injection cases |
| Three independent implementations agree | The JavaScript, the Python reference decoder and the PowerShell handler produce byte-identical M3U for all 7 golden vectors |
| The registry changes are reversible | `install.ps1 -DryRun` prints the exact `HKCU` operations and writes nothing; a pre-existing scheme key is exported with `reg export` before it is overridden |
| A hostile URL cannot add lines to the playlist | A forged payload is refused (`exit 3`), and pushed past validation it still yields exactly 3 lines with 1 `#EXTINF` |

**Not verified:** an actual click-to-VLC launch on a real Windows desktop. That needs a
Windows machine with VLC installed, and is the one step this project cannot test from a
Linux CI runner. Everything up to the `vlc.exe` invocation is asserted; the invocation
itself is not.

## Why it works (and why it is not transcoded)

Every Emby item has a file endpoint that ignores the streaming pipeline entirely:

```
GET {server}/Videos/{itemId}/stream?Static=true&api_key={token}
```

Verified against a live Emby 4.10.0.40 server, with a real byte-range request:

```
→ 206 Partial Content
  Content-Type: video/x-matroska
  Content-Range: bytes 0-16383/3500835068      ← byte-exact, full original size
  Accept-Ranges: bytes                          ← VLC can seek
  first 4 bytes: 1a45dfa3                       ← EBML/Matroska magic
```

Three consequences:

1. **No transcode.** Emby serves the file; the server does no CPU work.
2. **No cookies, no headers, no browser session.** The token travels in the query
   string, so VLC needs nothing but the URL. Drop the token and you get `401`.
3. **Everything survives.** Multi-audio, embedded ASS subtitles, attachments —
   VLC reads the real container, so you get what a desktop player can do and the
   web player cannot.

## Install

### 1. The userscript

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Chrome, Edge, Brave or Firefox.
2. Open [`dist/bingetovlc.user.js`](dist/bingetovlc.user.js) → **Install**.

That is all the browser needs: the script uses the Emby web client's own
`ApiClient` session (server address, token, user id), so it works on
`app.emby.media` and on **any** self-hosted Emby, on any domain, LAN or WAN.

### 2. The `vlc://` handler (Windows)

Browsers cannot register custom URI schemes, so `vlc://` has to be registered in
Windows once. In PowerShell:

```powershell
git clone https://github.com/red4711/bingetovlc.git
cd bingetovlc\tools\windows
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The installer

* finds VLC (`Program Files`, `Program Files (x86)` or the `HKLM\SOFTWARE\VideoLAN\VLC` key),
* registers `vlc://` **for the current user only** (HKCU), so a machine-wide
  handler installed by something else is not damaged,
* also registers `bingetovlc://` as a collision-free alias,
* backs up any pre-existing scheme key first, and restores it on `-Uninstall`.

Verify, then undo:

```powershell
powershell -File .\install.ps1 -Diagnostics   # shows VLC path + registration state
powershell -File .\install.ps1 -Uninstall     # restores the previous state
```

The first time you click **Play in VLC**, Chrome asks *"Open VLC media player?"* —
tick **Always allow** and it will not ask again.

### 3. Understood the security model

The generated playlist URLs contain your Emby API token — that is what lets VLC
stream without a login. bingetovlc therefore writes the temporary playlist into
`%LOCALAPPDATA%\bingetovlc\playlists\` and **deletes it as soon as VLC exits**. See
[`docs/security.md`](docs/security.md) for the full reasoning, what the token can
reach, and how to use a per-user token instead of the admin one.

## Usage

Open any Emby item in the web app. A **bingetovlc** button appears in the corner of
the page:

* **Play in VLC** — single item, or the whole season/series when you are viewing a
  season/series page.
* **Preview** — shows the exact queue: order, titles, runtimes, total runtime.
  Nothing launches until you press play.
* **Play from here** — on an episode, start at that episode and continue to the
  end of the season.
* **Copy / Download .m3u** — no protocol handler needed at all. Double-clicking the
  downloaded `.m3u` opens the same queue in VLC. This is also the fallback for
  playlists too long to fit in a URI.

Settings (scheme name, fullscreen, reuse a running VLC instance, close VLC when
the queue ends, skip already-watched episodes, start index) live in the panel and
persist per browser.

## How it hands off to VLC without a background service

```
userscript                 registered handler                 VLC
   │  vlc://open?d=<base64url(json)>  │                          │
   ├────────────────────────────────>│  decode, write temp .m3u │
   │                                 ├─────────────────────────>│
   │                                 │  delete .m3u when VLC exits
```

No daemon, no localhost port, nothing listening. The handler runs only for the
fraction of a second it takes to build the playlist and start VLC. The payload is
JSON in `base64url`, so no shell or registry quoting can corrupt it, and the whole
queue travels as a single argument. Full format: [`docs/SPEC.md`](docs/SPEC.md).

## Requirements

* Emby Server 4.x (verified on 4.10.0.40) — Jellyfin is *not* tested: its API
  diverges (`/Users/Me`, different stream endpoints)
* VLC 3.0.x on Windows 10/11
* Chrome/Edge/Brave/Firefox with Tampermonkey

## Documentation

| Document | Contents |
|---|---|
| [`docs/SPEC.md`](docs/SPEC.md) | Frozen interfaces: payload v1, M3U rules, Emby API contract, module layout |
| [`docs/how-it-works.md`](docs/how-it-works.md) | The API findings behind every design decision, with the evidence |
| [`docs/security.md`](docs/security.md) | Token exposure, temp-file handling, threat model |
| [`docs/troubleshooting.md`](docs/troubleshooting.md) | Nothing happens / wrong episode / VLC opens but stalls |

## Development

```bash
python3 tools/build.py                 # src/ -> dist/bingetovlc.user.js (single file)
node --test tests/                     # unit tests (no dependencies)
node --test tests/e2e/                 # end-to-end: fake Emby server + real Chrome
```

The tests, the reference Python decoder and the PowerShell handler must agree on
the same conformance vectors — that is what keeps "the playlist plays the wrong
episodes" from ever shipping.

## License

MIT — see [`LICENSE`](LICENSE).
