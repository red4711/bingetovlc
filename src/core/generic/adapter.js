/**
 * bingetovlc — generic adapter (experimental, off by default).
 *
 * The Emby adapter is the supported path: it uses an authenticated API, so the
 * episode list and the direct-play URL are facts, not guesses.
 *
 * This adapter is the opposite: it scrapes. It reads the DOM of any page with a
 * video player and tries to find something VLC can open, which means it is
 * wrong more often than it is right, and it is honest about that:
 *
 *   - it will not touch a DRM-protected stream; those are detected and reported
 *     rather than queued, because handing VLC a Widevine/PlayReady manifest
 *     fails after a long buffering pause with no useful error
 *   - it cannot see URLs the player fetched and discarded (blob:/MSE playback
 *     has no addressable URL at all)
 *   - it reports its confidence, and only claims `high` when it found a real
 *     .m3u8/.mpd/.mp4 in the DOM rather than inferring one
 *
 * It exists because "open what this page is playing in VLC" is a reasonable
 * request for a non-Emby site, and because it defines the adapter interface a
 * future site-specific adapter has to implement (see docs/adapters.md).
 */

const STREAM_PATTERNS = [
  { kind: "hls", re: /\.m3u8(\?|#|$)/i },
  { kind: "dash", re: /\.mpd(\?|#|$)/i },
  { kind: "file", re: /\.(mp4|m4v|mkv|webm|mov|ts)(\?|#|$)/i },
];

const DRM_HINTS = [/widevine/i, /playready/i, /fairplay/i, /\/license\b/i, /\bdrm\b/i];

export function classifyStreamUrl(url) {
  if (typeof url !== "string" || !url) return null;
  if (/^blob:/i.test(url)) return { kind: "blob", drm: false };
  if (/^data:/i.test(url)) return null;
  for (const pattern of STREAM_PATTERNS) {
    if (pattern.re.test(url)) return { kind: pattern.kind, drm: DRM_HINTS.some((re) => re.test(url)) };
  }
  return null;
}

/** Absolute URL for a possibly-relative src attribute. */
function absolutise(value, base) {
  if (!value) return null;
  try {
    return new URL(value, base).href;
  } catch {
    return null;
  }
}

/**
 * Collect candidate stream URLs from a document.
 *
 * Deliberately does not execute page scripts or read player internals: a
 * userscript that pokes at hls.js internals breaks on every player update, and
 * the failure mode is a silently wrong URL.
 */
export function collectCandidates(doc, { base } = {}) {
  const found = new Map();
  const add = (url, source) => {
    const info = classifyStreamUrl(url);
    if (!info || info.kind === "blob") return;
    const existing = found.get(url);
    if (existing) existing.sources.push(source);
    else found.set(url, { url, kind: info.kind, drm: info.drm, sources: [source] });
  };

  try {
    for (const video of doc.querySelectorAll("video, audio")) {
      add(absolutise(video.currentSrc, base), "media.currentSrc");
      add(absolutise(video.getAttribute("src"), base), "media[src]");
      for (const source of video.querySelectorAll("source")) {
        add(absolutise(source.getAttribute("src"), base), "source[src]");
      }
    }
    for (const anchor of doc.querySelectorAll('a[href$=".m3u8"], a[href*=".m3u8?"], a[href$=".mp4"]')) {
      add(absolutise(anchor.getAttribute("href"), base), "a[href]");
    }
    // JSON-LD and the common embedded player configs.
    for (const script of doc.querySelectorAll('script[type="application/ld+json"], script[type="application/json"]')) {
      const text = script.textContent || "";
      if (!/m3u8|\.mpd|\.mp4/i.test(text)) continue;
      const matches = text.match(/https?:\/\/[^\s"'\\<>]+/g) || [];
      for (const match of matches) add(match.replace(/\\\//g, "/"), "embedded-json");
    }
  } catch {
    /* a page that cannot be inspected yields no candidates, which is a valid answer */
  }
  return [...found.values()];
}

/**
 * Prefer a master playlist over a media playlist when both are present: the
 * master carries every rendition, which is what a desktop player wants, while a
 * media playlist pins one quality that was chosen for the browser.
 */
export function rankCandidates(candidates) {
  const readable = candidates.filter((candidate) => !candidate.drm);
  const score = (candidate) => {
    let value = 0;
    if (candidate.kind === "hls") value += 30;
    if (candidate.kind === "dash") value += 10;
    if (candidate.kind === "file") value += 20;
    if (/master|playlist|index/i.test(candidate.url) && candidate.kind !== "file") value += 15;
    if (/chunk|segment|-seg|\.ts(\?|$)/i.test(candidate.url)) value -= 25;
    value += Math.min(candidate.sources.length, 3);
    return value;
  };
  return [...readable].sort((a, b) => score(b) - score(a));
}

export function confidenceFor(candidates) {
  const usable = rankCandidates(candidates);
  if (!usable.length) return "none";
  if (usable[0].sources.some((source) => source !== "embedded-json")) return "high";
  return "low";
}

/**
 * Build a queue for a generic page.
 *
 * @returns {{items: Array, title: string, scope: string, warnings: Array, confidence: string}}
 */
export function buildGenericQueue({ doc, base, title }) {
  const candidates = collectCandidates(doc, { base });
  const ranked = rankCandidates(candidates);
  const warnings = [];

  const drm = candidates.filter((candidate) => candidate.drm);
  if (drm.length) {
    warnings.push(
      "This page appears to use DRM (Widevine/PlayReady/FairPlay). VLC cannot play those streams, so nothing was queued.",
    );
  }
  if (!ranked.length) {
    if (!candidates.length) {
      warnings.push(
        "No stream URL could be found in the page. Players that use blob: URLs (MSE) never expose an address the script can hand to VLC — that is a limitation of the browser, not a bug.",
      );
    } else {
      warnings.push("Only DRM-protected candidates were found, so nothing was queued.");
    }
  }

  const confidence = confidenceFor(candidates);
  if (confidence === "low" && ranked.length) {
    warnings.push("The URL was only found in embedded page data, so it may be stale or wrong. Check it before filing a bug.");
  }

  const items = ranked.slice(0, 1).map((candidate) => ({
    id: candidate.url,
    title: title || doc.title || candidate.url,
    url: candidate.url,
    duration: undefined,
  }));
  if (ranked.length > 1) {
    warnings.push(
      `${ranked.length - 1} other candidate URL${ranked.length - 1 === 1 ? " was" : "s were"} found but not queued (a page like this usually has one real stream plus its segments).`,
    );
  }

  return {
    items,
    title: title || doc.title || "Page stream",
    scope: "item",
    warnings,
    confidence,
  };
}
