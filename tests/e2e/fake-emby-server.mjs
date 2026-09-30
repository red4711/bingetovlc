/**
 * Hermetic fake Emby server for the end-to-end test.
 *
 * It impersonates only the slices of Emby 4.10 that the adapter touches, using
 * the shapes recorded in docs/SPEC.md §4 (Series -> Seasons -> Episodes with
 * ParentIndexNumber/IndexNumber/RunTimeTicks/Path/UserData, one Virtual episode
 * that must never reach a playlist, and a byte-range-streaming endpoint that
 * returns the EBML/Matroska magic bytes).
 *
 * The fixture is a single 28-episode season plus one Virtual episode, so every
 * scope has a known, checkable length:
 *   season page / series page / episode scope "season" -> 28
 *   episode rest-of-season starting at S01E03          -> 26
 *   episode scope "item" / movie page                   -> 1
 *
 * It also logs what it was asked for, which is the real regression guard: the
 * e2e asserts that the ids the server actually served cover the episode ids the
 * playlist claims, and that no request URL has the server address pasted into
 * it twice (a real bug this harness caught).
 *
 * No dependencies: node:http only.
 */
import http from "node:http";
import { readFileSync } from "node:fs";

export const FAKE_PORT = 8731;
export const FAKE_ORIGIN = `http://127.0.0.1:${FAKE_PORT}`;
export const FAKE_TOKEN = "fake-token-4a7b9c0d1e2f3a4b5c6d7e8f";
export const FAKE_USER_ID = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";

const TICKS = 10000000;
const BLOB_LENGTH = 65536; // 64 KiB, "roughly 64 KB"

export const SERIES_ID = "series-1";
export const SEASON_ID = "season-1";
export const MOVIE_ID = "500";
export const VIRTUAL_EPISODE_ID = "3199";
export const SEASON_EPISODE_COUNT = 28;
export const PLAYABLE_EPISODE_IDS = Array.from({ length: SEASON_EPISODE_COUNT }, (_, i) => String(3101 + i));

/** One piece of fake Matroska: EBML magic, then a deterministic filler. */
function makeBlob() {
  const blob = Buffer.alloc(BLOB_LENGTH);
  blob[0] = 0x1a;
  blob[1] = 0x45;
  blob[2] = 0xdf;
  blob[3] = 0xa3;
  for (let i = 4; i < BLOB_LENGTH; i++) blob[i] = i & 0xff;
  return blob;
}

function episode(id, index, name, extra = {}) {
  return {
    Id: String(id),
    Name: name,
    Type: "Episode",
    MediaType: "Video",
    ParentIndexNumber: 1,
    IndexNumber: index,
    RunTimeTicks: (1400 + index * 7) * TICKS,
    Path: `/mnt/media/shows/fake/season-1/${id}.mkv`,
    Container: "mkv",
    SeriesId: SERIES_ID,
    SeriesName: "Fake Show",
    SeasonId: SEASON_ID,
    SeasonName: "Season 1",
    UserData: { Played: false, PlayCount: 0, PlaybackPositionTicks: 0, IsFavorite: false },
    LocationType: "FileSystem",
    ...extra,
  };
}

export const SERIES = {
  Id: SERIES_ID,
  Name: "Fake Show",
  Type: "Series",
  SeriesName: "Fake Show",
  Path: "/mnt/media/shows/fake",
  UserData: { Played: false, PlayCount: 0 },
};

export const SEASONS = [
  {
    Id: SEASON_ID,
    Name: "Season 1",
    Type: "Season",
    IndexNumber: 1,
    ChildCount: SEASON_EPISODE_COUNT,
    SeriesId: SERIES_ID,
    SeriesName: "Fake Show",
    Path: "/mnt/media/shows/fake/season-1",
    UserData: { Played: false },
  },
];

export const EPISODES = [
  ...PLAYABLE_EPISODE_IDS.map((id, i) => episode(id, i + 1, `Episode ${i + 1}`)),
  // Announced but not on disk: must never reach a playlist.
  episode(VIRTUAL_EPISODE_ID, SEASON_EPISODE_COUNT + 1, "Announced, not on disk", {
    LocationType: "Virtual",
    Path: "",
    RunTimeTicks: 0,
  }),
];

export const MOVIE = {
  Id: MOVIE_ID,
  Name: "Fake Movie",
  Type: "Movie",
  MediaType: "Video",
  RunTimeTicks: 5880 * TICKS,
  Path: "/mnt/media/movies/fake-movie.mkv",
  Container: "mkv",
  UserData: { Played: false, PlayCount: 0, PlaybackPositionTicks: 0, IsFavorite: false },
};

