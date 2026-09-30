# bingetovlc — Windows protocol handler (`tools/windows/`)

This directory registers the `vlc://` and `bingetovlc://` URL schemes so a link
produced by the userscript hands a playlist straight to VLC for **direct play**
(no transcoding). It implements the Windows handler contract in
[`docs/SPEC.md`](../../docs/SPEC.md) sections 3, 6 and 7.

**The default handler is the native executable `bingetovlc-handler.exe`.** It
launches `vlc.exe` directly, with no script host anywhere in the runtime path.
The previously-registered command line —

```
powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File …
```

— is exactly the command-line signature antivirus / EDR heuristics flag; on the
machine that reported it, the handler never ran. The exe removes that signature
from the runtime path entirely, and it can register itself
(`bingetovlc-handler.exe --install`), so installing needs **no PowerShell at
all** — which also matters when the machine's PowerShell is itself blocked.

| File | Purpose |
|---|---|
| `launcher.c` | Source of the native handler; builds to `bingetovlc-handler.exe`. |
| `build-launcher.sh` | Builds the exe with the pinned Zig toolchain (no other compiler needed). |
| `bingetovlc-handler.exe` | The native handler — **built, not committed**. Get it from the CI artefact / a release, or build it. |
| `selftest-launcher.ps1` | CI entry point: asserts the exe's M3U against `tests/fixtures/vectors.json`. |
| `bingetovlc-handler.ps1` | The **alternative** handler, a PowerShell script implementing the same contract. |
| `install.ps1` | Per-user registration / removal helper; delegates to the native exe by default. |
| `uninstall.ps1` | Thin wrapper around `install.ps1 -Uninstall`. |
| `selftest.ps1` | CI entry point for the PowerShell handler (same vectors). |
| `bingetovlc-scheme.reg` | Commented template for manual import — points at the exe. |
| `bingetovlc-scheme-remove.reg` | Commented template that removes the keys. |
| `README.md` | This file. |

Everything is dependency-free: the exe needs nothing beyond Windows and
`vlc.exe`, and the PowerShell scripts target **Windows PowerShell 5.1** and are
ASCII-only.

---

## Install

### The native handler (default — no PowerShell)

Download `bingetovlc-handler.exe` — from the `bingetovlc-handler-windows-x86_64`
artefact of the latest CI run, or from a release — and put it in this directory
(or anywhere you like), then run:

```bat
bingetovlc-handler.exe --install
```

Double-clicking the exe does the same and confirms with a message box. It
registers **both** `vlc://` and `bingetovlc://` for the current user, backs up
any pre-existing scheme key first, and prints a before/after summary. No script
host is involved, so a machine where PowerShell is blocked can still register
the scheme.

```bat
bingetovlc-handler.exe --install --scheme vlc        :: register only vlc://
bingetovlc-handler.exe --install --vlc "C:\Program Files\VideoLAN\VLC\vlc.exe"
```

### Or via install.ps1 (which delegates to the exe)

If you would rather use a helper — or you want the PowerShell handler instead —
`install.ps1` selects the handler for you:

```powershell
cd <repo>\tools\windows
powershell -ExecutionPolicy Bypass -File install.ps1                  # -Handler auto: the exe when present
powershell -ExecutionPolicy Bypass -File install.ps1 -DryRun          # show the operations, write nothing
powershell -ExecutionPolicy Bypass -File install.ps1 -Diagnostics     # report and exit
powershell -ExecutionPolicy Bypass -File install.ps1 -Scheme vlc      # register only vlc://
powershell -ExecutionPolicy Bypass -File install.ps1 -VlcPath "C:\Program Files\VideoLAN\VLC\vlc.exe"
powershell -ExecutionPolicy Bypass -File install.ps1 -Handler powershell   # the script handler instead
```

`-Handler auto` (the default) is the native exe when `bingetovlc-handler.exe`
sits next to `install.ps1`, and the PowerShell handler when it does not. In exe
mode `install.ps1` runs `bingetovlc-handler.exe --install` for you and writes
nothing to the registry itself; `-DryRun` prints that exact command instead of
running it. `-Handler exe` refuses to fall back — it fails if the exe is absent.

