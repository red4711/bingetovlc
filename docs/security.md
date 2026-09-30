# Security model

This is a threat model, not reassurance. It states what bingetovlc protects,
what it does not, and where the boundaries are. If a claim here cannot be tied
to the code or to [`SPEC.md`](SPEC.md), it is marked **untested**, **not
verified** or **assumed**.

bingetovlc's job is to put a token-bearing URL in front of VLC on your own
machine. That is inherently a small security surface — but it is not zero, and
pretending otherwise would be worse than documenting it.

---

## 0. Summary: what is and is not protected

**Protected (within the limits stated below):**

* The temporary playlist file is written to a per-user directory and deleted
  when VLC exits.
* The Windows protocol registration is per-user (`HKCU`) and the installer backs
  up any pre-existing key before overriding it.
* A payload is parsed as JSON and can only ever become a playlist file. It is
  data, not code; there is no shell, no `eval`, no command execution path from
  payload contents.
* The handler log is required to redact tokens.

**Not protected against:**

* **The API token is in every playlist URL.** Anyone who obtains a URL obtains
  the token. Hiding it in transit is not attempted.
* **Any page in the same browser can attempt to fire a `vlc://` URI.** At worst
  this queues media; it does not run code (see §5).
* **A local attacker with read access to your account** can read the temporary
  `.m3u` while it exists, and the handler log.
* **The handler log is required to be redacted, but the handler source has not
  been verified in this repository** — the PowerShell file is referenced by
  `SPEC.md` but was not present to inspect. Treat log redaction as a requirement
  to check, not a verified property.
* **DRM-protected content.** Out of scope by design; see §8.
* **Emby server misconfiguration.** Out of scope; see [`../SECURITY.md`](../SECURITY.md).

---

## 1. The token is in every playlist URL

The direct-play URL the script builds is:

```
{server}/Videos/{itemId}/stream?Static=true&api_key={token}
```

The token is a query parameter. That is not an oversight — it is the reason VLC
needs no headers, no cookies and no browser session, so a bare
`vlc.exe "<url>"` works. It also means:

* every entry in the temporary `.m3u` contains the token;
* every `vlc://open?d=…` URI the user copies, shares or pastes contains the
  token (once decoded, and visibly if they decode it);
* anything that can read the playlist file or the URI can read the token.

### 1.1 What the token can do

A valid Emby API token authenticates as the user it belongs to. With it, a
caller can reach the Emby API as that user: list that user's items, read item
metadata, and request the stream endpoint — which is precisely the capability
the project relies on.

### 1.2 What the token cannot do

* It does not grant operating-system access, shell access, or any capability
  outside the Emby HTTP API reached with it.
* It cannot exceed the permissions of the Emby account it was issued for. An
  Emby **user** token cannot perform administrator actions; an **admin** token
  is not more powerful than an admin account already is, but it is more powerful
  than a user token.
* It is not a replayable local credential: it authenticates HTTP requests
  against the Emby server, nothing else.

### 1.3 Recommendation: use a per-user Emby token

Because the token is unavoidably visible in every URL and playlist, **use a
token belonging to an ordinary, per-user Emby account rather than an
administrator token.** The script only needs: read the user's items, list
episodes, and stream files. An admin token grants strictly more than that, and
none of the extra is needed. If a token does leak, a user token limits the blast
radius to that user's content.

The userscript obtains the token from the web client's own session
(`ApiClient.accessToken()`), so in normal use it is already the token of the
logged-in user. This recommendation matters most when a token is provisioned by
hand or when the logged-in account happens to be an administrator.

---

## 2. The temporary playlist

* **Location:** `%LOCALAPPDATA%\bingetovlc\playlists\bingetovlc-<utcstamp>-<rand>.m3u`
* **Lifetime:** the handler writes it, launches VLC, waits for VLC to exit, then
  deletes it — unless `-KeepPlaylist` is passed, in which case it is left on
  disk deliberately.
* **Contents:** the full playlist, including the token in every URL.

### 2.1 What this protects against

The playlist does not linger after playback. Once VLC exits, the file that
contains the token is gone. The exposure window is the duration of playback,
not indefinitely.