const ALL_ITEMS = [SERIES, ...SEASONS, ...EPISODES, MOVIE];
const BY_ID = new Map(ALL_ITEMS.map((item) => [String(item.Id), item]));

function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(payload);
}

function userJson() {
  return {
    Id: FAKE_USER_ID,
    Name: "Fake User",
    ServerId: "fake-server",
    Policy: { IsAdministrator: true, EnableAllFolders: true },
  };
}

/** Episodes of a season, or every episode of the series, in API order. */
function episodesFor({ parentId, seasonId, seriesId } = {}) {
  const wantedSeason = seasonId || parentId;
  if (wantedSeason) {
    if (String(wantedSeason) === SEASON_ID) return [...EPISODES];
    if (String(wantedSeason) === SERIES_ID) return [...EPISODES];
    return [];
  }
  if (seriesId) return String(seriesId) === SERIES_ID ? [...EPISODES] : [];
  return [...EPISODES];
}

function pageHtml() {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Fake Emby</title></head>
<body>
  <main id="app"><h1>Fake Emby</h1></main>
  <video id="video" playsinline></video>
  <script>
    // Test mode must be on before the userscript executes (docs/SPEC.md §5 test hooks).
    window.__BINGETOVLC_TEST_MODE__ = true;
    (function () {
      var params = new URLSearchParams(location.search);
      var route = params.get("route") || "item";
      var id = params.get("id") || ${JSON.stringify(MOVIE_ID)};
      var want = "#!/" + route + "?id=" + id;
      if (location.hash !== want) location.hash = want;
      window.ApiClient = {
        serverAddress: function () { return ${JSON.stringify(FAKE_ORIGIN)}; },
        accessToken: function () { return ${JSON.stringify(FAKE_TOKEN)}; },
        getCurrentUserId: function () { return ${JSON.stringify(FAKE_USER_ID)}; },
        getCurrentUser: function () { return Promise.resolve(${JSON.stringify(userJson())}); },
        deviceId: function () { return "fake-device"; },
        appName: function () { return "FakeEmbyWeb"; },
        appVersion: function () { return "4.10.0.40"; },
        getItem: function (uid, itemId) {
          return fetch(${JSON.stringify(FAKE_ORIGIN)} + "/Users/" + uid + "/Items/" + itemId).then(function (r) { return r.json(); });
        }
      };
    })();
  </script>
  <script src="/bingetovlc.user.js"></script>
</body>
</html>
`;
}

/**
 * Start the fake server.
 * @param {{port?:number, userscriptPath:string}} options
 * @returns {Promise<{url:string, state:object, close:()=>Promise<void>}>}
 */
export function startFakeEmby({ port = FAKE_PORT, userscriptPath } = {}) {
  const blob = makeBlob();

  const state = {
    token: FAKE_TOKEN,
    userId: FAKE_USER_ID,
    /** "METHOD /path?query" for every request, for debugging. */
    requests: [],
    /** The raw request target (path + query) as the client sent it. */
    requestTargets: [],
    /** Ids the server was actually asked to stream (should all be in a playlist). */
    streamedIds: [],
    /** Ids the server actually served as items/list entries. */
    servedItemIds: new Set(),
    /** Item ids requested through the item detail endpoint. */
    requestedItemIds: [],
    userscriptReads: 0,
    unauthorizedStreams: 0,
    badRanges: 0,
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, FAKE_ORIGIN);
    const pathname = decodeURIComponent(url.pathname);
    state.requests.push(`${req.method} ${pathname}${url.search}`);
    state.requestTargets.push(String(req.url));

    if (req.method !== "GET" && req.method !== "HEAD") {
      json(res, 405, { error: "method not allowed" });
      return;
    }

    // --- static page + userscript -----------------------------------------
    if (pathname === "/web/index.html" || pathname === "/web/" || pathname === "/") {
      const body = pageHtml();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }

    if (pathname === "/bingetovlc.user.js") {
      state.userscriptReads++;
      let body;
      try {
        body = readFileSync(userscriptPath, "utf8");
      } catch (error) {
        json(res, 404, { error: `userscript not readable at ${userscriptPath}: ${error.message}` });
        return;
      }
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }

    if (pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    // --- Emby metadata ----------------------------------------------------
    if (pathname === "/System/Info/Public") {
      json(res, 200, { ServerName: "Fake Emby", Version: "4.10.0.40", ProductName: "Emby Server", Id: "fake-server", StartupWizardCompleted: true });
      return;
    }

    if (pathname === "/Users") {
      json(res, 200, { Items: [userJson()], TotalRecordCount: 1 });
      return;
    }

    let match = pathname.match(/^\/Users\/([^/]+)\/Items\/([^/]+)$/);
    if (match) {
      const itemId = match[2];
      const item = BY_ID.get(String(itemId));
      state.requestedItemIds.push(itemId);
      if (!item) {
        json(res, 404, { error: `no item ${itemId}` });
        return;
      }
      state.servedItemIds.add(String(item.Id));
      json(res, 200, item);
      return;
    }

    match = pathname.match(/^\/Users\/([^/]+)\/Items$/);
    if (match) {
      const includeTypes = url.searchParams.get("IncludeItemTypes");
      const items = includeTypes && includeTypes !== "Episode"
        ? []
        : episodesFor({ parentId: url.searchParams.get("ParentId"), seasonId: url.searchParams.get("SeasonId"), seriesId: url.searchParams.get("SeriesId") });
      for (const item of items) state.servedItemIds.add(String(item.Id));
      json(res, 200, { Items: items, TotalRecordCount: items.length });
      return;
    }

    match = pathname.match(/^\/Shows\/([^/]+)\/Seasons$/);
    if (match) {
      const items = String(match[1]) === SERIES_ID ? [...SEASONS] : [];
      for (const item of items) state.servedItemIds.add(String(item.Id));
      json(res, 200, { Items: items, TotalRecordCount: items.length });
      return;
    }

    match = pathname.match(/^\/Shows\/([^/]+)\/Episodes$/);
    if (match) {
      const items = episodesFor({ seriesId: match[1], seasonId: url.searchParams.get("SeasonId") });
      for (const item of items) state.servedItemIds.add(String(item.Id));
      json(res, 200, { Items: items, TotalRecordCount: items.length });
      return;
    }

    // --- streaming --------------------------------------------------------
    match = pathname.match(/^\/Videos\/([^/]+)\/stream$/);
    if (match) {
      const itemId = match[1];
      const apiKey = url.searchParams.get("api_key");
      const tokenHeader = req.headers["x-emby-token"];
      const provided = apiKey || tokenHeader;
      if (!provided || provided !== FAKE_TOKEN) {
        state.unauthorizedStreams++;
        json(res, 401, { error: "Unauthorized" }, { "WWW-Authenticate": 'Bearer realm="Fake Emby"' });
        return;
      }
      if (!BY_ID.has(String(itemId))) {
        json(res, 404, { error: `no item ${itemId}` });
        return;
      }
      state.streamedIds.push(String(itemId));

      const range = req.headers.range;
      const baseHeaders = {
        "Content-Type": "video/x-matroska",
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      };
      if (!range) {
        res.writeHead(200, { ...baseHeaders, "Content-Length": blob.length });
        res.end(req.method === "HEAD" ? undefined : blob);
        return;
      }
      const parsed = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!parsed) {
        state.badRanges++;
        res.writeHead(416, { ...baseHeaders, "Content-Range": `bytes */${blob.length}` });
        res.end();
        return;
      }
      let start = parsed[1] === "" ? 0 : Number(parsed[1]);
      let end = parsed[2] === "" ? blob.length - 1 : Number(parsed[2]);
      if (start > end || start >= blob.length) {
        state.badRanges++;
        res.writeHead(416, { ...baseHeaders, "Content-Range": `bytes */${blob.length}` });
        res.end();
        return;
      }
      end = Math.min(end, blob.length - 1);
      const slice = blob.subarray(start, end + 1);
      res.writeHead(206, {
        ...baseHeaders,
        "Content-Range": `bytes ${start}-${end}/${blob.length}`,
        "Content-Length": slice.length,
      });
      res.end(req.method === "HEAD" ? undefined : slice);
      return;
    }

    json(res, 404, { error: `fake Emby does not implement ${pathname}` });
  });

  return new Promise((resolve, reject) => {
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        reject(new Error(`port ${port} is already in use; the fake Emby server needs it exclusively`));
      } else {
        reject(error);
      }
    });
    server.listen(port, "127.0.0.1", () => {
      resolve({
        url: FAKE_ORIGIN,
        state,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}