# Troubleshooting

Symptom, cause, fix. Grounded in the interfaces in [`SPEC.md`](SPEC.md) and the
verified behaviour in [`how-it-works.md`](how-it-works.md). Where a cause has
not been reproduced, it is marked **reported** or **assumed** — the fix is still
worth trying, but it is not a verified diagnosis.

Two things to have open while diagnosing:

* **The handler log** — `%LOCALAPPDATA%\bingetovlc\logs\handler.log`. Every run
  writes an entry and an exit code (`0` success, `2` malformed URI, `3` bad
  payload, `4` VLC not found, `5` write failure).
* **The Preview panel** — shows the exact queue (order, titles, runtimes, total).
  Many "wrong episode" reports are answerable here before touching anything else.

The single most useful command is the installer's own diagnostics:

```powershell
powershell -File .\install.ps1 -Diagnostics   # VLC path + scheme registration state
```

---

## 1. Symptom / cause / fix table

| Symptom | Most likely cause | Fix |
|---|---|---|
| Chrome never asks to open VLC | Scheme not registered, or registered for a different user | Run the installer for your account; re-check with `-Diagnostics` |
| Chrome asks every time | The allow decision is recorded per origin; a different hostname is a different origin | Accept the prompt for that origin; §2.2 |
| Chrome offers no **Always allow** option | The checkbox was removed in Chrome 77 and needs an enterprise policy to return | It is expected; accept the prompt once per origin; §2.3 |
| Clicking **Play in VLC** does nothing | Payload failed to decode, or the handler did not run | Read the handler log; try `-SelfTest`; §3 |
| VLC opens but sits at 0 % | Stream URL not returning bytes (auth or reachability) | §4, and the 401 section §5 |
| VLC plays a few seconds then stops | Connection interrupted; caching too low; server unreachable intermittently | §4.2 |
| Episodes played in VLC still show as unwatched in Emby | VLC speaks no Emby protocol, so nothing reports progress; this is expected, not a fault | §2 note below |
| HTTP 401 inside VLC | Token missing, wrong, or revoked | §5 |
| Wrong episode plays, or the queue is short | URI truncation, or an ordering/filter surprise | §6 |
| VLC opens the playlist but stops after one episode | Single-entry playlist, or the `one` option interfering | §7 |
| VLC was already open and nothing happens | `one` (reuse instance) option; new queue went to the existing window | §8 |
| Handler never runs; AV or Windows blocks PowerShell | Execution policy or antivirus | §9 |
| The scheme is hijacked by another application | Machine-level `vlc://` owner | §10 |
| A big series downloads an `.m3u` instead of firing the URI | Queue exceeded the URI budget — intended | §11 |
| Subtitles or an audio track missing | Not the container; choice inside VLC | §12 |
| — | — | Collect a report: §13 |

---

## 2. Chrome: never asks, asks every time, or offers no *Always allow*

### 2.1 Chrome never asks

**Cause.** The `vlc://` scheme is not registered for the Windows account running
the browser. Possible reasons: the installer was never run; it was run for a
different user (the keys are per-user, `HKCU`); or it was uninstalled.

**Fix.**

```powershell
cd bingetovlc\tools\windows
powershell -ExecutionPolicy Bypass -File .\install.ps1
powershell -File .\install.ps1 -Diagnostics     # confirm the registration is present
```

`-Diagnostics` prints the VLC path and the scheme registration state. If it
reports the scheme as absent for your account, re-run the install step. See
[`security.md`](security.md) §4 for why the registration is per-user.

### 2.2 Chrome asks every time

**Cause.** Chrome records an external-protocol allow decision **per origin**, and
only for potentially-trustworthy origins (https), in the profile preference
`protocol_handler.allowed_origin_protocol_pairs`. If no decision is recorded for
that origin, every hand-off prompts.

**Fix.** Accept the prompt once for that origin. If it asks again next time, check
whether you are reaching the same Emby server through a different address: a LAN
address and a WAN address are different origins, and each one prompts separately.
Sources: Chromium's `chrome/browser/external_protocol/external_protocol_handler.cc`
and `chrome/common/pref_names.cc`.

### 2.3 Chrome offers no *Always allow* option

**Cause.** The "Always open" checkbox was **removed from Chrome's dialog in Chrome
77**. It only comes back when an administrator enables the
`ExternalProtocolDialogShowAlwaysOpenCheckbox` policy, so on an ordinary profile the
checkbox is expected to be absent. Chrome's per-origin memory is the mechanism that
actually stops the prompting.

**Fix.** Nothing is broken: accept the prompt, and Chrome remembers that origin. If
you want no prompt at all, use **Copy / Download .m3u** — a downloaded `.m3u` opens
the same queue in VLC on double-click and never touches the protocol handler.