### 2.2 What it does not protect against

* **While VLC is playing, the file exists.** Anything running as your user
  during that window can read it — including the token.
* **`-KeepPlaylist` leaves it on disk.** Do not use it on a shared machine, or
  delete the file afterwards.
* **The token is still in VLC's own memory, window title, history and logs.**
  This document does not claim anything about VLC's internals; that is VLC's
  behaviour, **not verified** here.
* **The `%LOCALAPPDATA%` directory is per-user, not encrypted.** It relies on
  the operating system's file permissions on your user profile.

---

## 3. The handler log

Every handler run is logged to `%LOCALAPPDATA%\bingetovlc\logs\handler.log`
(see [`SPEC.md`](SPEC.md) §6). Because the input to the handler is a URI whose
decoded payload contains authenticated stream URLs, **the log must redact
tokens** — `api_key=…` and any `token=…` query values — before writing an entry.

**Status: a requirement, not a verified property.** The handler was described in
`SPEC.md` but the PowerShell source was not present in this repository to
inspect. Anyone reviewing a build should confirm that:

* the raw URI is not logged verbatim;
* decoded item URLs are logged with query strings stripped;
* the log file is inside the per-user `%LOCALAPPDATA%` directory.

If you are collecting a log for a bug report, review it yourself before posting
it. See [`troubleshooting.md`](troubleshooting.md).

---

## 4. Registry: per-user (HKCU) and the machine-level case

The installer registers the schemes under:

```
HKCU\Software\Classes\vlc
HKCU\Software\Classes\bingetovlc
```

with `URL Protocol`, `DefaultIcon`, and `shell\open\command`. `HKCU` means **per
user**: the registration affects only the current Windows account.

### 4.1 Why per-user

* It does not need administrator rights.
* It does not modify the machine for other users.
* `HKCU` takes precedence over `HKLM` **for the current user**, so a per-user
  registration can override a machine-wide one for that user without touching
  the machine-wide key. (This precedence is standard Windows behaviour; the
  project relies on it, and it is **assumed** rather than tested against every
  Windows build.)

### 4.2 When another program already owns `vlc://`

Many VLC installs register a machine-level `vlc://` scheme. If another program
owns that scheme, bingetovlc's per-user key should shadow it for the current
user only — the machine-wide registration is not damaged.

**The installer backs up first.** Before overriding any pre-existing scheme key
it writes a backup to:

```
%LOCALAPPDATA%\bingetovlc\backup\<scheme>-<utcstamp>.reg
```

and `-Uninstall` restores the previous state. This is what makes the override
reversible. If uninstall appears to have left the scheme in a strange state,
the backup file is the authoritative record of what was there before —
see [`troubleshooting.md`](troubleshooting.md).

### 4.3 What the registry entry does and does not do

* It maps the scheme to a command. It is a launcher mapping, not a privilege
  grant.
* It does not run with elevated privileges. The handler runs as the logged-in
  user, which is why the playlist is written under that user's `%LOCALAPPDATA%`.
* It does not sandbox the handler: anything on the machine that can invoke the
  scheme can make the handler run. §5 covers what that implies.

---

## 5. Any page in the same browser can attempt to fire a `vlc://` URI

Once the scheme is registered, the browser's external-protocol mechanism is
available to **any page you visit**, not only to Emby. This is a property of
custom URI schemes, not a bingetovlc bug.

### 5.1 What a hostile page can achieve

At worst: **an unauthenticated queue.**

* A page can construct `vlc://open?d=…` with a payload it builds itself and
  cause Chrome to prompt (or, if the user has ticked *Always allow*, launch the
  handler). bingetovlc's own design goal — "the whole queue travels as a single
  argument, and the handler runs for a fraction of a second" — is exactly the
  shape a hostile page would abuse: it can queue arbitrary URLs in VLC on the
  user's machine.
* The URLs in such a payload are absolute `http(s)` URLs chosen by the page.
  They need not be Emby URLs at all — the payload is a generic playlist format.
* The result is media playing in VLC, or a VLC error if the URLs are not valid
  media.

### 5.2 What a hostile page cannot achieve

