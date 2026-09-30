/**
 * bingetovlc — settings.
 *
 * Stored in localStorage rather than GM_setValue because the script runs with
 * `@grant none` (it has to, see src/meta.js). The key is namespaced, and every
 * read is defensive: a userscript that throws on a corrupt settings blob would
 * break the page it runs on, which is not an acceptable failure mode.
 */

export const SETTINGS_KEY = "bingetovlc:settings";

export const DEFAULTS = {
  /** Which registered scheme to use for the handoff. */
  scheme: "vlc",
  /** Pass --fullscreen to VLC. */
  fullscreen: false,
  /** Pass --one-instance, so VLC reuses the window that is already open. */
  oneInstance: true,
  /** Ask VLC to close when the playlist finishes. */
  playAndExit: false,
  /** VLC --network-caching value in ms, applied per playlist entry. Empty = VLC default. */
  networkCache: 0,
  /** Skip episodes Emby already reports as watched when queueing a season. */
  skipPlayed: false,
  /** Show the panel on non-Emby pages too (generic adapter, experimental). */
  genericAdapter: false,
  /** Whether the panel starts collapsed. */
  collapsed: false,
  /** Warn before queueing more than this many items. */
  confirmOverItems: 50,
};

export function loadSettings(win = globalThis) {
  try {
    const raw = win.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULTS };
    const merged = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
      if (parsed[key] !== undefined && typeof parsed[key] === typeof DEFAULTS[key]) merged[key] = parsed[key];
      // Numbers arrive from form inputs as strings on some clients.
      else if (parsed[key] !== undefined && typeof DEFAULTS[key] === "number" && Number.isFinite(Number(parsed[key]))) {
        merged[key] = Number(parsed[key]);
      }
    }
    if (!["vlc", "bingetovlc"].includes(merged.scheme)) merged.scheme = DEFAULTS.scheme;
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(win, settings) {
  try {
    win.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

export function updateSetting(win, key, value) {
  const settings = loadSettings(win);
  settings[key] = value;
  saveSettings(win, settings);
  return settings;
}

/** Options for the payload, derived from settings. */
export function handoffOptions(settings) {
  const opts = {};
  if (settings.fullscreen) opts.fs = true;
  if (settings.oneInstance) opts.one = true;
  if (settings.playAndExit) opts.exit = true;
  if (settings.networkCache > 0) opts.cache = settings.networkCache;
  return opts;
}
