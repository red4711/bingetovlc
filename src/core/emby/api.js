/**
 * bingetovlc — Emby API access layer.
 *
 * Design constraint that shapes this whole file: the server address, the token
 * and the user id are taken from the *web client's own* objects at runtime, and
 * nothing about the host is hardcoded. Two different client generations were
 * observed live:
 *
 *   - self-hosted Emby 4.10: serves /web/index.html, global `Emby`,
 *     web/app.js?v=4.10.0.40
 *   - app.emby.media: serves its own client at the root
 *     (apploader.js?v=26.0.30), and 404s on /web/index.html
 *
 * In both cases `window.ApiClient` only appears once the client has finished
 * booting, so `waitForSession()` polls for it instead of assuming it exists at
 * document-start.
 *
 * API behaviour below was verified against a live Emby 4.10.0.40 server; the
 * comments record what was actually observed, including the failures, because
 * every one of them caused a design decision.
 */

/** How long we are willing to wait for Emby's web client to publish ApiClient. */
export const SESSION_WAIT_MS = 20000;

const CHILD_FIELDS = "ParentIndexNumber,IndexNumber,Path,RunTimeTicks";

/** Absolute URL for the direct-play file. Verified: 206 + Matroska magic. */
export function streamUrl(server, itemId, token) {
  const base = String(server).replace(/\/+$/, "");
  return `${base}/Videos/${encodeURIComponent(itemId)}/stream?Static=true&api_key=${encodeURIComponent(token)}`;
}

export function itemUrl(server, uid, itemId) {
  const base = String(server).replace(/\/+$/, "");
  if (itemId) return `${base}/Users/${encodeURIComponent(uid)}/Items/${encodeURIComponent(itemId)}`;
  return `${base}/Users/${encodeURIComponent(uid)}/Items`;
}

export function childrenUrl(server, uid, { parentId, seriesId, seasonId, startIndex = 0, limit = 200 }) {
  const base = String(server).replace(/\/+$/, "");
  const params = new URLSearchParams();
  if (parentId) params.set("ParentId", parentId);
  if (seriesId) params.set("SeriesId", seriesId);
  if (seasonId) params.set("SeasonId", seasonId);
  params.set("IncludeItemTypes", "Episode");
  params.set("Recursive", "false");
  params.set("SortBy", "ParentIndexNumber,IndexNumber");
  params.set("Fields", CHILD_FIELDS);
  params.set("Limit", String(limit));
  params.set("StartIndex", String(startIndex));
  // The uid is part of the path, not a query parameter, for this endpoint.
  return `${base}/Users/${encodeURIComponent(uid)}/Items?${params.toString()}`;
}

export function seriesEpisodesUrl(server, uid, seriesId, { seasonId, startIndex = 0, limit = 200 } = {}) {
  const base = String(server).replace(/\/+$/, "");
  const params = new URLSearchParams();
  params.set("UserId", uid);
  if (seasonId) params.set("SeasonId", seasonId);
  params.set("Fields", CHILD_FIELDS);
  params.set("SortBy", "ParentIndexNumber,IndexNumber");
  params.set("Limit", String(limit));
  params.set("StartIndex", String(startIndex));
  return `${base}/Shows/${encodeURIComponent(seriesId)}/Episodes?${params.toString()}`;
}

/**
 * Pull server/token/user out of the Emby web client.
 *
 * Preference order:
 *   1. `window.ApiClient` — the web client's own object (authoritative)
 *   2. `window.Emby.ApiClient` / `window.Emby.Page`-era aliases
 *   3. localStorage credentials (best effort, may lack a token; mark as such)
 *
 * Returns null when nothing usable is found, so the caller can decide whether to
 * retry, and never throws: a userscript must not break the page it runs on.
 */
export function readSession(win) {
  const candidates = [];
  if (win && win.ApiClient) candidates.push(win.ApiClient);
  if (win && win.Emby && win.Emby.ApiClient) candidates.push(win.Emby.ApiClient);

  for (const apiClient of candidates) {
    const session = describeApiClient(apiClient, win);
    if (session && session.server && session.token && session.uid) return session;
  }

  const stored = readStoredCredentials(win);
  if (stored) return stored;
  return null;
}

function callMaybe(target, name) {
  try {
    return typeof target[name] === "function" ? target[name]() : undefined;
  } catch {
    return undefined;
  }
}

function describeApiClient(apiClient, win) {
  const server = normalizeServer(callMaybe(apiClient, "serverAddress") || callMaybe(apiClient, "serverAddressAsync"));
  const token = callMaybe(apiClient, "accessToken");
  let uid = callMaybe(apiClient, "getCurrentUserId");
  if (!uid) {
    const user = callMaybe(apiClient, "getCurrentUser");
    if (user && user.Id) uid = user.Id;
  }
  return {
    server: server || null,
    token: token || null,
    uid: uid || null,
    apiClient,
    // Emby deployments can sit behind a path prefix; when the client can build
    // URLs itself, prefer its answer over string concatenation.
    getUrl: typeof apiClient.getUrl === "function" ? (path) => apiClient.getUrl(path) : null,
    source: "ApiClient",
    win,
  };
}