**On Firefox** the scheme is never handed over until you opt in: set
`network.protocol-handler.expose.vlc` to `false` in `about:config`, then click a
Play button and pick VLC in the prompt.

---

## 3. Clicking **Play in VLC** does nothing

**Cause, in order of likelihood:**

1. The payload failed to decode or validate (truncated or malformed URI).
2. The handler never ran at all (see §9).
3. The handler ran and exited non-zero.

**Fix — start at the log.** `%LOCALAPPDATA%\bingetovlc\logs\handler.log`. Read
the last entry and its exit code:

| Exit code | Meaning | Next step |
|---|---|---|
| `0` | success | VLC was launched; see §4 if nothing appeared |
| `2` | malformed URI | the URI was cut off or mangled in transit; §6 |
| `3` | bad payload | base64/JSON validation failed; §6 |
| `4` | VLC not found | re-run the installer with `-VlcPath` |
| `5` | write failure | the playlists directory is not writable |

If there is **no new log entry**, the handler never ran → §9 (antivirus,
execution policy) or §2 (scheme not registered). To exercise the handler without
VLC, run its self-test:

```powershell
powershell -File .\tools\windows\bingetovlc-handler.ps1 -SelfTest "vlc://open?d=..."
```

`-SelfTest` decodes the URI and prints the exact M3U to stdout without launching
VLC. If that fails, the problem is in the payload path; if it succeeds, the
problem is in the launch path.

---

## 4. VLC opens but sits at zero percent, or stops after a few seconds

### 4.1 Sits at zero percent

**Cause.** VLC has the playlist but is not receiving bytes from the stream URL.
The most common reason is that the URL is not authenticated or not reachable —
which usually shows as `401` (§5) — but a `0 %` stall without a visible error is
typically a connectivity or serving problem rather than a playlist problem.

**Fix.**

1. Confirm the URL is the one bingetovlc built. In the Preview panel, or from
   the handler log, you can see the item URLs (tokens redacted in the log).
2. Verify the server is reachable from the VLC machine — the address the
   userscript used comes from the web client's session, so a stream URL may
   point at a LAN address (`192.168.x.x`) that is not routable from where VLC is
   running, or vice versa.
3. Check whether the same URL plays in a browser session (with the token) — that
   isolates the server from VLC.

### 4.2 Stops after a few seconds

**Cause.** Playback starts and then the transfer is interrupted. A direct play is
a single long HTTP request for a multi-gigabyte file; anything that resets that
connection stops playback. Candidate causes, **not verified** individually:
server-side timeout or bandwidth cap, a proxy or antivirus intercepting the
connection, or an unstable link. Direct play has no segmenting to fall back on.

**Fix.**

* Raise VLC's network caching (this is the `opts.cache` value, exposed in the
  panel; the handler writes `#EXTVLCOPT:network-caching=<ms>`). More buffering
  tolerates a slower or jittery link.
* Test the same URL from the same machine with a plain download to see whether
  the connection is stable outside VLC.
* If the server closes long-lived connections, this is a server/proxy property,
  not something the userscript changes. It is out of scope for bingetovlc (the
  design is byte-exact passthrough; see [`how-it-works.md`](how-it-works.md) §1).

> A stall is **not** expected to come from the playlist itself: items with no
> file (`LocationType == "Virtual"`) and items with an empty `Path` are filtered
> out before the payload is built. If a stall lands exactly where a filtered item
> would have been, it is worth reporting (§13) as the filter may have missed a
> shape.

---

## 5. HTTP 401 inside VLC

**Cause.** The stream endpoint returned `401`, which is what Emby returns for an
unauthenticated request:

```
GET {server}/Videos/{itemId}/stream?Static=true&api_key={token}   → 401 when the token is absent/invalid
```

Possible reasons: the token is missing from the URL (a payload built by hand,
or stripped by a copy/paste); the token expired; the token was revoked (for
example by signing out of that Emby session); or the item does not exist for
that user.

**Fix.**

* Re-open the item in the Emby web app and click **Play in VLC** again — the
  script rebuilds the URL from the current session token.
* If you are testing a URL by hand, confirm it carries `api_key=…`. The endpoint
  accepts the token either as the `api_key` query parameter or as an
  `X-Emby-Token` header; VLC uses the query parameter (see
  [`how-it-works.md`](how-it-works.md) §1.3).
* Revoked/expired tokens are an Emby account concern, not a bingetovlc one.

---

## 6. Wrong episode plays, or the queue is short

### 6.1 The queue is short — URI truncation

