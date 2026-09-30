# bingetovlc — Windows protocol handler (`tools/windows/`)

This directory registers the `vlc://` and `bingetovlc://` URL schemes so a link
produced by the userscript hands a playlist straight to VLC for **direct play**
(no transcoding). It implements the Windows handler contract in
[`docs/SPEC.md`](../../docs/SPEC.md) sections 3, 6 and 7.

| File | Purpose |
|---|---|
| `bingetovlc-handler.ps1` | The handler Windows runs for a `vlc://` / `bingetovlc://` link. |
| `install.ps1` | Per-user registration / removal helper. |
| `uninstall.ps1` | Thin wrapper around `install.ps1 -Uninstall`. |
| `selftest.ps1` | CI entry point: checks the M3U against `tests/fixtures/vectors.json`. |
| `bingetovlc-scheme.reg` | Commented template for manual (double-click) import. |
| `bingetovlc-scheme-remove.reg` | Commented template that removes the keys. |
| `README.md` | This file. |

Everything here is dependency-free: no modules, no NuGet, no binaries beyond
`vlc.exe` and what Windows already ships. The scripts target **Windows
PowerShell 5.1** and are ASCII-only.

---

## Install

Open PowerShell (no administrator needed — this is per-user):

```powershell
cd <repo>\tools\windows
powershell -ExecutionPolicy Bypass -File install.ps1
```

Optional:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -DryRun          # show the registry ops, write nothing
powershell -ExecutionPolicy Bypass -File install.ps1 -Scheme vlc      # register only vlc://
powershell -ExecutionPolicy Bypass -File install.ps1 -VlcPath "C:\Program Files\VideoLAN\VLC\vlc.exe"
```

`install.ps1` registers **both** `vlc` and `bingetovlc` by default, detects VLC
the same way the handler does, and — before overriding any pre-existing scheme
key — exports it to:

```
%LOCALAPPDATA%\bingetovlc\backup\<scheme>-<utcstamp>.reg
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
        (Default)    = powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden
                       -ExecutionPolicy Bypass -File "<...>\bingetovlc-handler.ps1" "%1"

HKEY_CURRENT_USER\Software\Classes\bingetovlc      (same shape)
```

`HKEY_CLASSES_ROOT` is a merged view of `HKLM\Software\Classes` and
`HKCU\Software\Classes`. **A `HKCU` entry wins for the current user**, which is
exactly why `vlc://` is registered there: it overrides any machine-wide `vlc://`
handler **for the current user only**, without administrator rights and without
disturbing any other user on the machine.

After installing, open a `vlc://` link once from the browser. **Chrome and Edge
ask once** ("Open vlc?") and offer **Always allow** — tick the box to stop
prompting. Firefox remembers the choice after its own checkbox prompt.

---

## Verify

Handler diagnostics (VLC path, both schemes' registration state, playlist
directory, last 20 log lines, current user):

```powershell
powershell -ExecutionPolicy Bypass -File bingetovlc-handler.ps1 -Diagnostics
```

See the exact binary the scheme would run:

```powershell
reg query "HKCU\Software\Classes\vlc\shell\open\command"
```

Exercise the handler end to end (decodes a URI, writes an `.m3u`, launches
VLC). This uses the tiny inline example payload:

```powershell
# a one-item payload (title "Test", no duration) pointed at a real stream URL
powershell -ExecutionPolicy Bypass -File bingetovlc-handler.ps1 "vlc://open?url=https%3A%2F%2Fmedia.example.com%2FVideos%2F1%2Fstream%3FStatic%3Dtrue%26api_key%3D0123456789abcdef0123456789abcdef&t=Test"
```

Conformance against the golden vectors (this is what CI runs):

```powershell
powershell -File selftest.ps1 -VectorsPath tests/fixtures/vectors.json
```

It prints `PASS` / `FAIL` per vector and exits non-zero on any mismatch. It never
touches the registry and never launches VLC, so it also runs under portable
PowerShell on Linux:

```bash
pwsh -File tools/windows/selftest.ps1 -VectorsPath tests/fixtures/vectors.json
```

---

## Troubleshoot

**Nothing happens when I click a link.**
1. Confirm the scheme is registered: `reg query "HKCU\Software\Classes\vlc" /s`.
2. Confirm the command is right: `reg query "HKCU\Software\Classes\vlc\shell\open\command"`.
3. Run the handler by hand with a known URI and inspect the exit code and the log.

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
| 3 | bad or unsupported payload (bad base64, bad JSON, version ≠ 1, item count ≠ `n`, non-absolute item URL) |
| 4 | VLC not found |
| 5 | could not write the playlist file |

**Playlist files.** The handler writes to
`%LOCALAPPDATA%\bingetovlc\playlists\bingetovlc-<utcstamp>-<rand>.m3u` and
**deletes it when VLC exits**, because it contains an API token. Files older than
7 days are pruned at startup as a backstop. Pass `-KeepPlaylist` to keep the file
for debugging (remember it contains a token).

**Browser keeps asking.** Chrome/Edge only remember after you tick **Always
allow**; if you dismissed it, open a `vlc://` link once more and tick the box.

**Wrong episodes / wrong order.** That is the exact bug class the conformance
vectors exist to catch. Run `selftest.ps1` — if it passes, the handler is not
reordering anything.

---

## Uninstall

```powershell
cd <repo>\tools\windows
powershell -ExecutionPolicy Bypass -File uninstall.ps1
```

For each scheme, `install.ps1 -Uninstall`:

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