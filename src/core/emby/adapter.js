/**
 * bingetovlc — Emby adapter: "what the user is looking at" -> "what VLC should play".
 *
 * The four page types behave differently on purpose:
 *
 *   Movie    -> one file
 *   Episode  -> that file, or that file plus the rest of its season
 *   Season   -> every episode of that season, in order
 *   Series   -> every episode of every season, in order
 *
 * Type branching happens BEFORE any stream URL is requested, because asking
 * Emby for media sources on a container is an error, not a no-op:
 *
 *   POST /Items/{seriesId}/PlaybackInfo -> HTTP 500
 *   "Unable to cast object of type 'MediaBrowser.Controller.Entities.TV.Series'
 *    to type 'MediaBrowser.Controller.Entities.IHasMediaSources'"
 *
 * The same call on a Season fails the same way. Verified live on 4.10.0.40.
 */

import { fetchChildren, streamUrl } from "./api.js";
import { durationSeconds, episodeLabel, isPlayable, orderItems, scopeItems, queueTitle } from "../ordering.js";

export const CONTAINER_TYPES = ["Series", "Season", "BoxSet", "Folder"];
export const SINGLE_TYPES = ["Movie", "Episode", "Video", "MusicVideo"];

/**
 * Which scopes make sense for the page the user is on.
 *
 * Containers deliberately do not offer a single-item scope: a Series or Season id
 * is not a media source, and asking for its stream returns HTTP 500 ("Unable to
 * cast object of type … Series to type … IHasMediaSources"). Offering the option
 * would have produced a broken queue for anyone who picked it.
 *
 * The first entry is the default, so landing on a season queues the season and
 * landing on a show queues the whole show — which is the behaviour this project
 * exists for.
 */
export function availableScopes(itemType) {
  switch (itemType) {
    case "Series":
      return ["series"];
    case "Season":
      return ["season"];
    case "Episode":
      return ["item", "rest-of-season", "season", "series"];
    case "Movie":
    case "Video":
      return ["item"];
    default:
      return ["item"];
  }
}

export function normalizeScope(itemType, requested) {
  const allowed = availableScopes(itemType);
  if (requested && allowed.includes(requested)) return requested;
  return allowed[0];
}

/**
 * Assemble the queue for one item.
 *
 * A container (Series, Season) is never a single playable item: if one somehow
 * arrives here with a single-item scope, its episodes are queued instead of
 * producing a URL that Emby answers with HTTP 500.
 *
 * @returns {Promise<{items: Array, title: string, scope: string, warnings: Array}>}
 */
export async function buildQueue({ session, item, itemType, scope, startId = null, options = {} }) {
  const type = itemType || (item && item.Type) || "";
  const warnings = [];
  let effectiveScope = normalizeScope(type, scope);
  if (CONTAINER_TYPES.includes(type) && effectiveScope === "item") {
    effectiveScope = type === "Series" ? "series" : "season";
    warnings.push("This is a container, so its episodes were queued rather than the container itself.");
  }

  const toQueueEntry = (child) => ({
    id: String(child.Id),
    title: episodeLabel(child),
    url: streamUrl(session.server, child.Id, session.token),
    duration: durationSeconds(child),
    season: child.ParentIndexNumber,
    episode: child.IndexNumber,
    played: Boolean(child.UserData && child.UserData.Played),
    runTimeTicks: child.RunTimeTicks,
    // Kept so the panel can show "215 GB" style totals and the poster art.
    sizeBytes: child.MediaSources && child.MediaSources[0] ? child.MediaSources[0].Size : undefined,
  });

  // Single items need no API call at all: the URL is derivable from the id.
  if (SINGLE_TYPES.includes(type) && effectiveScope === "item") {
    const single = orderItems([item]);
    return {
      items: single.map(toQueueEntry),
      scope: "item",
      title: queueTitle({ item, itemType: type, scope: "item", count: single.length }),
      warnings,
    };
  }

  const { items: children, total } = await fetchChildren(session, { item, itemType: type, options });

  if (total > children.length) {
    warnings.push(
      `Emby reported ${total} episodes but only ${children.length} were returned; the queue may be incomplete.`,
    );
  }
  if (children.length === 0) {
    warnings.push("No episodes were returned for this item. Nothing to play.");
  }

  const unplayable = children.filter((child) => !isPlayable(child));
  if (unplayable.length) {
    warnings.push(
      unplayable.length === 1
        ? "1 episode is not on disk yet (Emby reports it as virtual) and was left out of the queue."
        : `${unplayable.length} episodes are not on disk yet (Emby reports them as virtual) and were left out of the queue.`,
    );
  }

  const scoped = scopeItems({ item, itemType: type, children, scope: effectiveScope, startId });
  if (scoped.items.length === 0) {
    warnings.push("After filtering, the queue is empty.");
  }

  return {
    items: scoped.items.map(toQueueEntry),
    scope: scoped.scope,
    title: scoped.title,
    warnings,
  };
}

/**
 * Decide whether a queue is worth attempting over a URI, or whether the user
 * should get an .m3u file instead. A real 28 episode season produced a 5,471
 * byte URI, so the window between "works" and "does not" is narrow and worth
 * surfacing in the UI rather than discovering on someone else's machine.
 */
export function describeHandoff(handoff) {
  if (handoff.mode === "uri") {
    return `Opening in VLC (${handoff.items} item${handoff.items === 1 ? "" : "s"}, ${handoff.length} byte URI).`;
  }
  if (handoff.reason === "too-many-items") {
    return `${handoff.items} items is more than Chrome reliably passes in one URI (limit ${handoff.maxItems}), so an .m3u playlist will be downloaded instead.`;
  }
  return `This queue needs a ${handoff.length} byte URI, over the ${handoff.maxUriLength} byte limit, so an .m3u playlist will be downloaded instead.`;
}
