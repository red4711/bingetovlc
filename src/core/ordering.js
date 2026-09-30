/**
 * bingetovlc — queue assembly.
 *
 * The feature this project exists for is "queue a whole season in the right
 * order", so ordering is explicit, tested code rather than whatever order an
 * API response happened to arrive in.
 *
 * Rules, in priority order:
 *   1. sort by (ParentIndexNumber, IndexNumber) — season, then episode
 *   2. fall back to AiredEpisodeNumber, then the numeric id, so items missing
 *      index metadata still land in a stable, repeatable position
 *   3. drop duplicates by id (a season query and a series query can overlap)
 *   4. drop unplayable items: `LocationType === "Virtual"` (announced but not on
 *      disk) or an empty `Path`. These produce HTTP 500/404 from Emby if queued.
 */

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function isPlayable(item) {
  if (!item || !item.Id) return false;
  if (item.LocationType === "Virtual") return false;
  if (item.Path !== undefined && item.Path !== null && String(item.Path).trim() === "") return false;
  return true;
}

function sortKey(item) {
  const season = numberOrNull(item.ParentIndexNumber);
  const episode = numberOrNull(item.IndexNumber);
  const aired = numberOrNull(item.AiredEpisodeNumber);
  return [
    season === null ? Number.MAX_SAFE_INTEGER : season,
    episode === null ? (aired === null ? Number.MAX_SAFE_INTEGER : aired) : episode,
    aired === null ? Number.MAX_SAFE_INTEGER : aired,
    String(item.Id),
  ];
}

export function orderItems(items) {
  const seen = new Set();
  const fresh = [];
  for (const item of items || []) {
    if (!isPlayable(item)) continue;
    const id = String(item.Id);
    if (seen.has(id)) continue;
    seen.add(id);
    fresh.push(item);
  }
  return fresh.sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] === kb[i]) continue;
      if (typeof ka[i] === "number" && typeof kb[i] === "number") return ka[i] - kb[i];
      return String(ka[i]).localeCompare(String(kb[i]));
    }
    return 0;
  });
}

export function episodeLabel(item) {
  const name = item.Name || item.OriginalTitle || "Untitled";
  const season = numberOrNull(item.ParentIndexNumber);
  const episode = numberOrNull(item.IndexNumber);
  if (season === null && episode === null) return name;
  const pad = (n) => String(n).padStart(2, "0");
  const s = season === null ? "00" : pad(season);
  const e = episode === null ? (numberOrNull(item.AiredEpisodeNumber) === null ? "00" : pad(item.AiredEpisodeNumber)) : pad(episode);
  const prefix = item.SeriesName ? "" : "";
  return `${prefix}S${s}E${e} ${name}`;
}

export function durationSeconds(item) {
  const ticks = numberOrNull(item.RunTimeTicks);
  if (ticks === null) return undefined;
  const seconds = Math.round(ticks / 10000000);
  return seconds > 0 ? seconds : undefined;
}

/** Human label for the whole queue, used in the panel and the payload title. */
export function queueTitle({ item, itemType, scope, count }) {
  const name = item && (item.Name || "Untitled");
  if (scope === "series") return `${name} — ${count} episode${count === 1 ? "" : "s"}`;
  if (scope === "season") return `${name} — ${count} episode${count === 1 ? "" : "s"}`;
  if (scope === "rest-of-season") return `${item && item.SeriesName ? item.SeriesName : name} — from ${episodeLabel(item)}`;
  return name;
}

/**
 * Turn "what the user is looking at" into "what VLC should play".
 *
 * @param {object}   args
 * @param {object}   args.item      the item currently being viewed
 * @param {string}   args.itemType  Emby `Type` of that item (Movie|Episode|Season|Series|Video)
 * @param {object[]} args.children  items fetched for the container (episodes/seasons)
 * @param {string}   args.scope     series|season|rest-of-season|item
 * @param {string}   [args.startId] episode id to start from (rest-of-season / "play from here")
 */
export function scopeItems({ item, itemType, children = [], scope = "item", startId = null }) {
  const type = itemType || (item && item.Type) || "";

  if (scope === "item" || type === "Movie" || type === "Video") {
    const single = orderItems([item]);
    return { items: single, scope: "item", title: queueTitle({ item, itemType: type, scope: "item", count: single.length }) };
  }

  let queue = orderItems(children);

  if (scope === "rest-of-season") {
    const index = queue.findIndex((candidate) => String(candidate.Id) === String((startId || (item && item.Id))));
    if (index > 0) queue = queue.slice(index);
  }

  if (type === "Episode" && scope === "season") {
    // "play the whole season" while looking at an episode: keep the episodes
    // that share this episode's season.
    const seasonId = item && item.SeasonId;
    if (seasonId) {
      const filtered = queue.filter((candidate) => String(candidate.SeasonId) === String(seasonId));
      if (filtered.length) queue = filtered;
    }
  }

  const effectiveScope = type === "Series" ? "series" : type === "Season" ? "season" : scope;
  return {
    items: queue,
    scope: effectiveScope,
    title: queueTitle({ item, itemType: type, scope: effectiveScope, count: queue.length }),
  };
}

export function totalDurationSeconds(items) {
  return (items || []).reduce((sum, item) => sum + (durationSeconds(item) || 0), 0);
}
