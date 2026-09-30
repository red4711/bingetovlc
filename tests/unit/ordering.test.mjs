/**
 * Unit tests for src/core/ordering.js — queue assembly.
 *
 * "Queue a whole season in the right order" is the feature this project exists
 * for, so the ordering, de-duplication and playability rules are tested
 * exhaustively, including the item-less branches (a Movie, a Virtual episode)
 * that a naive implementation would queue and then fail to stream.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  isPlayable,
  orderItems,
  episodeLabel,
  durationSeconds,
  queueTitle,
  scopeItems,
  totalDurationSeconds,
} from "../../src/core/ordering.js";

const TICKS = 10000000;

function episode(id, season, index, name, extra = {}) {
  return {
    Id: String(id),
    Name: name,
    Type: "Episode",
    ParentIndexNumber: season,
    IndexNumber: index,
    RunTimeTicks: 1560 * TICKS,
    Path: `/mnt/media/${id}.mkv`,
    SeriesId: "10",
    SeriesName: "Test Show",
    SeasonId: `season-${season}`,
    ...extra,
  };
}

const ids = (items) => items.map((i) => i.Id);

// ---------------------------------------------------------------------------
// orderItems
// ---------------------------------------------------------------------------

test("orders by season, then episode, from out-of-order input", () => {
  const input = [
    episode("c", 2, 1, "S2E1"),
    episode("a", 1, 2, "S1E2"),
    episode("b", 1, 1, "S1E1"),
    episode("d", 2, 2, "S2E2"),
  ];
  assert.deepEqual(ids(orderItems(input)), ["b", "a", "c", "d"]);
});

test("falls back to AiredEpisodeNumber when IndexNumber is missing", () => {
  const input = [
    episode("x", 1, null, "no index", { AiredEpisodeNumber: 3, IndexNumber: undefined }),
    episode("y", 1, null, "no index", { AiredEpisodeNumber: 1, IndexNumber: undefined }),
    episode("z", 1, 2, "has index"),
  ];
  assert.deepEqual(ids(orderItems(input)), ["y", "z", "x"]);
});

test("is stable and deterministic when all index metadata is missing", () => {
  const bare = (id) => ({ Id: id, Name: id, Path: `/m/${id}.mkv` });
  const input = [bare("b"), bare("a"), bare("c")];
  const first = orderItems(input);
  const second = orderItems(input);
  assert.deepEqual(ids(first), ["a", "b", "c"], "no index metadata -> ordered by id");
  assert.deepEqual(ids(first), ids(second), "ordering must be deterministic across calls");
});

test("collapses duplicate ids, keeping the first occurrence", () => {
  const input = [
    episode("1", 1, 1, "first"),
    episode("2", 1, 2, "second"),
    episode("1", 1, 1, "duplicate"),
  ];
  const ordered = orderItems(input);
  assert.deepEqual(ids(ordered), ["1", "2"]);
  assert.equal(ordered[0].Name, "first");
});

test("drops Virtual items and items with an empty Path", () => {
  const input = [
    episode("1", 1, 1, "playable"),
    { ...episode("9", 1, 2, "virtual"), LocationType: "Virtual", Path: "" },
    episode("3", 1, 3, "empty path", { Path: "" }),
    episode("4", 1, 4, "whitespace path", { Path: "   " }),
    { Id: "5", Name: "no Path key at all", Type: "Episode", ParentIndexNumber: 1, IndexNumber: 5 },
  ];
  assert.deepEqual(ids(orderItems(input)), ["1", "5"]);
});

test("isPlayable is false for a missing item, a missing Id, Virtual or an empty Path", () => {
  assert.equal(isPlayable(null), false);
  assert.equal(isPlayable({ Name: "no id" }), false);
  assert.equal(isPlayable({ Id: "1", LocationType: "Virtual", Path: "/m/1.mkv" }), false);
  assert.equal(isPlayable({ Id: "1", Path: "" }), false);
  assert.equal(isPlayable({ Id: "1" }), true, "an absent Path must not be treated as empty");
  assert.equal(isPlayable({ Id: "1", Path: "/m/1.mkv" }), true);
});

test("an empty input yields an empty queue", () => {
  assert.deepEqual(orderItems([]), []);
  assert.deepEqual(orderItems(null), []);
});

// ---------------------------------------------------------------------------
// scopeItems
// ---------------------------------------------------------------------------

const seasonItem = { Id: "100", Name: "Season 1", Type: "Season" };
const seriesItem = { Id: "10", Name: "Test Show", Type: "Series" };
const movieItem = { Id: "500", Name: "Ghosts of Mars", Type: "Movie", Path: "/m/500.mkv" };

test("scope=item returns exactly the one item, even for a Movie/Video type", () => {
  const movie = scopeItems({ item: movieItem, itemType: "Movie", children: [], scope: "item" });
  assert.deepEqual(ids(movie.items), ["500"]);
  assert.equal(movie.scope, "item");
  assert.equal(movie.title, "Ghosts of Mars");

  const video = scopeItems({ item: { Id: "7", Name: "Clip", Type: "Video" }, itemType: "Video", children: [{ Id: "8" }], scope: "item" });
  assert.deepEqual(ids(video.items), ["7"]);
  assert.equal(video.scope, "item");
});

test("a Movie type wins over scope=season: exactly one item is queued", () => {
  const scoped = scopeItems({ item: movieItem, itemType: "Movie", children: [episode("1", 1, 1, "x")], scope: "season" });
  assert.deepEqual(ids(scoped.items), ["500"]);
  assert.equal(scoped.scope, "item");
});

test("scope=season queues the whole season ordered and deduped", () => {
  const children = [
    episode("3", 1, 3, "third"),
    episode("1", 1, 1, "first"),
    episode("2", 1, 2, "second"),
    episode("1", 1, 1, "dup"),
    { ...episode("9", 1, 4, "virtual"), LocationType: "Virtual", Path: "" },
  ];
  const scoped = scopeItems({ item: seasonItem, itemType: "Season", children, scope: "season" });
  assert.deepEqual(ids(scoped.items), ["1", "2", "3"]);
  assert.equal(scoped.scope, "season");
  assert.equal(scoped.title, "Season 1 — 3 episodes");
});

test("scope=series labels the queue as a series and queues every season in order", () => {
  const children = [
    episode("b", 1, 2, "S1E2"),
    episode("a", 1, 1, "S1E1"),
    episode("c", 2, 1, "S2E1"),
  ];
  const scoped = scopeItems({ item: seriesItem, itemType: "Series", children, scope: "series" });
  assert.deepEqual(ids(scoped.items), ["a", "b", "c"]);
  assert.equal(scoped.scope, "series");
  assert.equal(scoped.title, "Test Show — 3 episodes");
});

test("scope=rest-of-season slices from the start id, inclusive", () => {
  const children = [episode("1", 1, 1, "a"), episode("2", 1, 2, "b"), episode("3", 1, 3, "c")];
  const scoped = scopeItems({ item: episode("2", 1, 2, "b"), itemType: "Episode", children, scope: "rest-of-season", startId: "2" });
  assert.deepEqual(ids(scoped.items), ["2", "3"]);
  assert.equal(scoped.scope, "rest-of-season");
  assert.equal(scoped.title, "Test Show — from S01E02 b");

  // With no explicit startId it falls back to the viewed item's own id.
  const implicit = scopeItems({ item: episode("3", 1, 3, "c"), itemType: "Episode", children, scope: "rest-of-season" });
  assert.deepEqual(ids(implicit.items), ["3"]);
});

test("scope=season viewed from an Episode keeps only that episode's season", () => {
  const children = [
    episode("1", 1, 1, "s1e1"),
    episode("2", 1, 2, "s1e2"),
    episode("3", 2, 1, "s2e1"),
  ];
  const scoped = scopeItems({
    item: episode("2", 1, 2, "s1e2"),
    itemType: "Episode",
    children,
    scope: "season",
  });
  assert.deepEqual(ids(scoped.items), ["1", "2"], "episodes from other seasons must be dropped");
  assert.equal(scoped.scope, "season");
});

test("scopeItems tolerates an unknown scope by treating it as the container", () => {
  const children = [episode("1", 1, 1, "a"), episode("2", 1, 2, "b")];
  const scoped = scopeItems({ item: seasonItem, itemType: "Season", children, scope: "banana" });
  assert.deepEqual(ids(scoped.items), ["1", "2"]);
  assert.equal(scoped.scope, "season");
});

// ---------------------------------------------------------------------------
// episodeLabel
// ---------------------------------------------------------------------------

test("episodeLabel zero-pads season and episode: S01E03", () => {
  assert.equal(episodeLabel(episode("1", 1, 3, "Killing Magic")), "S01E03 Killing Magic");
  assert.equal(episodeLabel(episode("1", 2, 10, "Ep")), "S02E10 Ep");
  assert.equal(episodeLabel(episode("1", 12, 100, "Ep")), "S12E100 Ep");
});

test("episodeLabel falls back to AiredEpisodeNumber, then 00", () => {
  assert.equal(
    episodeLabel(episode("1", 1, null, "No index", { IndexNumber: undefined, AiredEpisodeNumber: 7 })),
    "S01E07 No index",
  );
  assert.equal(
    episodeLabel({ ParentIndexNumber: 1, Name: "No numbers" }),
    "S01E00 No numbers",
  );
});

test("episodeLabel handles movies (no season/episode metadata) and missing names", () => {
  assert.equal(episodeLabel(movieItem), "Ghosts of Mars");
  assert.equal(episodeLabel({ Name: "Naked" }), "Naked");
  assert.equal(episodeLabel({}), "Untitled");
  assert.equal(episodeLabel({ OriginalTitle: "Original" }), "Original");
  assert.equal(episodeLabel(episode("1", 1, 1, undefined, { Name: undefined })), "S01E01 Untitled");
});

// ---------------------------------------------------------------------------
// durationSeconds
// ---------------------------------------------------------------------------

test("durationSeconds converts RunTimeTicks to whole seconds", () => {
  assert.equal(durationSeconds({ RunTimeTicks: 1560 * TICKS }), 1560);
  assert.equal(durationSeconds({ RunTimeTicks: "15600000000" }), 1560);
  assert.equal(durationSeconds({ RunTimeTicks: 9999999 }), 1, "rounds to the nearest second");
});

test("durationSeconds returns undefined for unknown or non-positive run times", () => {
  assert.equal(durationSeconds({}), undefined);
  assert.equal(durationSeconds({ RunTimeTicks: 0 }), undefined);
  assert.equal(durationSeconds({ RunTimeTicks: -5 * TICKS }), undefined);
  assert.equal(durationSeconds({ RunTimeTicks: "nonsense" }), undefined);
  assert.equal(durationSeconds({ RunTimeTicks: null }), undefined);
});

test("totalDurationSeconds sums only the known durations", () => {
  assert.equal(totalDurationSeconds([{ RunTimeTicks: 10 * TICKS }, { RunTimeTicks: 32 * TICKS }, {}]), 42);
  assert.equal(totalDurationSeconds([]), 0);
});

// ---------------------------------------------------------------------------
// queueTitle
// ---------------------------------------------------------------------------

test("queueTitle produces a human label for each scope", () => {
  const item = episode("1", 1, 3, "Killing Magic");
  assert.equal(queueTitle({ item, itemType: "Episode", scope: "item", count: 1 }), "Killing Magic");
  assert.equal(queueTitle({ item, itemType: "Episode", scope: "season", count: 1 }), "Killing Magic — 1 episode");
  assert.equal(queueTitle({ item, itemType: "Season", scope: "season", count: 3 }), "Killing Magic — 3 episodes");
  assert.equal(queueTitle({ item, itemType: "Episode", scope: "rest-of-season", count: 2 }), "Test Show — from S01E03 Killing Magic");
  assert.equal(queueTitle({ item: seriesItem, itemType: "Series", scope: "series", count: 0 }), "Test Show — 0 episodes");
});