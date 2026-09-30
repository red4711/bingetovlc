#!/usr/bin/env node
/**
 * Generate tests/fixtures/vectors.json — the conformance contract.
 *
 * Three independent implementations must produce identical bytes for these
 * vectors:
 *   1. JavaScript  (src/core/*, asserted by node --test)
 *   2. Python      (tools/playlist/conformance.py, the reference decoder)
 *   3. PowerShell  (tools/windows/bingetovlc-handler.ps1 -SelfTest, asserted on
 *                   windows-latest in CI, because the handler is the only place
 *                   a real user's playlist can be silently corrupted)
 *
 * Payload v2 carries item IDS, not URLs, and the handler builds each URL. That is
 * not cosmetic: Chromium hands an external-protocol URI to the Windows shell via
 * ShellExecuteA, which is capped around 2046 characters, and the v1 payload for
 * the 28 episode season below was 5,471 bytes — i.e. the season queue would have
 * failed silently on Windows. As ids, the same season is well under the cap, and
 * if the titles do not fit, `fitToBudget()` drops them and the queue is labelled
 * S01E03 from the season/episode numbers.
 *
 * The generic-adapter vector keeps a full URL, because that adapter has no
 * authenticated API to resolve ids against.
 *
 * Run: node tools/vectors/generate.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build, encode, launchUri, chooseHandoff, resolveItemUrl, MAX_URI_LENGTH } from "../../src/core/payload.js";
import { buildM3u } from "../../src/core/m3u.js";
import { orderItems, scopeItems, episodeLabel, durationSeconds } from "../../src/core/ordering.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");

const TOKEN = "0123456789abcdef0123456789abcdef";
const SERVER = "https://media.example.com";

/** Minimal Emby-shaped episode, exactly the fields the script actually reads. */
function episode(id, season, index, name, ticks = 15600000000) {
  return {
    Id: String(id),
    Name: name,
    Type: "Episode",
    ParentIndexNumber: season,
    IndexNumber: index,
    RunTimeTicks: ticks,
    Path: `/mnt/media/${id}.mkv`,
    SeriesId: "3008306",
    SeriesName: "Frieren: Beyond Journey's End",
    SeasonId: `season-${season}`,
    SeasonName: `Season ${season}`,
  };
}

function movie(id, name, ticks = 72000000000) {
  return {
    Id: String(id),
    Name: name,
    Type: "Movie",
    RunTimeTicks: ticks,
    Path: `/mnt/media/${id}.mkv`,
  };
}

/** An Emby item -> the payload item shape the userscript actually sends. */
function toPayloadItem(item) {
  return {
    id: item.Id,
    title: episodeLabel(item),
    duration: durationSeconds(item),
    season: item.ParentIndexNumber,
    episode: item.IndexNumber,
  };
}

const vectors = [];
function addVector(name, note, payload, extra = {}) {
  const m3u = buildM3u(payload);
  const uri = launchUri(payload, "vlc");
  vectors.push({
    name,
    note,
    payload,
    base64: encode(payload),
    uri,
    aliasUri: launchUri(payload, "bingetovlc"),
    m3u,
    m3uShareable: buildM3u(payload, { includeTokens: false }),
    uriLength: uri.length,
    ...extra,
  });
}

/** Emby-shaped payload: ids + server + token, never full URLs. */
function embyPayload({ title, scope, items, opts, budget }) {
  return build({
    source: "emby",
    server: SERVER,
    token: TOKEN,
    title,
    scope,
    items,
    opts,
    ...(budget !== undefined ? { budget } : {}),
  });
}

// 1. A single movie.
{
  const item = movie("3518601", "Ghosts of Mars", 58800000000);
  const scoped = scopeItems({ item, itemType: "Movie", children: [], scope: "item" });
  const payload = embyPayload({
    title: scoped.title,
    scope: scoped.scope,
    items: scoped.items.map(toPayloadItem),
  });
  addVector("movie-single", "one movie by id; the handler builds the stream URL", payload);
}

