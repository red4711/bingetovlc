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
| A whole season fits in a single click | 28 episodes produce a **1,584-byte** URI as ids. The same queue as full stream URLs was **5,471 bytes**, over the ~2046-character cap Windows applies to an external-protocol URI — that version would have failed silently on Windows (Chrome shows its prompt, then nothing happens). Measured in the browser test and pinned by unit tests |
| The Windows handler writes the intended playlist | Two independent implementations are asserted in CI against the same 8 golden vectors plus a playlist-injection case: the native exe (`tools/windows/selftest-launcher.ps1`) and the PowerShell handler (`tools/windows/selftest.ps1`) |
| Three independent implementations agree | JavaScript, Python and the Windows handler produce byte-identical M3U for all 8 golden vectors |
| The registered command line is not a script-host invocation | The default handler is `bingetovlc-handler.exe`, registered directly. The `powershell.exe -NoProfile … -File` form that antivirus heuristics flagged on a reporter's machine is no longer the default (`-Handler powershell` keeps it as an alternative) |
| The registry changes are reversible | `-DryRun` prints the exact `HKCU` operations and writes nothing; whichever handler registers, a pre-existing scheme key is exported with `reg export` to `%LOCALAPPDATA%\bingetovlc\backup` before it is overridden, and restored on uninstall |
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
Windows once.

**The default handler is a native executable, and needs no PowerShell.**
Download `bingetovlc-handler.exe` (the `bingetovlc-handler-windows-x86_64`
artefact from the latest CI run, or a release), then run:

```bat
bingetovlc-handler.exe --install
```

Double-clicking it does the same and confirms with a message box. It registers
`vlc://` **for the current user only** (HKCU) so a machine-wide handler installed
by something else is not damaged, also registers `bingetovlc://` as a
collision-free alias, auto-detects VLC (`Program Files`, `Program Files (x86)` or
the `HKLM\SOFTWARE\VideoLAN\VLC` key), backs up any pre-existing scheme key
first, and restores it on `--uninstall`.

The exe launches `vlc.exe` directly: the registered command line is
`"C:\...\bingetovlc-handler.exe" "%1"`, with **no script host in the runtime
path**. That is the point of it — the previous
`powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden … -File …` form is
exactly the command-line signature antivirus heuristics flag, and on the machine
that reported it the handler never ran. The exe is **unsigned**, so Windows
Defender / SmartScreen may inspect or prompt the first time it runs; the source
(`tools/windows/launcher.c`) and the CI build that produced the artefact are both
published, so you can verify or rebuild it rather than trust a download.

Prefer a helper (it delegates to the exe) or want the PowerShell handler instead:

```powershell
git clone https://github.com/red4711/bingetovlc.git
cd bingetovlc\tools\windows
powershell -ExecutionPolicy Bypass -File .\install.ps1                     # -Handler auto -> the exe when present
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Handler powershell # the script handler instead
```

Verify, then undo:

```bat
bingetovlc-handler.exe --diagnostics          :: VLC path + registration state
bingetovlc-handler.exe --uninstall            :: restores the previous state
```

The first time you click **Play in VLC**, Chrome asks for permission to open an
external application. Accepting is remembered for that site, so it asks once.

Two details worth knowing, both from Chromium's own source rather than folklore:

* The **"Always open" checkbox was removed from Chrome's dialog in Chrome 77**. It
  only comes back if an administrator enables the
  `ExternalProtocolDialogShowAlwaysOpenCheckbox` policy. Chrome's per-site memory
  is the mechanism you will actually see.
* A **user gesture is required**, and Chrome decides whether it may remember the
  answer per origin. The hand-off therefore happens on your click, not from a timer
  or a page load.

**Firefox:** it needs one explicit opt-in before it will hand a scheme to an
external application — set `network.protocol-handler.expose.vlc` to `false` in
`about:config`, then click a Play button and choose VLC in the prompt. Without
that, Firefox silently does nothing.

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
* The native handler is a standalone `.exe` and needs nothing else; rebuilding it
  from source needs only [Zig 0.13.0](https://ziglang.org/download/0.13.0/)

## Documentation

| Document | Contents |
|---|---|
| [`docs/SPEC.md`](docs/SPEC.md) | Frozen interfaces: payload v2, M3U rules, Emby API contract, module layout |
| [`docs/vlc-notes.md`](docs/vlc-notes.md) | What VLC and Windows actually do, with sources: the ~2 KB URI cap, header options, why `vlc://` needs registering, HLS/DRM limits, and the prior art |
| [`docs/how-it-works.md`](docs/how-it-works.md) | The API findings behind every design decision, with the evidence |
| [`docs/security.md`](docs/security.md) | Token exposure, temp-file handling, threat model |
| [`docs/troubleshooting.md`](docs/troubleshooting.md) | Nothing happens / wrong episode / VLC opens but stalls |

## Development

```bash
python3 tools/build.py                 # src/ -> dist/bingetovlc.user.js (single file)
# A bare directory argument (`node --test tests/`) stopped working in Node 23+.
node --test "tests/unit/**/*.test.mjs"   # unit tests (no dependencies)
node --test "tests/e2e/**/*.test.mjs"    # end-to-end: fake Emby server + real Chrome
```

The tests, the reference Python decoder and the Windows handlers must agree on
the same conformance vectors — that is what keeps "the playlist plays the wrong
episodes" from ever shipping. Both the native exe and the PowerShell handler are
asserted against those vectors in CI.

## License

MIT — see [`LICENSE`](LICENSE).