### Build it yourself

Zig **0.13.0** is the only tool needed:

```bash
bash tools/windows/build-launcher.sh
```

That is the same command CI runs:

```
zig cc -target x86_64-windows-gnu -static -Os -s -o tools/windows/bingetovlc-handler.exe tools/windows/launcher.c
```

### What gets written

Registration is **per-user**, under `HKCU\Software\Classes` (never `HKLM`, so
no admin rights and nothing machine-wide is changed):

```
HKEY_CURRENT_USER\Software\Classes\vlc
    (Default)        = "URL:vlc Protocol"
    URL Protocol     = ""                                  <- required for a custom URL scheme
    DefaultIcon
        (Default)    = "C:\Program Files\VideoLAN\VLC\vlc.exe",0
    shell\open\command
        (Default)    = "C:\...\bingetovlc-handler.exe" "%1"

HKEY_CURRENT_USER\Software\Classes\bingetovlc      (same shape)
```

With `-Handler powershell` the command value is the older script-host form
instead (`powershell.exe -NoProfile … -File "…\bingetovlc-handler.ps1" "%1"`).

`HKEY_CLASSES_ROOT` is a merged view of `HKLM\Software\Classes` and
`HKCU\Software\Classes`. **A `HKCU` entry wins for the current user**, which is
exactly why `vlc://` is registered there: it overrides any machine-wide `vlc://`
handler **for the current user only**, without administrator rights and without
disturbing any other user on the machine.

After installing, open a `vlc://` link once from the browser. **Chrome and Edge
ask once** ("Open vlc?") and then remember your answer for that site. The dialog's
"Always allow" checkbox was removed in Chrome 77, so its absence is expected; it
returns only under the `ExternalProtocolDialogShowAlwaysOpenCheckbox` policy.

> **The exe is unsigned.** Windows Defender and SmartScreen may inspect it, or
> prompt the first time it runs, because it is not code-signed. That is expected.
> The source (`launcher.c`) and the CI build that produces the artefact are both
> published, so you can read or rebuild the exact binary rather than trusting a
> download; `bingetovlc-handler.exe --selftest <uri>` and `--diagnostics` let you
> exercise it without registering anything.

---

## Verify

Native handler diagnostics (VLC path, both schemes' registration state, playlist
directory, last 20 log lines, current user):

```bat
bingetovlc-handler.exe --diagnostics
```

See the exact command the scheme would run:

```powershell
reg query "HKCU\Software\Classes\vlc\shell\open\command"
```

Exercise the PowerShell handler end to end (decodes a URI, writes an `.m3u`,
launches VLC):

```powershell
powershell -ExecutionPolicy Bypass -File bingetovlc-handler.ps1 "vlc://open?url=https%3A%2F%2Fmedia.example.com%2FVideos%2F1%2Fstream%3FStatic%3Dtrue%26api_key%3D0123456789abcdef0123456789abcdef&t=Test"
```

Conformance against the golden vectors — the native handler (this is what the
`windows-native-handler` CI job runs):

```powershell
pwsh -File selftest-launcher.ps1 -ExePath bingetovlc-handler.exe -VectorsPath ..\..\tests\fixtures\vectors.json
```

and the PowerShell handler (the `windows-handler` CI job):

```powershell
powershell -File selftest.ps1 -VectorsPath tests/fixtures/vectors.json
```

Both print `PASS` / `FAIL` per vector and exit non-zero on any mismatch. The
exe's `--selftest` path never touches the registry and never launches VLC, so it
also runs with a *Linux* build of `launcher.c`:

```bash
pwsh -File tools/windows/selftest-launcher.ps1 -ExePath /tmp/launcher-linux -VectorsPath tests/fixtures/vectors.json
```

---

## Troubleshoot

**Nothing happens when I click a link.**
1. Confirm the scheme is registered: `reg query "HKCU\Software\Classes\vlc" /s`.
2. Confirm the command is right: `reg query "HKCU\Software\Classes\vlc\shell\open\command"`
   — it should point at `bingetovlc-handler.exe`, not `powershell.exe`.
