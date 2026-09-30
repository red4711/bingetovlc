/**
 * bingetovlc — bootstrap and orchestration.
 *
 * Runs on every page (the @match pattern has to be broad, see src/meta.js) and
 * has one job before anything else: decide, in milliseconds, whether this is an
 * Emby web client. If it is not, the script does nothing at all — no DOM, no
 * polling, no timers.
 *
 * On an Emby page it:
 *   1. waits for the web client to publish its session (server + token + user)
 *   2. reads the current item id from the client's own hash route
 *   3. asks Emby what that item is, and builds the right queue for its type
 *   4. hands the queue to VLC through the registered vlc:// handler
 *
 * Every failure is surfaced in the panel or the banner. A silent failure here
 * would look exactly like "the tool is broken", which is the one outcome worth
 * engineering against.
 */

const VERSION = "{{VERSION}}";

const EMBY_ROUTES = /^#!\/(item|details|list|videos|queue|home|movies|tv|shows|music|settings)/i;

const state = {
  session: null,
  itemId: null,
  item: null,
  itemType: null,
  // null means "no explicit choice yet": the default is derived from the item
  // type, so a season page queues the season and a movie page the movie.
  scope: null,
  queue: null,
  cacheKey: null,
  settings: null,
  warnings: [],
  lastHandoff: null,
  error: null,
};

function detectEmby(win) {
  try {
    if (win.ApiClient) return true;
    if (win.Emby && (win.Emby.ApiClient || win.Emby.Page || win.Emby.ConnectionManager)) return true;
    if (EMBY_ROUTES.test(win.location.hash || "")) return true;
    if (/\/web\/(index\.html)?$/i.test(win.location.pathname || "")) return true;
    const marker = win.document.querySelector('meta[name="application-name"], meta[name="apple-mobile-web-app-title"]');
    if (marker && /emby/i.test(marker.getAttribute("content") || "")) return true;
    return false;
  } catch {
    return false;
  }
}