**Cause.** A long URI was cut off somewhere between the browser and the handler.
This is the exact bug class the payload format is designed to catch (see
[`how-it-works.md`](how-it-works.md) §2.3), and when it is caught the handler
exits `3` (bad payload) rather than playing a short queue. If a queue is short
**and** the handler logged `0`, the truncation happened in a way that preserved
a valid payload, or the payload was built short.

**Fix.**

1. Check the handler log exit code. `2` or `3` means truncation/corruption;
   re-click from the page (a fresh URI).
2. Use **Preview** to see what the script thinks the queue is. If Preview is
   correct but VLC's playlist is short, the problem is between Preview and VLC —
   collect a report (§13).
3. Long queues are supposed to use the **download `.m3u`** path, not a URI
   (§11). If a big queue was sent as a URI anyway, that is a bug worth reporting.

### 6.2 The wrong episode plays

**Cause.** Ordering is explicit and tested (`(ParentIndexNumber, IndexNumber)`,
then `AiredEpisodeNumber`, then id; duplicates dropped). A genuinely wrong
episode therefore points at one of:

* the wrong item was selected on the page (the script queues what the page says
  it is);
* episode metadata on the server is wrong (`IndexNumber`/`ParentIndexNumber`),
  in which case the queue is "correct" for the metadata it was given;
* a resume/start-index setting is in effect — `opts.start` (1-based) and the
  **Play from here** action start the queue at a non-first item by design.

**Fix.** Open **Preview** first: it shows the order, titles and total runtime
before anything launches. If Preview shows the wrong item, check the item's
metadata in Emby. If Preview is right and VLC plays something else, collect a
report (§13) — that would be a handoff bug, and the vector tests exist precisely
to prevent it.

---

## 7. VLC opens the playlist but does not advance to the next episode

**Cause candidates (report the one that matches):**

1. **The playlist really has one entry.** If the page was a single item (a movie
   or one episode with scope `item`), the handoff is a one-entry playlist by
   design. Use **Play from here** or the season/series action for a queue.
2. **The manual single-item form was used.** The handler also accepts
   `vlc://open?url=…&t=…` (one URL, not a payload). If something fired that form,
   the result is a single item. The payload form (`d=…`) is what produces a
   queue.
3. **The `one` option handed the queue to an existing VLC window** (§8), which
   may still be showing the old, single-item playlist.
4. **VLC's own repeat/loop or a stuck item** — a VLC playback state, not a
   bingetovlc one.

