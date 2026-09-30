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
    const wanted = pageServerId(win);
    for (const key of credentialKeys) {
      const parsed = safeParse(store.getItem(key));
      const fromServers = findStoredServer(parsed, wanted);
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

/**
 * The server id the page is currently showing, e.g. `?serverId=abc…` in the hash
 * route. Emby Connect stores several servers, and picking the wrong one is how a
 * working session turns into "Failed to fetch" against another server's address.
 */
export function pageServerId(win) {
  try {
    const hash = String(win.location.hash || "");
    const query = hash.indexOf("?");
    if (query === -1) return null;
    return new URLSearchParams(hash.slice(query + 1)).get("serverId");
  } catch {
    return null;
  }
}

/**
 * The `servercredentials3` shape: address(es) on the server, token on the user.
 *
 * Every address the entry knows is collected, not just one. A real report showed
 * why: the stored `ManualAddress` was a Docker address (`http://172.20.0.10:8096`)
 * while the page was the https Emby Connect client, so the single stored address
 * was unreachable and blocked as mixed content at the same time. The list is
 * ordered remote-first and then probed (see resolveReachableServer).
 */
function findStoredServer(parsed, wantedServerId) {
  const servers = parsed && Array.isArray(parsed.Servers) ? parsed.Servers : null;
  if (!servers) return null;
  // The entry for the server this page is showing wins over the others.
  const wanted = wantedServerId ? String(wantedServerId) : null;
  const ordered = wanted
    ? [...servers.filter((server) => server && String(server.Id) === wanted), ...servers.filter((server) => !server || String(server.Id) !== wanted)]
    : servers;
  for (const server of ordered) {
    if (!server || typeof server !== "object") continue;
    const addresses = serverAddresses(server);
    const users = Array.isArray(server.Users) ? server.Users : [];
    const user = users.find((entry) => entry && entry.AccessToken && entry.UserId);
    const token = (user && user.AccessToken) || server.AccessToken;
    const uid = (user && user.UserId) || server.UserId;
    if (addresses.length && token && uid) {
      return { server: addresses[0], addresses, token, uid, serverId: server.Id || null, apiClient: null, getUrl: null };
    }
  }
  return null;
}

/** Every address a server entry knows, in the order the client would try them. */
function serverAddresses(server) {
  const out = [];
  for (const value of [server.RemoteAddress, server.ManualAddress, server.LocalAddress]) {
    const address = normalizeServer(value);
    if (address && !out.includes(address)) out.push(address);
  }
  return out;
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

const PRIVATE_HOST = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|localhost|\[?::1\]?)$/i;

/** True for addresses a public page cannot reach: LAN, loopback, link-local. */
export function isPrivateHost(host) {
  const text = String(host || "").toLowerCase();
  if (!text) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(text)) return true;
  return /^(10\.|127\.|169\.254\.|192\.168\.|localhost$|\[?::1\]?$)/.test(text);
}

function safeOrigin(win) {
  try {
    return String(win.location.origin || "");
  } catch {
    return "";
  }
}

function safeHost(win) {
  try {
    return String(win.location.hostname || "");
  } catch {
    return "";
  }
}

/**
 * Order the addresses a page could use for a server, and flag the ones a browser
 * will refuse outright.
 *
 * This is the fix for the reported failure: the credential fallback trusted one
 * stored address, which was a Docker address over plain http while the page was
 * the https Emby Connect client — so the request died with "Failed to fetch" and
 * the only symptom was an empty scope dropdown. Ranking is by what the browser
 * will actually permit:
 *
 *   - same origin as the page wins: no CORS, no mixed content
 *   - https, or http on the page's own host (upgraded to https)
 *   - a private address is unusable from a public page: Chrome blocks it, and it
 *     is usually unroutable from a remote browser anyway
 *   - plain http from an https page is mixed content: always blocked
 */
export function orderAddressCandidates({ addresses = [], pageOrigin = "", pageHost = "", pageIsPrivate = false } = {}) {
  const seen = new Set();
  const candidates = [];
  const httpsPage = String(pageOrigin).startsWith("https:");
  for (const raw of addresses) {
    const url = normalizeServer(raw);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      candidates.push({ url, rank: 9, blocked: true, reason: "not a usable URL" });
      continue;
    }
    if (pageOrigin && parsed.origin === pageOrigin) {
      candidates.push({ url, rank: 0, reason: "same origin as the page" });
      continue;
    }
    const sameHost = pageHost && parsed.hostname.toLowerCase() === String(pageHost).toLowerCase();
    const secure = parsed.protocol === "https:";
    if (!secure && httpsPage) {
      if (sameHost) {
        candidates.push({ url: url.replace(/^http:/, "https:"), rank: 1, reason: "upgraded to https to match the page" });
        continue;
      }
      candidates.push({ url, rank: 8, blocked: true, reason: "plain http from an https page is blocked as mixed content" });
      continue;
    }
    if (isPrivateHost(parsed.hostname) && !pageIsPrivate) {
      candidates.push({ url, rank: 8, blocked: true, reason: "a private address cannot be reached from a public page" });
      continue;
    }
    candidates.push({ url, rank: secure ? 1 : 2, reason: secure ? "https" : "http" });
  }
  return candidates.sort((a, b) => a.rank - b.rank);
}

