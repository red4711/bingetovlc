/**
 * bingetovlc — the handoff.
 *
 * Three ways a queue can reach VLC, in order of preference:
 *
 *   1. `vlc://open?d=<base64url>` — the registered protocol handler writes a
 *      temporary .m3u and starts VLC. One click, no file left behind.
 *   2. The same URI via the `bingetovlc://` alias, when something else already
 *      owns `vlc://` on that machine.
 *   3. A downloaded `.m3u` — no registry involvement at all, works for queues
 *      too long to survive a URI, and is the honest fallback when the browser
 *      refuses the scheme.
 *
 * Test hook (used by tests/e2e, and documented in docs/SPEC.md): when the page
 * sets `window.__BINGETOVLC_TEST_MODE__ = true`, no navigation happens and a
 * `bingetovlc:handoff` CustomEvent is dispatched instead, carrying the URI and
 * the decoded payload. Headless Chrome cannot complete an external protocol
 * launch, so without this hook the end-to-end test would have nothing to assert.
 */

import { chooseHandoff, MAX_URI_ITEMS, MAX_URI_LENGTH, launchUri } from "./payload.js";
import { buildM3u, playlistFilename } from "./m3u.js";

export const DEFAULT_SCHEME = "vlc";
export const ALIAS_SCHEME = "bingetovlc";

export function handoffEventName() {
  return "bingetovlc:handoff";
}

export function isTestMode(win) {
  try {
    return Boolean(win && win.__BINGETOVLC_TEST_MODE__);
  } catch {
    return false;
  }
}

/**
 * Choose the transport and, unless this is a dry run, perform it.
 *
 * @returns {{mode: string, uri?: string, filename?: string, reason?: string, length: number, items: number}}
 */
export function deliver(payload, win = globalThis, { scheme = DEFAULT_SCHEME, dryRun = false } = {}) {
  const handoff = chooseHandoff(payload, scheme, { maxUriLength: MAX_URI_LENGTH, maxItems: MAX_URI_ITEMS });

  if (dryRun) return handoff;

  if (isTestMode(win)) {
    announce(win, payload, handoff, scheme);
    return handoff;
  }

  if (handoff.mode === "uri") {
    navigate(win, handoff.uri, payload, scheme);
    return handoff;
  }

  const filename = download(win, payload, { includeTokens: true });
  return { ...handoff, filename };
}

function announce(win, payload, handoff, scheme) {
  try {
    const detail = { uri: handoff.uri || null, payload, mode: handoff.mode, reason: handoff.reason || null, scheme };
    win.document.dispatchEvent(new win.CustomEvent(handoffEventName(), { detail }));
    const holder = win.document.getElementById("bingetovlc-uri");
    if (holder) holder.textContent = handoff.uri || "(too long for a URI)";
  } catch {
    /* the test hook must never break the page */
  }
}

/**
 * Assign the URI to `location`. A hidden same-origin iframe is tried first
 * because a top-level navigation to an unknown scheme can leave Chrome showing
 * its own error page behind the protocol dialog; the anchor is the fallback when
 * iframes are blocked by the site's CSP.
 */
function navigate(win, uri, payload, scheme) {
  try {
    const doc = win.document;
    const frame = doc.createElement("iframe");
    frame.style.display = "none";
    frame.setAttribute("data-bingetovlc", "handoff");
    frame.src = uri;
    doc.body.appendChild(frame);
    setTimeout(() => {
      try {
        frame.remove();
      } catch {
        /* ignore */
      }
    }, 30000);
    return;
  } catch {
    /* fall through */
  }
  try {
    win.location.href = uri;
  } catch {
    download(win, payload, { includeTokens: true, scheme });
  }
}

/** Build and save the .m3u. Also used by the "Download playlist" button. */
export function download(win, payload, { includeTokens = true } = {}) {
  const text = buildM3u(payload, { includeTokens, newline: "\r\n" });
  const filename = playlistFilename(payload.title, payload.opts && payload.opts.start);
  const blob = new win.Blob([text], { type: "audio/x-mpegurl" });
  const url = win.URL.createObjectURL(blob);
  const anchor = win.document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  win.document.body.appendChild(anchor);
  anchor.click();
  setTimeout(() => {
    try {
      anchor.remove();
      win.URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
  }, 10000);
  return filename;
}

/** A URI the user can copy out, e.g. into a VLC already-open dialog. */
export function uriFor(payload, scheme = DEFAULT_SCHEME) {
  return launchUri(payload, scheme);
}

export async function copyText(win, text) {
  try {
    await win.navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = win.document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      win.document.body.appendChild(area);
      area.select();
      const ok = win.document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
