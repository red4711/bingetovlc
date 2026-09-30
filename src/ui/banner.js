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
 *
 * Styling shares the panel's tokens by repeating the values, not by importing
 * them: tools/build.py concatenates these modules into one file, and a shared
 * constant would be a duplicate-symbol build error. `element` is deliberately
 * not defined here for the same reason.
 */

export const BANNER_ID = "bingetovlc-banner";

const BANNER_STYLE = `
#${BANNER_ID} {
  all: initial;
  box-sizing: border-box;
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  bottom: 24px;
  z-index: 2147483001;
  max-width: min(560px, calc(100vw - 32px));
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 11px 12px 11px 14px;
  border-radius: 10px;
  color-scheme: dark;
  font: 13px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: #e9edf5;
  background: #14161d;
  border: 1px solid rgba(255, 255, 255, 0.13);
  border-left: 3px solid #2f7cf6;
  box-shadow: 0 14px 38px rgba(0, 0, 0, 0.5);
}
#${BANNER_ID}.bingetovlc-banner-warn { border-left-color: #ffc857; }
#${BANNER_ID}.bingetovlc-banner-error { border-left-color: #ff9d9d; }
#${BANNER_ID} .bingetovlc-banner-text { flex: 1 1 auto; min-width: 0; }
#${BANNER_ID} button {
  all: unset;
  box-sizing: border-box;
  flex: 0 0 auto;
  cursor: pointer;
  padding: 5px 9px;
  border-radius: 7px;
  font: inherit;
  color: inherit;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
}
#${BANNER_ID} button:hover { background: rgba(255, 255, 255, 0.16); }
#${BANNER_ID} .bingetovlc-banner-close { padding: 5px 8px; color: rgba(233, 237, 245, 0.62); }
#${BANNER_ID} :focus-visible { outline: 2px solid #2f7cf6; outline-offset: 1px; }
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
    banner.setAttribute("role", "status");
    banner.setAttribute("aria-live", "polite");
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
  // Dismissing has to be possible without waiting out the timer, and without
  // clicking through to the page underneath.
  const dismiss = Object.assign(doc.createElement("button"), {
    className: "bingetovlc-banner-close",
    textContent: "\u00d7",
    title: "Dismiss",
  });
  dismiss.setAttribute("aria-label", "Dismiss");
  dismiss.addEventListener("click", () => banner.remove());
  banner.appendChild(dismiss);

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