**Fix.** Confirm the queue length in **Preview**. If Preview shows N episodes
and VLC shows one, inspect the temporary playlist file (start the handler with
`-KeepPlaylist`, then open the generated `.m3u` from
`%LOCALAPPDATA%\bingetovlc\playlists\`): it should contain one `#EXTINF` line and
one URL per episode. If it does, the file is correct and the issue is VLC
playback; if it does not, collect the file with tokens stripped (§13).

---

## 8. VLC was already open and nothing happens (the one-instance option)

**Cause.** The **reuse a running VLC instance** setting (`opts.one`) sends the
new playlist to an already-running VLC instead of starting a new one. If VLC is
open on another desktop, minimised, or behind the browser, it can look as though
nothing happened — the queue went to the existing window.

**Fix.**

* Bring the already-open VLC to the front; the new queue is likely there.
* Or turn off **reuse a running VLC instance** so each click starts/resets a
  window.
* Note that single-instance handoff depends on VLC's own settings; the exact
  interaction is VLC behaviour and is **not verified** here.

---

## 9. Antivirus or Windows blocks the PowerShell handler

**Cause.** The handler is a PowerShell script invoked through the registry. Two
things can stop it before it writes a log entry: the effective execution policy
on the machine/account, and antivirus or Windows Defender heuristics that block
script-based protocol handlers.

**Fix.**

1. Confirm the function first, independent of the registry:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\tools\windows\bingetovlc-handler.ps1 -SelfTest "vlc://open?d=..."
   ```

   If this fails, the block is on the handler itself → execution policy or AV.
2. Re-run the installer command with `-ExecutionPolicy Bypass` (as shown in the
   [README](../README.md)).
3. If antivirus is quarantining or blocking it, add an exclusion for the handler
   script path, or allow the operation in the AV product's log.
4. Check the handler log: if a click produces **no new entry**, the handler never
   started → §9; if it logs `4`, VLC was not found → re-run the installer with
   `-VlcPath "C:\path\to\vlc.exe"`.

---

## 10. The scheme is hijacked by another application

**Cause.** Something else owns `vlc://`, most often a machine-level (`HKLM`)
registration written by another VLC-related tool or an installer. bingetovlc
registers per-user (`HKCU`), which is intended to shadow the machine-wide handler
for your account only.

**Fix.**

* Run `-Diagnostics` to see the current registration state.
* Because `HKCU` registration is what bingetovlc installs, re-running the
  installer for your user re-asserts it.
* The installer backs up any pre-existing scheme key to
  `%LOCALAPPDATA%\bingetovlc\backup\<scheme>-<utcstamp>.reg` before overriding it
  and restores it on `-Uninstall`. If something feels wrong after uninstall, that
  backup file is the record of the prior state. See
  [`security.md`](security.md) §4.
* If a machine-wide owner keeps winning, register only the collision-free alias:
  `install.ps1 -Scheme bingetovlc`. The userscript can be pointed at that scheme.

---

## 11. A series with hundreds of episodes goes down the m3u download path

**Cause — this is intended.** A URI has a practical size ceiling. `chooseHandoff`
switches to the download path when either limit is exceeded:

| Condition | Mode | Reason |
|---|---|---|
| more than `200` items | `download` | `too-many-items` |
| URI longer than `1800` bytes | `download` | `uri-too-long` |

A 28-episode season is ~1,584 bytes as ids and stays a URI. (With full stream URLs
it was 5,471 bytes, which is past the ~2,046-character limit Windows applies to an
external-protocol URI — that version would have failed by doing nothing at all.) A
120-episode series is ~9.7 KB and does not fit. Instead of firing a `vlc://` URI, the script hands you an
`.m3u` file; double-clicking it opens the same queue in VLC.

**Fix.** Nothing to fix — this is the fallback working. If you expected a URI
launch for a large series, that is out of budget; see
[`how-it-works.md`](how-it-works.md) §3.2 and §8 for the numbers.

---

## 12. Subtitles or an audio track missing

**Cause.** Direct play delivers the original MKV with embedded ASS subtitles and
font attachments and every audio track intact (see [`how-it-works.md`](how-it-works.md)
§1). A missing subtitle or audio track is therefore, in the normal case, a choice
made **inside VLC** — which subtitle/track is selected, or whether subtitle
rendering is on at all — not a container that lost data.

**What to check in VLC:**

* **Subtitle → Subtitle Track** and **Audio → Audio Track** menus: the embedded
  tracks should be listed; select the one you want.
* **Tools → Preferences → Subtitles / OSD → Fonts**: ASS subtitles use their own
  styling, and attached fonts are applied when the attachment is present. The
  exact rendering of embedded ASS subtitles and font attachments is VLC
  behaviour and is **not verified** in this repository — the project does not
  process subtitles.
* An external subtitle track that only exists in the Emby library (not inside the
  MKV) will not travel with the stream URL, because the URL is the file's own
  stream endpoint. If the track is embedded, it is there.

**If a track is genuinely absent from VLC's track list**, collect a report (§13):
that would suggest the file served differs from the file on disk, which is the
one thing this project guarantees it does not do.

---

## 13. How to collect a useful bug report

A report that pins down *where* the handoff failed is a hundred times more useful
than a report that says "it doesn't work". Include:

1. **Versions and environment**
   * Emby server version (the tested server was 4.10.0.40).
   * VLC version.
   * OS and browser (and userscript manager, e.g. Tampermonkey version).
2. **Page type** — movie, episode, season or series. The code path differs per
   type (`Item` vs `Episode` vs `Season` vs `Series`), so this is often the whole
   answer.
3. **Which handoff you used** — did the click try to fire the `vlc://` **URI**
   path, or did you use the **`.m3u` download** path? They exercise different
   code.
4. **Diagnostics output**
   ```powershell
   powershell -File .\install.ps1 -Diagnostics
   ```
5. **The handler log excerpt** — the tail of
   `%LOCALAPPDATA%\bingetovlc\logs\handler.log`, including the exit code. The
   log is required to redact tokens; **read it before posting** and strip
   anything that looks like a token if the redaction missed it.
6. **The shareable playlist or URI — with tokens stripped.** The m3u builder
   produces a shareable form with query strings removed
   (`buildM3u(payload, { includeTokens: false })`), so entries read
   `https://…/Videos/123/stream` with no `api_key`. Use that. If you must share a
   URI, strip the `d=…` payload or decode it and remove the token.

> **Do not paste a token-bearing playlist.** Every URL in a normal `.m3u`
> contains your Emby API token, and pasting one into a public issue is handing
> out access to your server as that user. The bug report form asks for a
> **token-stripped** playlist for exactly this reason. See
> [`security.md`](security.md) §1.

---

## Related documents

* [`SPEC.md`](SPEC.md) — payload, M3U, handler and installer contracts.
* [`how-it-works.md`](how-it-works.md) — the behaviour behind these symptoms.
* [`security.md`](security.md) — tokens, the temporary playlist, the registry.
* [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — how to reproduce a bug locally.