// 2. A single episode with a duration.
{
  const item = episode("3020743", 1, 1, "The Journey's End");
  const scoped = scopeItems({ item, itemType: "Episode", children: [item], scope: "item" });
  const payload = embyPayload({
    title: scoped.title,
    scope: scoped.scope,
    items: scoped.items.map(toPayloadItem),
  });
  addVector("episode-single", "one episode, labelled S01E01", payload);
}

// 3. A whole season, deliberately handed over out of order plus a duplicate and
//    a Virtual item: the queue must come out ordered, deduped and playable.
{
  const children = [
    episode("3020745", 1, 3, "Killing Magic"),
    episode("3020743", 1, 1, "The Journey's End"),
    episode("3020744", 1, 2, "It Didn't Have to Be Magic..."),
    episode("3020743", 1, 1, "The Journey's End"),
    { ...episode("9999999", 1, 4, "Announced, not on disk"), LocationType: "Virtual", Path: "" },
  ];
  const ordered = orderItems(children);
  const scoped = scopeItems({
    item: { Id: "3020741", Name: "Season 1", Type: "Season" },
    itemType: "Season",
    children: ordered,
    scope: "season",
  });
  const payload = embyPayload({
    title: scoped.title,
    scope: scoped.scope,
    items: scoped.items.map(toPayloadItem),
  });
  addVector("season-ordered", "3 playable episodes + duplicate + Virtual item", payload, {
    expectedIds: scoped.items.map((i) => i.Id),
  });
}

// 4. A full 28 episode season: the realistic URI length case, and the vector that
//    would have caught the ~2 KB Windows hand-off cap.
{
  const children = Array.from({ length: 28 }, (_, index) =>
    episode(3020743 + index, 1, index + 1, `Episode ${index + 1}`, (1400 + index * 7) * 10000000),
  );
  const scoped = scopeItems({
    item: { Id: "3020741", Name: "Season 1", Type: "Season" },
    itemType: "Season",
    children: children.reverse(),
    scope: "season",
  });
  const payload = embyPayload({
    title: scoped.title,
    scope: scoped.scope,
    items: scoped.items.map(toPayloadItem),
  });
  const uri = launchUri(payload, "vlc");
  if (uri.length > MAX_URI_LENGTH) {
    throw new Error(
      `the 28 episode season URI is ${uri.length} bytes, over the ${MAX_URI_LENGTH} budget; ` +
        `it must stay well under the ~2046 character Windows hand-off cap`,
    );
  }
  addVector("season-28", "28 episodes: must stay inside the URI budget", payload, {
    handoff: chooseHandoff(payload, "vlc"),
    uriLength: uri.length,
  });
}

// 5. A season whose episode titles are too long for the URI budget: the titles
//    must be dropped, the ids must survive, and the queue must still be complete.
{
  const longTitles = [
    "The Journey's End, and Everything That Came After It, Which Nobody Expected",
    "It Didn't Have to Be Magic, But Somehow It Was, and Everyone Pretended Not to Notice",
    "A Very Long Episode Title That Exists Only To Overflow The URI Length Budget On Purpose",
  ];
  const children = longTitles.map((name, index) => episode(5000000 + index, 3, index + 1, name));
  const ordered = orderItems(children);
  const scoped = scopeItems({
    item: { Id: "5000000", Name: "Season 3", Type: "Season" },
    itemType: "Season",
    children: ordered,
    scope: "season",
  });
  const payload = embyPayload({
    title: "A Series With Extremely Long Episode Titles, Season 3",
    scope: scoped.scope,
    items: scoped.items.map(toPayloadItem),
  });
  if (launchUri(payload, "vlc").length > MAX_URI_LENGTH) {
    throw new Error("fitToBudget() did not bring the long-title season inside the budget");
  }
  addVector("long-titles-trimmed", "titles dropped by fitToBudget, ids and SxxExx labels kept", payload, {
    handoff: chooseHandoff(payload, "vlc"),
    uriLength: launchUri(payload, "vlc").length,
    expectedIds: scoped.items.map((i) => i.Id),
  });
}