/** The Emby client puts the item id in its own hash route, e.g. #!/item?id=3020741. */
function currentItemId(win) {
  try {
    const hash = String(win.location.hash || "").replace(/^#!?/, "");
    const queryIndex = hash.indexOf("?");
    if (queryIndex === -1) return null;
    const params = new URLSearchParams(hash.slice(queryIndex + 1));
    return params.get("id") || params.get("itemId") || params.get("Id") || null;
  } catch {
    return null;
  }
}

/**
 * Build the payload for a queue.
 *
 * `budget` is the URI length ceiling, or null for the downloaded-.m3u path where
 * there is no ceiling and the full episode titles are worth keeping.
 */
function payloadFor(queue, settings, budget) {
  const startIndex = queue.items.findIndex((entry) => String(entry.id) === String(state.itemId));
  const opts = handoffOptions(settings);
  if (startIndex > 0 && queue.scope !== "item") opts.start = startIndex + 1;
  return build({
    source: "emby",
    server: state.session.server,
    token: state.session.token,
    title: queue.title,
    scope: queue.scope,
    // Ids, not URLs. A season's worth of stream URLs is ~5.5 KB, and Windows caps
    // an external-protocol URI at about 2 KB (Chromium hands it to ShellExecute),
    // so the handler builds each URL from the id instead. Measured: the same
    // 28 episode season is ~700 bytes as ids and 5,471 bytes as URLs.
    items: queue.items.map((entry) => ({
      id: entry.id,
      title: entry.title,
      duration: entry.duration,
      // Sent so the handler can still label entries "S01E03" if building the URI
      // had to drop the titles to stay inside the ~2 KB Windows hand-off cap.
      season: entry.season,
      episode: entry.episode,
    })),
    opts,
    budget,
  });
}

async function ensureQueue(panel, { force = false } = {}) {
  const cacheKey = `${state.itemId}|${state.itemType}|${state.scope}`;
  if (!force && state.queue && state.cacheKey === cacheKey) return state.queue;

  panel.setBusy(true);
  panel.setStatus("Reading the episode list from Emby…");
  try {
    const queue = await buildQueue({
      session: state.session,
      item: state.item,
      itemType: state.itemType,
      scope: state.scope,
      startId: state.itemId,
    });
    if (state.settings.skipPlayed && queue.scope !== "item") {
      const before = queue.items.length;
      queue.items = queue.items.filter((entry) => !entry.played);
      if (queue.items.length !== before) {
        queue.warnings.push(`${before - queue.items.length} already-watched episode(s) were skipped (a setting you enabled).`);
      }
    }
    state.queue = queue;
    state.cacheKey = cacheKey;
    state.warnings = queue.warnings;
    return queue;
  } catch (error) {
    state.error = error.message;
    throw error;
  } finally {
    panel.setBusy(false);
  }
}

function summarize(queue) {
  if (!queue || !queue.items.length) return "Nothing to queue";
  const episodes = queue.items.length;
  return `${queue.title} — ${episodes} item${episodes === 1 ? "" : "s"}, ${formatDuration(queue.items)}`;
}

async function refresh(panel) {
  const id = currentItemId(document);
  if (!id) {
    state.itemId = null;
    state.queue = null;
    state.cacheKey = null;
    panel.setScopes(["item"], "item");
    panel.setSummary("Open a movie, episode, season or series in Emby", Boolean(state.session));
    panel.setStatus("");
    panel.renderList([]);
    return;
  }

  if (id !== state.itemId) {
    state.itemId = id;
    state.queue = null;
    state.cacheKey = null;
    state.error = null;
  }

  panel.setSummary("Reading item " + id + "…");
  try {
    const item = await fetchItem(state.session, id);
    state.item = item;
    state.itemType = item.Type || (item.IsFolder ? "Folder" : "Video");
    const scopes = availableScopes(state.itemType);
    state.scope = normalizeScope(state.itemType, state.scope);
    panel.setScopes(scopes, state.scope);

    const queue = await ensureQueue(panel, { force: true });
    panel.setSummary(summarize(queue), Boolean(state.session));
    panel.renderList(queue.items);
    const handoff = chooseHandoff(payloadFor(queue, state.settings), state.settings.scheme);
    panel.setUri(describeHandoff(handoff));
    if (queue.warnings.length) panel.setStatus(queue.warnings.join(" "), "warn");
    else panel.setStatus("");
  } catch (error) {
    state.error = error.message;
    panel.setSummary(state.itemType ? `${state.itemType} ${id}` : `Item ${id}`);
    panel.setStatus(error.message, "error");
  }
}

function wireSettings(panel, win) {
  const settings = state.settings;
  const rows = [
    ["fullscreen", "Open VLC fullscreen"],
    ["oneInstance", "Reuse a running VLC instance"],
    ["playAndExit", "Close VLC when the queue ends"],
    ["skipPlayed", "Skip already-watched episodes"],
    ["genericAdapter", "Try the experimental generic adapter (non-Emby pages)"],
  ];
  for (const [key, label] of rows) {
    const input = checkbox(document, `bingetovlc-opt-${key}`, Boolean(settings[key]));
    input.addEventListener("change", () => {
      state.settings = updateSetting(win, key, input.checked);
      if (key === "genericAdapter") bootstrapGeneric(win);
    });
    panel.addOption(label, input);
  }
  const scheme = selectInput(
    document,
    "bingetovlc-opt-scheme",
    [
      { value: "vlc", label: "vlc://" },
      { value: "bingetovlc", label: "bingetovlc:// (if vlc:// is taken)" },
    ],
    settings.scheme,
  );
  scheme.addEventListener("change", () => {
    state.settings = updateSetting(win, "scheme", scheme.value);
  });
  panel.addOption("URI scheme", scheme);

  const cache = numberInput(document, "bingetovlc-opt-cache", settings.networkCache, { min: 0, max: 60000 });
  cache.addEventListener("change", () => {
    state.settings = updateSetting(win, "networkCache", Number(cache.value) || 0);
  });
  panel.addOption("Network cache (ms, 0 = VLC default)", cache);
}

async function act(win, panel, kind) {
  try {
    const queue = await ensureQueue(panel);
    if (!queue.items.length) {
      panel.setStatus("Nothing to queue for this item.", "warn");
      return;
    }
    const payload = payloadFor(queue, state.settings, MAX_URI_LENGTH);

    if (kind === "preview") {
      panel.setUri(uriFor(payload, state.settings.scheme));
      panel.setStatus(`Preview: ${queue.items.length} item(s). Nothing was launched.`);
      return;
    }
    if (kind === "download") {
      // No URI here, so no budget: keep the episode titles.
      const filename = download(win, payloadFor(queue, state.settings, null), { includeTokens: true });
      panel.setStatus(`Saved ${filename}. Open it with VLC (double-click).`);
      showBanner(document, `Playlist saved as ${filename}. It contains your API token — do not share it.`, { kind: "warn" });
      return;
    }

    // Queues too long for a URI go out as a file, and that file gets the titles
    // back (the URI budget is what forced them out of the payload).
    const handoff =
      chooseHandoff(payload, state.settings.scheme).mode === "uri"
        ? deliver(payload, win, { scheme: state.settings.scheme })
        : deliver(payloadFor(queue, state.settings, null), win, { scheme: state.settings.scheme });
    state.lastHandoff = handoff;
    if (handoff.mode === "uri") {
      panel.setStatus(`Sent ${handoff.items} item(s) to the VLC handler (${handoff.length} byte URI).`);
      showBanner(
        document,
        `Opening ${handoff.items} item(s) in VLC. Chrome asks for permission the first time; accepting is remembered for this site (the "Always allow" checkbox is hidden unless your administrator enables it by policy).`,
        { kind: "info" },
      );
    } else {
      panel.setStatus(describeHandoff(handoff), "warn");
      showBanner(document, describeHandoff(handoff), { kind: "warn" });
    }
  } catch (error) {
    state.error = error.message;
    panel.setStatus(error.message, "error");
    showBanner(document, `bingetovlc: ${error.message}`, { kind: "error", timeoutMs: 15000 });
  }
}

function mount(win) {
  ensureStyles(document);
  // The handler object is filled in after the panel exists, so the callbacks can
  // close over it without creating the panel twice.
  const handlers = {};
  const panel = createPanel(document, handlers);

  panel.setSummary("Detecting Emby session…", false);
  document.body.appendChild(panel.root);

  Object.assign(handlers, {
    onPlay: () => act(win, panel, "play"),
    onPreview: () => act(win, panel, "preview"),
    onDownload: () => act(win, panel, "download"),
    onCopyUri: async () => {
      if (!state.queue) await ensureQueue(panel).catch(() => null);
      if (!state.queue) return;
      const ok = await copyText(win, uriFor(payloadFor(state.queue, state.settings), state.settings.scheme));
      panel.setStatus(ok ? "URI copied. Paste it into VLC via Ctrl+N if you prefer." : "Could not access the clipboard.", ok ? "" : "warn");
    },
    onDiagnostics: async () => {
      const text = report({
        session: state.session,
        target: { item: state.item, itemType: state.itemType, scope: state.scope, itemId: state.itemId },
        queue: state.queue,
        handoff: state.lastHandoff,
        warnings: state.warnings,
        version: VERSION,
        scheme: state.settings.scheme,
        error: state.error,
      });
      const ok = await copyText(win, text);
      panel.setStatus(ok ? "Diagnostic report copied (tokens redacted)." : "Could not access the clipboard.", ok ? "" : "warn");
    },
    onScopeChange: (value) => {
      state.scope = value;
      state.queue = null;
      refresh(panel);
    },
  });
  wireSettings(panel, win);

  return panel;
}

/**
 * Experimental: an .m3u for a non-Emby page. Off unless the user turns it on, and
 * it says so in the panel rather than pretending to be as reliable as the Emby
 * path.
 */
function bootstrapGeneric(win) {
  if (!state.settings.genericAdapter || state.session) return;
  try {
    const candidates = collectCandidates(document, { base: win.location.href });
    if (!candidates.length) return;
    const queue = buildGenericQueue({ doc: document, base: win.location.href });
    ensureStyles(document);
    const panel = createPanel(document, {
      onPlay: () => {
        const payload = build({
          source: "generic",
          server: win.location.origin,
          title: queue.title,
          scope: "item",
          items: queue.items.map((entry) => ({ url: entry.url, title: entry.title })),
        });
        deliver(payload, win, { scheme: state.settings.scheme });
      },
      onPreview: () => {},
      onDownload: () => {},
      onCopyUri: () => {},
      onDiagnostics: () => {},
      onScopeChange: () => {},
    });
    panel.setScopes(["item"], "item");
    panel.setSummary(`Generic adapter (experimental, confidence: ${queue.confidence})`);
    panel.setStatus(queue.warnings.join(" ") || "One stream URL found on this page.", queue.warnings.length ? "warn" : "");
    document.body.appendChild(panel.root);
  } catch {
    /* the experimental path must never break a page */
  }
}

function installNavigationWatch(win, panel) {
  let lastHash = win.location.hash;
  const check = () => {
    if (win.location.hash === lastHash) return;
    lastHash = win.location.hash;
    refresh(panel);
  };
  win.addEventListener("hashchange", check);
  win.addEventListener("popstate", check);
  // Some Emby views update the route without firing hashchange.
  setInterval(check, 2000);
}

async function run(win) {
  state.settings = loadSettings(win);
  if (!detectEmby(win)) {
    bootstrapGeneric(win);
    return;
  }

  const session = await waitForSession(win, { timeoutMs: 25000 });
  if (!session) {
    // The page looked like Emby but the client never published a session: either
    // the user is not signed in yet, or the client is a generation whose objects
    // this script does not know. Say so instead of disappearing.
    showBanner(document, "bingetovlc: this looks like an Emby page, but no signed-in session was found. Sign in, then reload.", {
      kind: "warn",
      timeoutMs: 12000,
    });
    return;
  }

  state.session = session;
  const panel = mount(win);
  panel.setSummary(summarize(null), true);
  await refresh(panel);
  installNavigationWatch(win, panel);

  // Handy from the browser console and for bug reports; documented in
  // docs/troubleshooting.md.
  win.bingetovlc = {
    version: VERSION,
    state,
    refresh: () => refresh(panel),
    report: () =>
      report({
        session: state.session,
        target: { item: state.item, itemType: state.itemType, scope: state.scope, itemId: state.itemId },
        queue: state.queue,
        handoff: state.lastHandoff,
        warnings: state.warnings,
        version: VERSION,
        scheme: state.settings.scheme,
        error: state.error,
      }),
  };
}

try {
  run(window);
} catch (error) {
  // A userscript must never break the host page.
  try {
    console.warn("bingetovlc failed to start:", error);
  } catch {
    /* ignore */
  }
}