/**
 * Ask an address who it is.
 *
 * `/System/Info/Public` needs no token, but a bare `response.ok` is not proof: a
 * single-page host answers 200 with HTML for unknown paths, so Emby Connect's own
 * app host looked like a valid server. The body has to be Emby's public-info JSON.
 */
async function probeServer(doFetch, base, timeoutMs) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await doFetch(`${String(base).replace(/\/+$/, "")}/System/Info/Public`, {
      signal: controller ? controller.signal : undefined,
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!response || !response.ok) return false;
    const data = await response.json();
    return Boolean(data && typeof data === "object" && (data.Version || data.ServerName || data.Id));
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Settle on an address that answers.
 *
 * `/System/Info/Public` needs no token, so this is a safe, cheap reachability
 * test. When every candidate fails the first usable one is kept, so behaviour
 * degrades to the previous version rather than to nothing, and the reason is
 * carried on the session for the bug report.
 */
export async function resolveReachableServer(session, win, { fetchImpl, timeoutMs = 4000 } = {}) {
  const pageOrigin = safeOrigin(win);
  const pageHost = safeHost(win);
  const addresses = [session.server, ...(session.addresses || []), pageOrigin];
  const candidates = orderAddressCandidates({ addresses, pageOrigin, pageHost, pageIsPrivate: isPrivateHost(pageHost) });
  const usable = candidates.filter((candidate) => !candidate.blocked);
  if (!usable.length) {
    const fallback = candidates[0];
    return { ...session, server: fallback ? fallback.url : session.server, probe: fallback ? `no usable address (${fallback.reason})` : "no address" };
  }
  const doFetch = fetchImpl || (win && win.fetch ? win.fetch.bind(win) : fetch);
  const failures = [];
  for (const candidate of usable) {
    if (await probeServer(doFetch, candidate.url, timeoutMs)) {
      return { ...session, server: candidate.url, reachable: true, probe: `${candidate.url} (${candidate.reason})` };
    }
    failures.push(`${candidate.url} — ${candidate.reason}`);
  }
  // Nothing answered: keep the address the session actually came with. Falling
  // back to a candidate this function invented (the page origin) would be a
  // guess, and a guess is worse than the previous version's behaviour.
  return {
    ...session,
    server: session.server || (usable[0] && usable[0].url),
    reachable: false,
    probe: `nothing answered: ${failures.join("; ")}`,
  };
}

/** Poll until the web client publishes its session, then settle on a live address. */
export async function waitForSession(win, { timeoutMs = SESSION_WAIT_MS, intervalMs = 250, fetchImpl } = {}) {
  const deadline = Date.now() + timeoutMs;
  let found = null;
  for (;;) {
    found = readSession(win);
    if (found) break;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return resolveReachableServer(found, win, { fetchImpl });
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
  const url = buildUrl(session, path);
  let response;
  try {
    response = await doFetch(url, options);
  } catch (cause) {
    // A rejected fetch is a network-level failure — mixed content, CORS, an
    // extension, or an address the browser cannot route. The bare message
    // ("Failed to fetch") reached a user as the entire explanation of a broken
    // panel, so name the address and where it came from.
    const error = new Error(networkErrorMessage(url, cause, session));
    error.network = true;
    error.cause = cause;
    throw error;
  }
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

/**
 * Turn a rejected fetch into something a user can act on.
 *
 * The interesting cases, in the order they bite: a private or plain-http address
 * grabbed from stored credentials while the page is a public https site (blocked
 * as mixed content, or simply unroutable), a server that answers but without CORS
 * for this origin, and an extension or DNS failure. All three used to surface as
 * the two words "Failed to fetch".
 */
function networkErrorMessage(url, cause, session) {
  let origin = url;
  try {
    origin = new URL(url).origin;
  } catch {
    /* keep the raw string */
  }
  const reason = cause && cause.message ? cause.message : "the request was blocked";
  const source =
    session && session.source === "ApiClient"
      ? "the page's own Emby client"
      : `stored credentials (${(session && session.source) || "unknown source"})`;
  return `Could not reach Emby at ${origin} — the browser refused the request before it left. The address came from ${source}. If that address is a LAN, Docker or plain-http address it cannot be used from this page (mixed content, or nothing to route to). Reload the Emby page while signed in so the client publishes a usable address. [${reason}]`;
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