// 6. Unicode + characters that break naive serialisers.
{
  const item = episode("3020770", 1, 28, "잘 어울리는 게 부끄러운 일이라니까 — It Would Be Embarrassing, Really; №28");
  const scoped = scopeItems({ item, itemType: "Episode", children: [item], scope: "item" });
  const payload = embyPayload({
    title: "Frieren: Beyond Journey's End — 葬送のフリーレン",
    scope: "item",
    items: scoped.items.map(toPayloadItem),
    opts: { fs: true, one: true, start: 2 },
  });
  addVector("unicode-and-punctuation", "CJK text, em dash, comma, semicolon, fullwidth space", payload);
}

// 7. A queue too long for a URI: must be pushed to the .m3u download path, and
//    because that path has no length limit it keeps the full episode titles
//    (budget: null is what the userscript passes there).
{
  const children = Array.from({ length: 120 }, (_, index) => episode(4000000 + index, 1, index + 1, `Long ${index + 1}`));
  const ordered = orderItems(children);
  const payload = embyPayload({
    title: "Big series",
    scope: "series",
    items: ordered.map(toPayloadItem),
    budget: null,
  });
  addVector("too-many-items", "120 episodes must not be attempted as a URI", payload, {
    handoff: chooseHandoff(payload, "vlc"),
    uriLength: launchUri(payload, "vlc").length,
  });
}

// 8. The generic adapter: a full URL, because there is no authenticated API to
//    resolve an id against. Header options are the reason this shape still exists.
{
  const payload = build({
    source: "generic",
    server: "https://example.org",
    title: "Referrer locked stream",
    scope: "item",
    items: [{ url: "https://cdn.example.org/live/master.m3u8?token=abc", title: "Live", duration: 3600 }],
    opts: { referrer: "https://example.org/watch/1", ua: "Mozilla/5.0 (Test)", cache: 1500 },
  });
  addVector("generic-headers", "generic adapter: referrer + user agent + cache", payload);
}

// Cross-check: every item's M3U entry must contain the URL the handler will build,
// and no vector may exceed the hand-off budget without being sent to download.
for (const vector of vectors) {
  for (const item of vector.payload.items) {
    const expected = resolveItemUrl(vector.payload, item);
    if (!vector.m3u.includes(expected)) {
      throw new Error(`${vector.name}: the M3U does not contain the resolved URL ${expected}`);
    }
  }
  if (vector.uriLength > MAX_URI_LENGTH && vector.handoff && vector.handoff.mode !== "download") {
    throw new Error(
      `${vector.name}: a ${vector.uriLength} byte URI is over the budget but was not routed to download`,
    );
  }
}

const outPath = resolve(repo, "tests/fixtures/vectors.json");
mkdirSync(dirname(outPath), { recursive: true });
const document = {
  generatedBy: "tools/vectors/generate.mjs",
  payloadVersion: 2,
  uriBudgetBytes: MAX_URI_LENGTH,
  note: "Golden contract shared by the JS, Python and PowerShell implementations. Do not hand-edit: run `npm run vectors`.",
  vectors,
};
writeFileSync(outPath, JSON.stringify(document, null, 2) + "\n", "utf-8");

console.log(`wrote ${outPath}  (URI budget ${MAX_URI_LENGTH} bytes)`);
for (const vector of vectors) {
  const handoff = vector.handoff ? ` handoff=${vector.handoff.mode}(${vector.handoff.reason || "ok"})` : "";
  const shape = vector.payload.items.some((i) => i.i) ? "ids " : "urls";
  const trimmed = vector.payload.trimmed ? ` trimmed=${vector.payload.trimmed}` : "";
  console.log(
    `  ${vector.name.padEnd(24)} items=${String(vector.payload.items.length).padStart(3)} ${shape} uri=${String(vector.uri.length).padStart(5)}B${trimmed}${handoff}`,
  );
}
