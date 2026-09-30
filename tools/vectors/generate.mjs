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
 * The vectors are derived from the real shapes observed on a live Emby 4.10
 * server (season of 28 episodes, ~100 character /Videos/{id}/stream URLs, a
 * 3.5 GB MKV with ASS subtitles) so they exercise realistic URI lengths rather
 * than toy input.
 *
 * Run: node tools/vectors/generate.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build, encode, launchUri, chooseHandoff } from "../../src/core/payload.js";
import { buildM3u } from "../../src/core/m3u.js";
import { orderItems, scopeItems, episodeLabel, durationSeconds } from "../../src/core/ordering.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");

const TOKEN = "0123456789abcdef0123456789abcdef";
const SERVER = "https://media.example.com";

const streamUrl = (id, token = TOKEN) => `${SERVER}/Videos/${id}/stream?Static=true&api_key=${token}`;

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

const vectors = [];
function addVector(name, note, payload, extra = {}) {
  vectors.push({
    name,
    note,
    payload,
    base64: encode(payload),
    uri: launchUri(payload, "vlc"),
    aliasUri: launchUri(payload, "bingetovlc"),
    m3u: buildM3u(payload),
    m3uShareable: buildM3u(payload, { includeTokens: false }),
    ...extra,
  });
}

// 1. A single movie.
{
  const item = movie("3518601", "Ghosts of Mars", 58800000000);
  const scoped = scopeItems({ item, itemType: "Movie", children: [], scope: "item" });
  const payload = build({
    source: "emby",
    server: SERVER,
    title: scoped.title,
    scope: scoped.scope,
    items: scoped.items.map((i) => ({ url: streamUrl(i.Id), title: i.Name, duration: durationSeconds(i) })),
  });
  addVector("movie-single", "one movie, no season/episode metadata", payload);
}

// 2. A single episode with a duration.
{
  const item = episode("3020743", 1, 1, "The Journey's End");
  const scoped = scopeItems({ item, itemType: "Episode", children: [item], scope: "item" });
  const payload = build({
    source: "emby",
    server: SERVER,
    title: scoped.title,
    scope: scoped.scope,
    items: scoped.items.map((i) => ({ url: streamUrl(i.Id), title: episodeLabel(i), duration: durationSeconds(i) })),
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
  const payload = build({
    source: "emby",
    server: SERVER,
    title: scoped.title,
    scope: scoped.scope,
    items: scoped.items.map((i) => ({ url: streamUrl(i.Id), title: episodeLabel(i), duration: durationSeconds(i) })),
  });
  addVector("season-ordered", "3 playable episodes + duplicate + Virtual item", payload, {
    expectedIds: scoped.items.map((i) => i.Id),
  });
}

// 4. A full 28 episode season: the realistic URI length case.
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
  const payload = build({
    source: "emby",
    server: SERVER,
    title: scoped.title,
    scope: scoped.scope,
    items: scoped.items.map((i) => ({ url: streamUrl(i.Id), title: episodeLabel(i), duration: durationSeconds(i) })),
  });
  addVector("season-28", "28 episodes, realistic url length", payload, {
    handoff: chooseHandoff(payload, "vlc"),
    uriLength: launchUri(payload, "vlc").length,
  });
}

// 5. Unicode + characters that break naive serialisers.
{
  const item = episode("3020770", 1, 28, "잘 어울리는 게 부끄러운 일이라니까 — It Would Be Embarrassing, Really; №28");
  const scoped = scopeItems({ item, itemType: "Episode", children: [item], scope: "item" });
  const payload = build({
    source: "emby",
    server: SERVER,
    title: "Frieren: Beyond Journey's End — 葬送のフリーレン",
    scope: "item",
    items: [{ url: streamUrl("3020770"), title: episodeLabel(item), duration: durationSeconds(item) }],
    opts: { fs: true, one: true, start: 2 },
  });
  addVector("unicode-and-punctuation", "CJK text, em dash, comma, semicolon, fullwidth space", payload);
}

// 6. A queue too long for a URI: must be pushed to the .m3u download path.
{
  const children = Array.from({ length: 90 }, (_, index) => episode(4000000 + index, 1, index + 1, `Long ${index + 1}`));
  const ordered = orderItems(children);
  const payload = build({
    source: "emby",
    server: SERVER,
    title: "Big series",
    scope: "series",
    items: ordered.map((i) => ({ url: streamUrl(i.Id), title: episodeLabel(i), duration: durationSeconds(i) })),
  });
  addVector("too-many-items", "90 episodes must not be attempted as a URI", payload, {
    handoff: chooseHandoff(payload, "vlc"),
    uriLength: launchUri(payload, "vlc").length,
  });
}

// 7. Header options, used by the generic adapter (a referrer-locked stream).
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

const outPath = resolve(repo, "tests/fixtures/vectors.json");
mkdirSync(dirname(outPath), { recursive: true });
const document = {
  generatedBy: "tools/vectors/generate.mjs",
  payloadVersion: 1,
  note: "Golden contract shared by the JS, Python and PowerShell implementations. Do not hand-edit: run `npm run vectors`.",
  vectors,
};
writeFileSync(outPath, JSON.stringify(document, null, 2) + "\n", "utf-8");

console.log(`wrote ${outPath}`);
for (const vector of vectors) {
  const handoff = vector.handoff ? ` handoff=${vector.handoff.mode}(${vector.handoff.reason || "ok"})` : "";
  console.log(
    `  ${vector.name.padEnd(24)} items=${String(vector.payload.items.length).padStart(2)} uri=${String(vector.uri.length).padStart(5)}B base64=${vector.base64.length}B${handoff}`,
  );
}
