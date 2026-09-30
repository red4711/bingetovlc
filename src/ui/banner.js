/**
 * bingetovlc — the transient banner.
 *
 * Used for outcomes the user did not ask to read in a panel: the playlist was
 * handed to VLC, a download started, or something failed. It auto-hides, and it
 * never blocks the page.
 *
 * The important case is the URI fallback: when a queue is too long for a URI, or
 * when Chrome refuses the scheme, the user has to be told what just happened and
 * what to click next, because "nothing happened" is otherwise the entire user
 * experience.
 */

export const BANNER_ID = "bingetovlc-banner";

// Prefixed for the same reason as the panel's stylesheet: one flattened scope.
const BANNER_STYLE = `
#${BANNER_ID} {
  all: initial;
  position: fixed; left: 50%; transform: translateX(-50%); bottom: 24px;
  z-index: 2147483001; max-width: 560px;
  padding: 10px 14px; border-radius: 9px;
  font: 13px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: #eaeef6; background: rgba(18, 20, 27, 0.97);
  border: 1px solid rgba(255, 255, 255, 0.16);
  box-shadow: 0 8px 26px rgba(0, 0, 0, 0.45);
  display: flex; gap: 10px; align-items: center;
}
#${BANNER_ID} button {
  all: unset; cursor: pointer; padding: 5px 9px; border-radius: 6px;
  background: rgba(255,255,255,0.12); border: 1px solid rgba(255,255,255,0.14);
}
#${BANNER_ID}.bingetovlc-banner-warn { border-color: #ffd479; }
#${BANNER_ID}.bingetovlc-banner-error { border-color: #ff9d9d; }
#${BANNER_ID} .bingetovlc-banner-text { flex: 1 1 auto; }
`;

export function showBanner(doc, message, { kind = "info", timeoutMs = 9000, actionLabel = null, onAction = null } = {}) {
  let banner = doc.getElementById(BANNER_ID);
  if (!banner) {
    const style = doc.createElement("style");
    style.id = `${BANNER_ID}-style`;
    style.textContent = BANNER_STYLE;
    doc.head.appendChild(style);
    banner = doc.createElement("div");
    banner.id = BANNER_ID;
    doc.body.appendChild(banner);
  }
  banner.textContent = "";
  banner.className = kind === "info" ? "" : `bingetovlc-banner-${kind}`;
  banner.appendChild(Object.assign(doc.createElement("span"), { className: "bingetovlc-banner-text", textContent: message }));
  if (actionLabel && onAction) {
    const button = Object.assign(doc.createElement("button"), { textContent: actionLabel });
    button.addEventListener("click", () => {
      try {
        onAction();
      } finally {
        banner.remove();
      }
    });
    banner.appendChild(button);
  }

  if (banner._bingetovlcTimer) clearTimeout(banner._bingetovlcTimer);
  if (timeoutMs > 0) {
    banner._bingetovlcTimer = setTimeout(() => {
      try {
        banner.remove();
      } catch {
        /* the page may have navigated */
      }
    }, timeoutMs);
  }
  return banner;
}
