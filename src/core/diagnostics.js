/**
 * bingetovlc — diagnostics and redaction.
 *
 * Two jobs, both about not leaking a token:
 *
 *   1. `redactUrl` — every place a URL is shown, copied or logged goes through
 *      this first. An Emby direct-play URL carries the API token in its query
 *      string, so a "helpful" debug dump would hand over library access.
 *   2. `report` — the text a user pastes into a bug report. It states what was
 *      detected and what was built, with tokens stripped, and it says outright
 *      what it could not determine instead of guessing.
 */

const SECRET_PARAMS = ["api_key", "apikey", "token", "access_token", "accesstoken", "auth", "hdnts", "sig", "signature"];

/** Replace the values of secret-looking query parameters with REDACTED. */
export function redactUrl(url) {
  if (typeof url !== "string") return "";
  let out = url;
  for (const name of SECRET_PARAMS) {
    const pattern = new RegExp(`([?&]${name}=)[^&#]*`, "gi");
    out = out.replace(pattern, "$1REDACTED");
  }
  return out;
}

export function redactPayload(payload) {
  if (!payload || !Array.isArray(payload.items)) return payload;
  return {
    ...payload,
    items: payload.items.map((item) => ({ ...item, u: redactUrl(item.u) })),
  };
}

/** Short, human-openable summary of one queue entry. */
export function describeItem(item) {
  const bits = [redactUrl(item.u)];
  if (item.d) bits.push(`${item.d}s`);
  return bits.join(" ");
}

export function detectEnvironment(win) {
  const nav = win && win.navigator ? win.navigator : {};
  const location = win && win.location ? win.location : {};
  return {
    href: location.href ? redactUrl(location.href) : "unknown",
    // The Emby item id and route are the single most useful facts in a bug
    // report, so they are always included.
    hash: location.hash || "",
    userAgent: nav.userAgent || "unknown",
    platform: nav.platform || "unknown",
  };
}

/**
 * The bug-report blob.
 *
 * @param {object} args
 * @param {object} args.session    from readSession()
 * @param {object} args.target     {item, itemType, scope, itemId}
 * @param {object} args.queue      from buildQueue()
 * @param {object} args.handoff    from chooseHandoff()/deliver()
 * @param {Array}  args.warnings
 * @param {string} args.version
 */
export function report({ session, target, queue, handoff, warnings = [], version = "unknown", scheme = "vlc", error = null }) {
  const lines = [];
  lines.push("bingetovlc bug report");
  lines.push(`  script version : ${version}`);
  lines.push(`  scheme         : ${scheme}://`);
  lines.push(`  page           : ${detectEnvironment(session && session.win ? session.win : {}).href}`);
  if (error) lines.push(`  error          : ${error}`);
  lines.push("");
  lines.push("Emby session");
  if (session) {
    lines.push(`  server         : ${session.server}`);
    lines.push(`  user id        : ${session.uid}`);
    lines.push(`  token          : ${session.token ? "present (not shown)" : "MISSING"}`);
    lines.push(`  discovered via : ${session.source || "unknown"}${session.untrusted ? " (best effort, unverified)" : ""}`);
  } else {
    lines.push("  no Emby session was detected on this page");
  }
  lines.push("");
  lines.push("Target");
  if (target) {
    lines.push(`  item id        : ${target.itemId || "unknown"}`);
    lines.push(`  item type      : ${target.itemType || "unknown"}`);
    lines.push(`  item name      : ${target.item && target.item.Name ? target.item.Name : "unknown"}`);
    lines.push(`  requested scope: ${target.scope || "unknown"}`);
  } else {
    lines.push("  nothing was selected");
  }
  lines.push("");
  lines.push("Queue");
  if (queue) {
    lines.push(`  title          : ${queue.title}`);
    lines.push(`  playable items : ${queue.items ? queue.items.length : 0}`);
    lines.push(`  total runtime  : ${formatDuration(queue.items)}`);
    lines.push("  first entries  :");
    for (const item of (queue.items || []).slice(0, 3)) lines.push(`    - ${item.title} :: ${describeItem(item)}`);
  } else {
    lines.push("  no queue was built");
  }
  lines.push("");
  lines.push("Handoff");
  if (handoff) {
    lines.push(`  mode           : ${handoff.mode}${handoff.reason ? ` (${handoff.reason})` : ""}`);
    lines.push(`  items          : ${handoff.items}`);
    lines.push(`  uri length     : ${handoff.length} bytes`);
  } else {
    lines.push("  not attempted");
  }
  if (warnings.length) {
    lines.push("");
    lines.push("Warnings");
    for (const warning of warnings) lines.push(`  - ${warning}`);
  }
  lines.push("");
  lines.push("Notes for the maintainer");
  lines.push("  - handler log: %LOCALAPPDATA%\\bingetovlc\\logs\\handler.log");
  lines.push("  - this report contains no API token (all query secrets are redacted)");
  return lines.join("\n");
}

export function formatDuration(items) {
  const total = (items || []).reduce((sum, item) => sum + (Number(item.d) || 0), 0);
  if (!total) return "unknown";
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  if (hours === 0) return `${minutes} min`;
  return `${hours} h ${String(minutes).padStart(2, "0")} min`;
}