/** ApiClient.serverAddress() can return a URL object or a string; normalise. */
function normalizeServer(value) {
  if (!value) return null;
  const text = typeof value === "string" ? value : value.href || value.origin || String(value);
  return text.replace(/\/+$/, "") || null;
}

/**
 * Last-resort credential read.
 *
 * Emby stores credentials in localStorage under `servercredentials3` (older
 * builds: `servercredentials`) in a known shape, verified by reading the shipped
 * bundles:
 *
 *   {ConnectUserId, ConnectAccessToken,
 *    Servers: [{Id, Name, ManualAddress, LocalAddress, RemoteAddress, AccessToken,
 *               UserId, Users: [{UserId, AccessToken}]}]}
 *
 * The per-user token lives at `Servers[].Users[].AccessToken`, which is why the
 * server list is handled explicitly here rather than by a generic deep walk: a
 * generic walk finds a server node with an address and an AccessToken but no
 * matching UserId, and would pair them up wrongly.
 */
function readStoredCredentials(win) {
  try {
    const store = win.localStorage;
    if (!store) return null;
    const keys = [];
    for (let i = 0; i < store.length; i++) keys.push(store.key(i));
    const credentialKeys = keys.filter((key) => /credential|server/i.test(key));
    for (const key of credentialKeys) {
      const parsed = safeParse(store.getItem(key));
      const fromServers = findStoredServer(parsed);
      if (fromServers) return { ...fromServers, source: `localStorage:${key}`, untrusted: true, win };
    }
    for (const key of credentialKeys) {
      const parsed = safeParse(store.getItem(key));
      const found = findCredentials(parsed);
      if (found) return { ...found, source: `localStorage:${key}`, untrusted: true, win };
    }
  } catch {
    /* storage can be blocked; that is fine */
  }
  return null;
}

