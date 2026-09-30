# Security policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report privately through GitHub's private vulnerability reporting for this
repository: go to the **Security** tab and choose **Report a vulnerability** (a
draft security advisory). That keeps the report visible only to the maintainers
until a fix is ready.

Please include:

* what the issue is and why it is a security problem;
* the smallest reproduction you can give (a payload, a URI, a command);
* versions: Emby server, VLC, OS and browser;
* whether the issue is already public.

Never include a real Emby API token in a report. Use an obviously fake one
(`0123456789abcdef0123456789abcdef`), and strip query strings from any playlist
you attach — see [`docs/security.md`](docs/security.md) §1.

We will acknowledge the report, agree a disclosure timeline with you, and credit
you in the advisory unless you prefer otherwise.

---

## Scope

**In scope.** Issues in bingetovlc itself:

| Area | What that covers |
|---|---|
| Token handling | The token travelling in playlist URLs and handoff URIs; whether it is ever written or logged where it should not be |
| Temporary playlist lifecycle | The `.m3u` written under `%LOCALAPPDATA%`, when it is created, and that it is deleted when VLC exits |
| Registry handling | The `HKCU` scheme registration, the backup taken before override, and restoration on uninstall |
| Payload parsing | Whether a crafted payload can achieve anything beyond producing a playlist file — injection into the `.m3u`, bypass of validation, or anything resembling code execution |

**Out of scope.** The following are not vulnerabilities in bingetovlc:

* **Emby server misconfiguration.** Server permissions, token policy, TLS setup,
  and the exposure of the Emby API are the operator's responsibility. A token
  that grants more than it should is an Emby account concern, not a bug here.
* **DRM circumvention.** bingetovlc direct-plays the original file. It does not
  attempt to circumvent content protection, and this is **not supported by
  design**. A report asking it to play DRM-protected content is out of scope.
* **A compromised local machine.** Anything running as the user can read the
  temporary playlist and the handler log while they exist. bingetovlc does not
  defend an already-compromised host.
* **The token being visible in a URL.** This is the design that lets VLC play
  without headers; it is documented and intentional, not a vulnerability. If you
  believe the trade-off is wrong in a specific case, open a normal discussion
  rather than a security report.

### Known open item

The M3U serialiser writes item URLs verbatim and the payload validator's
absolute-URL check is not anchored at the end of the string. Whether the Windows
handler performs stronger validation is **not verified** — the PowerShell source
was not available to inspect. This is described in
[`docs/security.md`](docs/security.md) §6.1. Reports that demonstrate playlist
line injection from a crafted payload are welcome and in scope.

---

## Supported versions

The project is **pre-1.0**. Only the latest `main` is supported; there are no
maintenance branches for older tags.

## Related

* [`docs/security.md`](docs/security.md) — the full threat model: what is and is
  not protected.
* [`docs/troubleshooting.md`](docs/troubleshooting.md) — collecting a bug report
  without leaking a token.