* **It cannot run arbitrary code through bingetovlc.** There is no `eval`, no
  shell interpolation, no command construction from payload contents. The
  payload is JSON; the handler turns it into a text `.m3u` and starts VLC.
* It cannot reach the user's Emby token *through the scheme* unless it already
  has that token from somewhere else. A hostile page cannot read another
  origin's `ApiClient` session or the userscript's variables.
* It cannot escalate to administrator or escape the user's profile via the
  handler; the handler runs as the user and writes into the user's own
  directory.

### 5.3 Reducing the exposure

* Untick or avoid *Always allow* if you want a prompt on every `vlc://`
  launch. (The prompt is Chrome's; the exact wording and whether it remembers
  per-origin is Chrome behaviour and **not verified** here.)
* Use a browser profile, or a browser, that you keep for trusted sites only.
* Uninstall the scheme (`install.ps1 -Uninstall`) if you no longer want any page
  to be able to reach VLC this way.

---

## 6. A payload is data, not code

This is the single most important boundary in the project, so it is stated
plainly:

* The handler receives a string, base64url-decodes it, **parses it as JSON**, and
  validates it (`payload.v === 1`, a non-empty `items` array, each item `u` an
  absolute URL). 
* The only thing a payload can become is **an `.m3u` file** — a text playlist —
  and a `vlc.exe` invocation pointed at that file.
* No field of the payload is interpolated into a shell command, an `eval`, a
  registry write, or a template that a shell later executes. The playlist path
  is generated by the handler, not taken from the payload.

### 6.1 Known limitation in the playlist serialiser (untested boundary)

The M3U serialiser writes each item's URL **verbatim**:

```js
lines.push(includeTokens ? item.u : stripQuery(item.u));
```

The payload validator checks that `item.u` *starts* with a scheme
(`^[a-zA-Z][a-zA-Z0-9+.-]*://`), but that pattern is **not anchored at the end**,
and the serialiser does not strip newlines from a URL. A URL that contained a
newline could therefore in principle inject additional lines into the playlist
file.

* **Untested:** whether the Windows handler performs an additional, stronger
  validation before writing the file is **not verified** in this repository —
  the PowerShell source was not available to inspect.
* **Consequence if unvalidated:** a crafted payload could add lines to an `.m3u`
  file (for example extra `#EXTVLCOPT` or URL lines). This is a playlist-content
  concern, not code execution.
* **Action:** treat this as an open item for review. The fix is to anchor the URL
  validation and strip control characters from `item.u` in the serialiser.

---

## 7. Trust boundaries, in one table

| Boundary | Trusted side | Untrusted side | Mitigation |
|---|---|---|---|
| Emby API | your Emby server | the network | TLS; token as query parameter |
| Handoff URI | the browser page | Windows registry / handler | URI-safe base64url alphabet, truncated-payload detection |
| Payload contents | — | anything that can fire the scheme | data-only; parsed as JSON; becomes an `.m3u` |
| Temporary playlist | nothing (it holds a token) | local processes as your user | deleted when VLC exits |
| Registry key | — | any process that can write HKCU | per-user; backed up before override |
| Handler log | — | anyone who can read the file | must redact tokens (requirement, not verified) |

---

## 8. Out of scope by design

* **DRM-protected content.** bingetovlc direct-plays the original file. If the
  media is DRM-protected, direct play does not apply, and no attempt is made to
  circumvent protection. This is a design boundary, not a bug.
* **Emby server misconfiguration.** Server permissions, token policy, TLS
  configuration and the exposure of the Emby API are the operator's
  responsibility. See [`../SECURITY.md`](../SECURITY.md).
* **A compromised local machine.** Anything running as your user can read the
  temporary playlist and the log while they exist. bingetovlc does not attempt
  to defend a host that is already compromised.

---

## Related documents

* [`SPEC.md`](SPEC.md) — payload format, M3U rules, handler and installer
  contract.
* [`how-it-works.md`](how-it-works.md) — why the handoff is shaped this way.
* [`troubleshooting.md`](troubleshooting.md) — how to collect a safe bug report
  with tokens stripped.
* [`../SECURITY.md`](../SECURITY.md) — how to report a vulnerability privately.