/** The `servercredentials3` shape: address on the server, token on the user. */
function findStoredServer(parsed) {
  const servers = parsed && Array.isArray(parsed.Servers) ? parsed.Servers : null;
  if (!servers) return null;
  for (const server of servers) {
    if (!server || typeof server !== "object") continue;
    const address = server.ManualAddress || server.LocalAddress || server.RemoteAddress;
    const users = Array.isArray(server.Users) ? server.Users : [];
    for (const user of users) {
      if (user && user.AccessToken && user.UserId && address) {
        return { server: normalizeServer(address), token: user.AccessToken, uid: user.UserId, apiClient: null, getUrl: null };
      }
    }
    if (server.AccessToken && server.UserId && address) {
      return { server: normalizeServer(address), token: server.AccessToken, uid: server.UserId, apiClient: null, getUrl: null };
    }
  }
  return null;
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function findCredentials(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 4) return null;
  const server = node.ManualAddress || node.ServerAddress || node.Address;
  const token = node.AccessToken || node.Token;
  const uid = node.UserId || (node.User && node.User.Id);
  if (server && token && uid) {
    return { server: normalizeServer(server), token, uid, apiClient: null, getUrl: null };
  }
  for (const value of Object.values(node)) {
    const found = findCredentials(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Poll until the web client publishes its session, or give up. */
export async function waitForSession(win, { timeoutMs = SESSION_WAIT_MS, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const session = readSession(win);
    if (session) return session;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function buildUrl(session, path) {
  // The helpers in this file (streamUrl, childrenUrl, seriesEpisodesUrl) return
  // absolute URLs while fetchItem passes a path, and mixing the two is how the
  // first version of this produced "http://hosthttp://host/Shows/..." — a bug
  // the end-to-end harness caught. Absolute input wins, always.
  if (/^https?:\/\//i.test(String(path))) return String(path);
  if (session && session.getUrl) {
    try {
      const url = session.getUrl(path);
      if (url) return url;
    } catch {
      /* fall through to concatenation */
    }
  }
  return `${String(session.server).replace(/\/+$/, "")}${path}`;
}

async function fetchJson(session, path, { method = "GET", body = null, fetchImpl } = {}) {
  const doFetch = fetchImpl || session.win?.fetch?.bind(session.win) || fetch;
  const headers = { Accept: "application/json" };
  if (session.token) headers["X-Emby-Token"] = session.token;
  const options = { method, headers, credentials: "same-origin" };
  if (body !== null) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await doFetch(buildUrl(session, path), options);
  if (!response.ok) {
    const detail = await safeText(response);
    const error = new Error(errorMessageFor(response.status, detail));
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function safeText(response) {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return "";
  }
}

function errorMessageFor(status, detail) {
  if (status === 401 || status === 403) {
    return `Emby refused the request (HTTP ${status}). The web session may have expired — reload the Emby page and try again.`;
  }
  return `Emby request failed with HTTP ${status}${detail ? `: ${detail}` : ""}`;
}

export async function fetchItem(session, itemId, options = {}) {
  return fetchJson(session, `/Users/${encodeURIComponent(session.uid)}/Items/${encodeURIComponent(itemId)}`, options);
}

/**
 * Fetch every child the scope needs.
 *
 * Two verified quirks drive the shape of this function:
 *   - `/Shows/{seriesId}/Episodes?SeasonId=<season item id>` is the reliable way
 *     to list one season; it returned 28 items for a 28 episode season, ordered.
 *     `ParentId=<season folder id>` also worked (28 items) and is used as the
 *     fallback path when the parent chain lacks a SeriesId.
 *   - `Fields=…MediaSources…` on a whole season produced a >200 KB body (a JSON
 *     parse failure was observed), so only the four minimal fields are asked for
 *     and per-item detail is fetched separately when actually needed.
 *
 * Paging is explicit because a series can hold hundreds of episodes.
 */
export async function fetchChildren(session, { item, itemType, options = {} } = {}) {
  const maxItems = options.maxItems ?? 3000;
  const pageSize = options.pageSize ?? 200;
  const collected = [];
  let total = null;

  const request = async (path) => fetchJson(session, path, options);

  const fetchPage = async (pathFor) => {
    for (let startIndex = 0; collected.length < maxItems; startIndex += pageSize) {
      const data = await request(pathFor(startIndex));
      const items = Array.isArray(data.Items) ? data.Items : [];
      if (total === null) total = typeof data.TotalRecordCount === "number" ? data.TotalRecordCount : items.length;
      collected.push(...items);
      if (items.length === 0 || collected.length >= total) break;
    }
  };

  if (itemType === "Season") {
    if (item.SeriesId) {
      await fetchPage((startIndex) =>
        seriesEpisodesUrl(session.server, session.uid, item.SeriesId, { seasonId: item.Id, startIndex, limit: pageSize }),
      );
    } else {
      await fetchPage((startIndex) =>
        childrenUrl(session.server, session.uid, { parentId: item.Id, startIndex, limit: pageSize }),
      );
    }
  } else if (itemType === "Series") {
    await fetchPage((startIndex) =>
      seriesEpisodesUrl(session.server, session.uid, item.Id, { startIndex, limit: pageSize }),
    );
  } else if (itemType === "Episode" && (item.SeasonId || item.SeriesId)) {
    if (item.SeriesId && item.SeasonId) {
      await fetchPage((startIndex) =>
        seriesEpisodesUrl(session.server, session.uid, item.SeriesId, { seasonId: item.SeasonId, startIndex, limit: pageSize }),
      );
    } else if (item.SeasonId) {
      await fetchPage((startIndex) =>
        childrenUrl(session.server, session.uid, { parentId: item.SeasonId, startIndex, limit: pageSize }),
      );
    }
  }

  return { items: collected, total: total === null ? collected.length : total };
}

/** Ask Emby which seasons a series has (used for the "whole show" queue). */
export async function fetchSeasons(session, seriesId, options = {}) {
  const path = `/Shows/${encodeURIComponent(seriesId)}/Seasons?UserId=${encodeURIComponent(session.uid)}&Fields=IndexNumber,ChildCount`;
  const data = await fetchJson(session, path, options);
  return Array.isArray(data.Items) ? data.Items : [];
}

/**
 * PlaybackInfo is deliberately NOT used to obtain the stream URL.
 *
 * Verified on 4.10.0.40: it returned HTTP 200 with MediaSources[0] reporting
 * SupportsDirectPlay/SupportsDirectStream true but `DirectStreamUrl: None` for
 * both an Episode and a Movie, and it returns HTTP 500 for a Series or Season
 * ("Unable to cast object of type … Series to type … IHasMediaSources"). The
 * file endpoint above is the only thing the handoff needs, so this function
 * exists purely to answer "can this item be direct played at all?" and to give
 * the UI a reason when it cannot.
 */
export async function probeMediaSource(session, itemId, options = {}) {
  try {
    const data = await fetchJson(
      session,
      `/Items/${encodeURIComponent(itemId)}/PlaybackInfo?UserId=${encodeURIComponent(session.uid)}`,
      { ...options, method: "POST", body: {} },
    );
    const source = (data.MediaSources || [])[0];
    if (!source) return { playable: false, reason: "Emby reported no media source for this item" };
    return {
      playable: Boolean(source.SupportsDirectPlay || source.SupportsDirectStream),
      container: source.Container,
      sizeBytes: source.Size,
      runtimeSeconds: source.RunTimeTicks ? Math.round(source.RunTimeTicks / 10000000) : undefined,
      reason: source.SupportsDirectPlay || source.SupportsDirectStream ? null : "Emby reports this item cannot be direct played",
    };
  } catch (error) {
    return { playable: false, reason: error.message };
  }
}