3. Run the handler by hand with a known URI and inspect the exit code and the log.

**Antivirus blocked the old handler.** The native exe exists precisely because
the `powershell.exe … -File` command line is a heuristic signature. If AV still
flags the *script* handler, switch to the exe (`-Handler exe`); if it flags the
exe, the honest position is that an unsigned download may be queried — verify it
against the published source, or rebuild it, and allow the operation in the AV
product's log.

> **Rebuilding produces the same program, not the same bytes.** The linked PE
> header carries a build timestamp, and the pinned toolchain's linker accepts no
> flag to zero it, so a rebuild differs from the released file in that field (same
> size, same behaviour, same vectors). To check a download instead, compare the
> SHA-256 published with the release; to check the code, read
> `tools/windows/launcher.c` or rebuild it from the source in this repository.

**Log.** Every handler run appends to:

```
%LOCALAPPDATA%\bingetovlc\logs\handler.log
```

Open it with `notepad "%LOCALAPPDATA%\bingetovlc\logs\handler.log"`. It rotates
at about 1 MB (previous file kept as `handler.log.1`). **Full URLs are never
logged**: the `api_key` value and any query parameter whose name contains
`token` are replaced with `***` before a line is written.

**Exit codes** (also printed to the log):

| Code | Meaning |
|---|---|
| 0 | success |
| 2 | malformed URI (wrong scheme/path, no `d` or `url` parameter) |
| 3 | bad or unsupported payload (bad base64, bad JSON, version ≠ 1/2, item count ≠ `n`, non-absolute item URL) |
| 4 | VLC not found |
| 5 | could not write the playlist file |

**Playlist files.** The handler writes to
`%LOCALAPPDATA%\bingetovlc\playlists\bingetovlc-<utcstamp>-<rand>.m3u` and
**deletes it when VLC exits**, because it contains an API token. Files older than
7 days are pruned at startup as a backstop. Pass `--keep-playlist` (the exe) or
`-KeepPlaylist` (the script) to keep the file for debugging (remember it
contains a token).

**Browser keeps asking.** Chrome/Edge only remember after you tick **Always
allow**; if you dismissed it, open a `vlc://` link once more and tick the box.

**Wrong episodes / wrong order.** That is the exact bug class the conformance
vectors exist to catch. Run `selftest-launcher.ps1` (or `selftest.ps1`) — if it
passes, the handler is not reordering anything.

---

## Uninstall

```bat
bingetovlc-handler.exe --uninstall
```

or, which delegates to the above in exe mode,

```powershell
cd <repo>\tools\windows
powershell -ExecutionPolicy Bypass -File uninstall.ps1
```

For each scheme the uninstaller:

* **restores the pre-bingetovlc key** from its backup under
  `%LOCALAPPDATA%\bingetovlc\backup\<scheme>-<utcstamp>.reg` when one exists, or
* **deletes the key** when there is no backup, and
* prints a before/after summary of what it did.

Preview without changing anything:

```powershell
powershell -ExecutionPolicy Bypass -File uninstall.ps1 -DryRun
```

### Fully undo by hand

1. Remove the per-user keys:

   ```powershell
   reg delete "HKCU\Software\Classes\vlc" /f
   reg delete "HKCU\Software\Classes\bingetovlc" /f
   ```

   or double-click `bingetovlc-scheme-remove.reg`.

2. If you want a previously overridden handler back, re-import the relevant
   backup:

   ```powershell
   reg import "%LOCALAPPDATA%\bingetovlc\backup\vlc-<utcstamp>.reg"
   ```

3. Optionally delete the working directory (logs, backups, playlists):

   ```powershell
   remove-Item -Recurse -Force "$env:LOCALAPPDATA\bingetovlc"
   ```

4. Confirm nothing is left:

   ```powershell
   reg query "HKCU\Software\Classes\vlc"
   reg query "HKCU\Software\Classes\bingetovlc"
   ```

   Both should report that the key cannot be found.
