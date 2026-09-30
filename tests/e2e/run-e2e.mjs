/**
 * End-to-end test: real headless Chrome + fake Emby server + the built userscript.
 *
 * There is no npm dependency here on purpose (no puppeteer/playwright): Chrome is
 * driven over the DevTools Protocol with the global fetch and WebSocket that
 * Node 22+ provides, and the browser gets a throwaway user-data-dir.
 *
 * The test is a regression guard for the one bug that matters — "the playlist
 * plays the wrong episode". For every page it asserts, independently:
 *   1. the URI handed to the shell decodes (through src/core/payload.js) to the
 *      exact episode ids, in order;
 *   2. every item URL carries the server's token and Static=true (direct play);
 *   3. the raw URI shown in the panel decodes to the same ids;
 * and globally:
 *   4. the fake server was actually asked for those very ids, so an id it never
 *      served cannot appear in the queue;
 *   5. no request URL has the server address pasted into it twice (a real bug
 *      this harness caught: buildUrl() prepended absolute URLs);
 *   6. the Virtual episode never appears in any queue.
 *
 * Run standalone:  node tests/e2e/run-e2e.mjs
 * Run via node:test: node tests/e2e/e2e.test.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import { decode, resolveItemUrl } from "../../src/core/payload.js";
import {
  FAKE_ORIGIN,
  FAKE_PORT,
  FAKE_TOKEN,
  MOVIE_ID,
  PLAYABLE_EPISODE_IDS,
  SEASON_ID,
  SERIES_ID,
  VIRTUAL_EPISODE_ID,
  startFakeEmby,
} from "./fake-emby-server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const DEBUG_PORT = 9331;
const ARTIFACTS_DIR = resolve(here, "artifacts");

const FIRST_EPISODE = PLAYABLE_EPISODE_IDS[0]; // 3101 / S01E01
const THIRD_EPISODE = PLAYABLE_EPISODE_IDS[2]; // 3103 / S01E03
const ALL_EPISODES = [...PLAYABLE_EPISODE_IDS]; // 28 playable, S01E01..S01E28
const REST_OF_SEASON = ALL_EPISODES.slice(2); // 26, S01E03..S01E28

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function findChromium() {
  const candidates = [];
  for (const envName of ["BINGETOVLC_CHROME", "CHROME_BIN", "CHROMIUM_PATH"]) {
    if (process.env[envName]) candidates.push(process.env[envName]);
  }
  candidates.push(
    "/usr/local/bin/chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  );
  for (const candidate of candidates) {
    try {
      if (candidate && existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function findUserscript() {
  const explicit = process.env.BINGETOVLC_E2E_USERSCRIPT;
  const path = explicit ? resolve(explicit) : resolve(repo, "dist/bingetovlc.user.js");
  return existsSync(path) ? path : null;
}

// ---------------------------------------------------------------------------
// Minimal DevTools Protocol client
// ---------------------------------------------------------------------------

function connectCdp(wsUrl) {
  return new Promise((resolvePromise, rejectPromise) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 0;
    const pending = new Map();
    const listeners = new Map();

    ws.addEventListener("error", () => rejectPromise(new Error("failed to open the CDP websocket")));
    ws.addEventListener("open", () => {
      resolvePromise({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = ++nextId;
            pending.set(id, { res, rej, method });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        on(method, fn) {
          listeners.set(method, [...(listeners.get(method) || []), fn]);
        },
        close: () => ws.close(),
      });
    });
    ws.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id && pending.has(message.id)) {
        const { res, rej, method } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) rej(new Error(`${method}: ${message.error.message}`));
        else res(message.result);
        return;
      }
      if (message.method) {
        for (const fn of listeners.get(message.method) || []) {
          try {
            fn(message.params);
          } catch {
            /* listener errors must not kill the socket */
          }
        }
      }
    });
  });
}

async function fetchJson(url, timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function waitForChrome(cdpPort, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no attempt yet";
  while (Date.now() < deadline) {
    try {
      const version = await fetchJson(`http://127.0.0.1:${cdpPort}/json/version`);
      if (version.webSocketDebuggerUrl) return version;
    } catch (error) {
      lastError = error.message;
    }
    await sleep(150);
  }
  throw new Error(`Chrome did not expose ${cdpPort} within ${timeoutMs}ms (last error: ${lastError})`);
}

async function firstPageTarget(cdpPort, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${cdpPort}/json/list`);
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* keep polling */
    }
    await sleep(150);
  }
  throw new Error("Chrome exposed no page target over CDP");
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => { ${expression} })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error(`page evaluation failed: ${text}`);
  }
  return result.result ? result.result.value : undefined;
}

async function waitFor(cdp, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = "not evaluated";
  while (Date.now() < deadline) {
    try {
      last = await evaluate(cdp, `return (${expression});`);
      if (last) return last;
    } catch (error) {
      last = `error: ${error.message}`;
    }
    await sleep(100);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label || expression} (last: ${JSON.stringify(last)})`);
}

/**
 * The episode ids in a payload, whichever shape it carries: v2 items carry an id
 * (and the handler builds the URL), v1 items and the generic adapter carry a full
 * URL. Both have to be understood here, because the id shape is the whole reason a
 * season queue fits inside the Windows hand-off cap.
 */
function idsFromPayload(payload) {
  return (payload.items || []).map((item) => {
    if (item.i) return String(item.i);
    const match = /\/Videos\/([^/]+)\/stream/.exec(item.u || "");
    return match ? match[1] : null;
  });
}

function uriPart(text) {
  return String(text || "").replace(/^[a-z][a-z0-9+.-]*:\/\/open\?d=/i, "");
}

const HANDOFF_HOOK = `
  window.__bingetovlcHandoffs = [];
  document.addEventListener("bingetovlc:handoff", function (event) {
    window.__bingetovlcHandoffs.push({
      uri: event.detail && event.detail.uri,
      mode: event.detail && event.detail.mode,
      payload: event.detail && event.detail.payload
    });
  });
  return true;
`;

// ---------------------------------------------------------------------------
// Scenarios — every scope the adapter offers, with the length it must produce
// for the 28-episode fixture (S01E01..S01E28 plus one Virtual episode).
// ---------------------------------------------------------------------------

const SCENARIOS = [
  { key: "episode-item", name: "episode page, default scope (this item)", itemId: THIRD_EPISODE, scope: null, expectIds: [THIRD_EPISODE] },
  { key: "episode-rest", name: "episode page, scope 'rest of season'", itemId: THIRD_EPISODE, scope: "rest-of-season", expectIds: REST_OF_SEASON },
  { key: "episode-season", name: "episode page, scope 'whole season'", itemId: THIRD_EPISODE, scope: "season", expectIds: ALL_EPISODES, expectStart: 3 },
  { key: "season", name: "season page", itemId: SEASON_ID, scope: null, expectIds: ALL_EPISODES },
  { key: "series", name: "series page", itemId: SERIES_ID, scope: null, expectIds: ALL_EPISODES },
  { key: "movie", name: "movie page", itemId: MOVIE_ID, scope: null, expectIds: [MOVIE_ID] },
  {
    // The reported failure, end to end: no ApiClient, and stored credentials whose
    // first address is dead. The panel must probe, reject it and use the other one.
    key: "season-stored-credentials",
    name: "season page with no ApiClient, credentials recovered from localStorage",
    itemId: SEASON_ID,
    scope: null,
    expectIds: ALL_EPISODES,
    query: "noclient=1",
    expectSessionSource: `localStorage:${"servercredentials3"}`,
  },
];

async function runScenario(cdp, scenario, index) {
  const pageUrl = `${FAKE_ORIGIN}/web/index.html?route=item&id=${encodeURIComponent(scenario.itemId)}&_n=${Date.now()}${index}${scenario.query ? `&${scenario.query}` : ""}`;
  await cdp.send("Page.navigate", { url: pageUrl });
  await waitFor(cdp, `document.readyState === "complete"`, 15000, "page load");
  await evaluate(cdp, HANDOFF_HOOK);

  await waitFor(cdp, `!!document.getElementById("bingetovlc-play")`, 15000, "the bingetovlc-play button");

  if (scenario.scope) {
    // The scope control is only touched when a scenario needs a non-default
    // scope; docs/SPEC.md freezes the panel/play/preview/uri ids only.
    await waitFor(cdp, `!!document.getElementById("bingetovlc-scope")`, 15000, "the bingetovlc-scope select");
    await waitFor(
      cdp,
      `Array.from(document.getElementById("bingetovlc-scope").options).some(o => o.value === ${JSON.stringify(scenario.scope)})`,
      15000,
      `the ${scenario.scope} scope option`,
    );
    await evaluate(
      cdp,
      `var s = document.getElementById("bingetovlc-scope");
       s.value = ${JSON.stringify(scenario.scope)};
       s.dispatchEvent(new Event("change", { bubbles: true }));
       return s.value;`,
    );
  }

  // Wait until the panel has rendered the queue this scenario expects and is not busy.
  await waitFor(
    cdp,
    `(document.getElementById("bingetovlc-list")?.children.length ?? -1) === ${scenario.expectIds.length} &&
     !document.getElementById("bingetovlc-play").disabled`,
    15000,
    `a rendered queue of ${scenario.expectIds.length} item(s)`,
  );

  const handoff = await evaluate(cdp, `return window.__bingetovlcHandoffs[0] || null;`);
  await evaluate(cdp, `window.__bingetovlcHandoffs.length = 0; return true;`);
  await evaluate(cdp, `document.getElementById("bingetovlc-play").click(); return true;`);
  await waitFor(cdp, `window.__bingetovlcHandoffs.length > 0`, 15000, "the bingetovlc:handoff event");

  const event = await evaluate(cdp, `return window.__bingetovlcHandoffs[0];`);
  const uriElementText = await evaluate(
    cdp,
    `var el = document.getElementById("bingetovlc-uri"); return el ? el.textContent : "";`,
  );
  const summary = await evaluate(cdp, `var el = document.getElementById("bingetovlc-summary"); return el ? el.textContent : "";`);
  const session = await evaluate(
    cdp,
    `const s = window.bingetovlc && window.bingetovlc.state ? window.bingetovlc.state.session : null;
     return s ? { source: s.source || null, server: s.server || null, probe: s.probe || null, reachable: s.reachable === true } : null;`,
  );

  const decoded = event && event.uri ? decode(uriPart(event.uri)) : null;
  const ids = decoded ? idsFromPayload(decoded) : [];
  const uriElementIds = /^[a-z][a-z0-9+.-]*:\/\/open\?d=/i.test(String(uriElementText))
    ? idsFromPayload(decode(uriPart(uriElementText)))
    : [];

  return {
    key: scenario.key,
    scenario: scenario.name,
    pageUrl,
    summary,
    sessionSource: session ? session.source : null,
    sessionServer: session ? session.server : null,
    sessionProbe: session ? session.probe : null,
    sessionReachable: session ? session.reachable : null,
    expectSessionSource: scenario.expectSessionSource ?? null,
    mode: event?.mode ?? null,
    uri: event?.uri ?? null,
    uriElementText,
    ids,
    uriElementIds,
    expectIds: scenario.expectIds,
    expectStart: scenario.expectStart ?? null,
    payload: decoded,
    _handoffBeforeClick: handoff,
  };
}

/**
 * Panel layout regression checks.
 *
 * These exist because two shipped bugs were invisible to every assertion above.
 * The settings were appended into the Settings button itself, so the disclosure
 * toggled an empty container while the button grew to 392px and stretched the
 * download button beside it. And because flex shrinking removes the automatic
 * minimum size from anything with a non-visible overflow, a 28-item queue
 * rendered as 4px-tall clipped lines: present in the DOM, absent on screen.
 *
 * Both are layout facts, so they are checked by measuring the rendered page.
 */
async function checkPanelLayout(cdp, record) {
  const pageUrl = `${FAKE_ORIGIN}/web/index.html?route=item&id=${encodeURIComponent(SEASON_ID)}&_n=${Date.now()}layout`;
  await cdp.send("Page.navigate", { url: pageUrl });
  await waitFor(cdp, `document.readyState === "complete"`, 15000, "page load");
  await evaluate(cdp, HANDOFF_HOOK);
  await waitFor(
    cdp,
    `(document.getElementById("bingetovlc-list")?.children.length ?? -1) > 1`,
    15000,
    "a multi-item queue to measure",
  );

  const shape = await evaluate(
    cdp,
    `const ids = ["bingetovlc-panel","bingetovlc-summary","bingetovlc-status","bingetovlc-list","bingetovlc-list-head",
                 "bingetovlc-play","bingetovlc-preview","bingetovlc-download","bingetovlc-uri","bingetovlc-scope",
                 "bingetovlc-options","bingetovlc-options-toggle","bingetovlc-copy-uri","bingetovlc-diagnostics","bingetovlc-hide"];
     const toggle = document.getElementById("bingetovlc-options-toggle");
     const options = document.getElementById("bingetovlc-options");
     const row = document.getElementById("bingetovlc-list").children[0];
     const summary = document.getElementById("bingetovlc-summary");
     return {
       missing: ids.filter((id) => !document.getElementById(id)),
       controlsInsideToggle: toggle.querySelectorAll("input, select").length,
       controlsInsideOptions: options.querySelectorAll("input, select").length,
       optionsHiddenInitially: options.getBoundingClientRect().height === 0,
       ariaExpandedInitially: toggle.getAttribute("aria-expanded"),
       summaryHeight: Math.round(summary.getBoundingClientRect().height),
       rowHeight: row ? Math.round(row.getBoundingClientRect().height) : 0,
       rowText: row ? row.textContent : "",
       uriLabelHidden: getComputedStyle(document.querySelector("#bingetovlc-panel .bingetovlc-uri-label")).display === "none",
     };`,
  );

  record("[layout] every contract id in SPEC §8 exists", shape.missing.length === 0, shape.missing.join(", ") || "all 15 present");
  record(
    "[layout] setting controls live in the container, not inside the disclosure button",
    shape.controlsInsideToggle === 0 && shape.controlsInsideOptions >= 5,
    `inside toggle=${shape.controlsInsideToggle}, inside container=${shape.controlsInsideOptions}`,
  );
  record(
    "[layout] the disclosure starts collapsed",
    Boolean(shape.optionsHiddenInitially) && shape.ariaExpandedInitially === "false",
    `aria-expanded=${shape.ariaExpandedInitially}`,
  );
  record(
    "[layout] a multi-item queue renders legible rows, not clipped lines",
    shape.summaryHeight > 8 && shape.rowHeight > 8,
    `summary=${shape.summaryHeight}px, first row=${shape.rowHeight}px (${shape.rowText})`,
  );
  record("[layout] the hand-off URI heading is hidden along with its block", Boolean(shape.uriLabelHidden));

  const expanded = await evaluate(
    cdp,
    `const toggle = document.getElementById("bingetovlc-options-toggle");
     toggle.click();
     const options = document.getElementById("bingetovlc-options");
     const rect = document.getElementById("bingetovlc-panel").getBoundingClientRect();
     return {
       ariaExpanded: toggle.getAttribute("aria-expanded"),
       optionsHeight: Math.round(options.getBoundingClientRect().height),
       fits: rect.top >= 0 && rect.bottom <= innerHeight,
       panelHeight: Math.round(rect.height),
       viewport: innerHeight,
     };`,
  );
  record(
    "[layout] clicking the disclosure reveals the settings",
    expanded.ariaExpanded === "true" && expanded.optionsHeight > 60,
    `aria-expanded=${expanded.ariaExpanded}, ${expanded.optionsHeight}px`,
  );
  record(
    "[layout] the panel stays fully on screen with the settings open",
    Boolean(expanded.fits),
    `panel ${expanded.panelHeight}px in a ${expanded.viewport}px viewport`,
  );

  const collapsed = await evaluate(
    cdp,
    `document.querySelector("#bingetovlc-panel .bingetovlc-collapse").click();
     const body = getComputedStyle(document.querySelector("#bingetovlc-panel .bingetovlc-body")).display;
     return { body, height: Math.round(document.getElementById("bingetovlc-panel").getBoundingClientRect().height) };`,
  );
  record(
    "[layout] collapsing leaves just the header",
    collapsed.body === "none" && collapsed.height < 80,
    `body=${collapsed.body}, ${collapsed.height}px tall`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runE2e({ quiet = false } = {}) {
  const chromium = findChromium();
  if (!chromium) {
    return { skipped: true, reason: "no Chromium/Chrome binary found (set BINGETOVLC_CHROME to override)" };
  }
  const userscriptPath = findUserscript();
  if (!userscriptPath) {
    return { skipped: true, reason: "dist/bingetovlc.user.js is missing — run python3 tools/build.py first" };
  }

  const assertions = [];
  const record = (name, ok, detail = "") => {
    assertions.push({ name, ok: Boolean(ok), detail });
    if (!quiet) console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };

  const profileDir = mkdtempSync(join(tmpdir(), "bingetovlc-e2e-chrome-"));
  let chrome;
  let server;
  let cdp = null;
  const pages = [];
  const consoleErrors = [];

  try {
    server = await startFakeEmby({ port: FAKE_PORT, userscriptPath });

    chrome = spawn(
      chromium,
      [
        "--headless=new",
        `--remote-debugging-port=${DEBUG_PORT}`,
        `--user-data-dir=${profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-sandbox",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--mute-audio",
        "--remote-allow-origins=*",
        "about:blank",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let chromeStderr = "";
    chrome.stderr.on("data", (chunk) => {
      chromeStderr = (chromeStderr + chunk.toString()).slice(-4000);
    });
    chrome.on("error", (error) => {
      chromeStderr += `\nspawn error: ${error.message}`;
    });

    try {
      await waitForChrome(DEBUG_PORT, 20000);
    } catch (error) {
      throw new Error(`${error.message}\nChrome stderr tail:\n${chromeStderr}`);
    }

    const target = await firstPageTarget(DEBUG_PORT, 10000);
    cdp = await connectCdp(target.webSocketDebuggerUrl);
    cdp.on("Runtime.exceptionThrown", (params) => {
      consoleErrors.push(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || "exception");
    });
    cdp.on("Runtime.consoleAPICalled", (params) => {
      if (params.type === "error") {
        consoleErrors.push((params.args || []).map((a) => a.description || a.value).join(" "));
      }
    });
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Log.enable");

    for (const [index, scenario] of SCENARIOS.entries()) {
      let result;
      try {
        result = await runScenario(cdp, scenario, index);
      } catch (error) {
        // One broken scenario must not hide the rest: record it as a failure
        // and carry on, so the output says which page misbehaved.
        record(`[${scenario.key}] scenario ran to completion`, false, String(error.message).slice(0, 300));
        pages.push({
          key: scenario.key,
          scenario: scenario.name,
          error: error.message,
          ids: [],
          uriElementIds: [],
          expectIds: scenario.expectIds,
          expectStart: scenario.expectStart ?? null,
          payload: null,
        });
        continue;
      }
      pages.push(result);
      const { ids, expectIds, uriElementIds, payload } = result;

      record(
        `[${result.key}] URI decodes to exactly the expected ids, in order`,
        JSON.stringify(ids) === JSON.stringify(expectIds),
        `got ${ids.length} [${ids.slice(0, 4).join(",")}${ids.length > 4 ? ",…" : ""}], expected ${expectIds.length}`,
      );

      record(
        `[${result.key}] the raw URI in #bingetovlc-uri decodes to the same ids`,
        JSON.stringify(uriElementIds) === JSON.stringify(ids),
        `panel decoded ${uriElementIds.length} id(s)`,
      );

      const items = payload?.items || [];
      const resolved = items.map((item) => resolveItemUrl(payload, item));
      record(
        `[${result.key}] every item resolves to a direct-play URL with the token and Static=true`,
        resolved.length > 0 &&
          resolved.every((url) => url.includes(`api_key=${FAKE_TOKEN}`) && /[?&]Static=true(&|$)/i.test(url)),
        resolved.length ? `${resolved.length} item(s), e.g. ${resolved[0]}` : "no items",
      );
      record(
        `[${result.key}] the URI carries ids, not stream URLs (the ~2 KB Windows cap)`,
        items.length > 0 && items.every((item) => item.i && !item.u) && payload?.token === FAKE_TOKEN,
        `payload v${payload?.v}, ${items.length} item(s), ${result.uri?.length ?? 0} byte URI`,
      );
      record(
        `[${result.key}] the hand-off URI fits the Windows ShellExecute cap`,
        (result.uri?.length ?? 0) < 2046,
        `${result.uri?.length ?? 0} bytes (cap ~2046)`,
      );

      if (result.expectSessionSource) {
        // The reported bug: a session recovered from storage, whose first stored
        // address cannot be reached. Both the recovery and the rejection matter.
        record(
          `[${result.key}] the session was recovered from ${result.expectSessionSource} and settled on an address that answers`,
          result.sessionSource === result.expectSessionSource && result.sessionReachable === true,
          `source=${result.sessionSource}, address=${result.sessionServer}`,
        );
        record(
          `[${result.key}] the address in use is the one the reachability probe confirmed`,
          typeof result.sessionProbe === "string" && result.sessionProbe.startsWith(String(result.sessionServer)),
          `address check: ${result.sessionProbe}`,
        );
      }

      if (result.expectStart !== null) {
        record(
          `[${result.key}] payload opts.start is the 1-based index of the episode started from`,
          payload?.opts?.start === result.expectStart,
          `opts.start = ${payload?.opts?.start} (expected ${result.expectStart})`,
        );
      }
    }

    // Panel layout, measured on the rendered page: no DOM-level assertion above
    // can see a control that is present but rendered 4px tall and clipped.
    try {
      await checkPanelLayout(cdp, record);
    } catch (error) {
      record("[layout] panel layout checks ran", false, String(error.message).slice(0, 200));
    }

    const byKey = Object.fromEntries(pages.map((page) => [page.key, page]));

    // Ordering: the second item is the next episode in season order.
    record(
      "[season] the second item is the next episode in season order",
      byKey.season.ids[0] === FIRST_EPISODE && byKey.season.ids[1] === PLAYABLE_EPISODE_IDS[1],
      `first two ids: ${byKey.season.ids.slice(0, 2).join(",")}`,
    );

    // Rest-of-season starts at the viewed episode and runs to the end.
    record(
      "[episode-rest] starts at the viewed episode and runs to the end of the season",
      byKey["episode-rest"].ids[0] === THIRD_EPISODE &&
        byKey["episode-rest"].ids.at(-1) === ALL_EPISODES.at(-1) &&
        byKey["episode-rest"].ids.length === ALL_EPISODES.length - 2,
      `first ${byKey["episode-rest"].ids[0]}, last ${byKey["episode-rest"].ids.at(-1)}, length ${byKey["episode-rest"].ids.length}`,
    );

    // A movie page queues exactly one item.
    record("[movie] exactly one item is queued", byKey.movie.ids.length === 1 && byKey.movie.ids[0] === MOVIE_ID, `got [${byKey.movie.ids.join(",")}]`);

    // The Virtual episode is excluded from every container queue, and the queue
    // length equals the playable episode count.
    const containerKeys = ["episode-rest", "episode-season", "season", "series"];
    const noVirtual = containerKeys.every((key) => !byKey[key].ids.includes(VIRTUAL_EPISODE_ID));
    const seasonLengthOk = byKey.season.ids.length === PLAYABLE_EPISODE_IDS.length;
    record(
      "[season] the Virtual episode is excluded and the queue length equals the playable count",
      noVirtual && seasonLengthOk,
      `season length ${byKey.season.ids.length}, playable ${PLAYABLE_EPISODE_IDS.length}, Virtual present: ${!noVirtual}`,
    );

    // Server-side provenance: every id in a playlist was actually served.
    const playlistIds = [...new Set(pages.flatMap((page) => page.ids))];
    const servedIds = server.state.servedItemIds;
    const unserved = playlistIds.filter((id) => !servedIds.has(id));
    record(
      "the fake server served every id the playlists claim",
      unserved.length === 0,
      unserved.length ? `never served: ${unserved.join(",")}` : `${playlistIds.length} distinct ids verified`,
    );
    record(
      "the Virtual episode id never appeared in any playlist",
      !playlistIds.includes(VIRTUAL_EPISODE_ID),
      `playlist ids include 3199: ${playlistIds.includes(VIRTUAL_EPISODE_ID)}`,
    );

    // The buildUrl double-prefix regression: no request target may contain the
    // server address inside it, or the origin twice.
    const doubled = server.state.requestTargets.filter(
      (target) => target.includes("://") || (target.match(/127\.0\.0\.1:8731/g) || []).length > 0,
    );
    record(
      "no request URL has the server address pasted into it twice",
      doubled.length === 0,
      doubled.length ? `${doubled.length} bad target(s), e.g. ${doubled[0].slice(0, 120)}` : `${server.state.requestTargets.length} request targets clean`,
    );
    record(
      "the season/series child listing endpoints were actually used",
      server.state.requests.some((r) => r.includes("/Shows/")),
      server.state.requests.filter((r) => r.includes("/Shows/")).length + " /Shows/ request(s)",
    );

    record(
      "the server only streamed ids that are in a playlist",
      server.state.streamedIds.every((id) => playlistIds.includes(id)),
      `streamed: [${server.state.streamedIds.join(",")}]`,
    );
    record("no unauthenticated stream was attempted", server.state.unauthorizedStreams === 0, `${server.state.unauthorizedStreams} 401(s)`);

    if (consoleErrors.length) {
      record("the page produced no console errors", false, consoleErrors.join(" | ").slice(0, 400));
    } else {
      record("the page produced no console errors", true);
    }

    return {
      skipped: false,
      assertions,
      failures: assertions.filter((a) => !a.ok),
      pages,
      consoleErrors,
      server: { ...server.state, servedItemIds: [...server.state.servedItemIds] },
    };
  } finally {
    // Close everything explicitly: an open WebSocket or a keep-alive socket to
    // the fake server keeps the event loop alive, which would turn a test
    // failure into a hung CI job.
    try {
      if (cdp) cdp.close();
    } catch {
      /* ignore */
    }
    try {
      if (chrome && !chrome.killed) chrome.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    if (server) {
      try {
        await server.close();
      } catch {
        /* ignore */
      }
    }
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export function writeArtifacts(result) {
  try {
    mkdirSync(ARTIFACTS_DIR, { recursive: true });
    const path = join(ARTIFACTS_DIR, "e2e-capture.json");
    writeFileSync(path, JSON.stringify({ capturedAt: new Date().toISOString(), ...result }, null, 2) + "\n", "utf8");
    return path;
  } catch {
    return null;
  }
}

async function main() {
  const result = await runE2e();
  if (result.skipped) {
    console.log(`SKIP: ${result.reason}`);
    process.exitCode = 0;
    return;
  }
  writeArtifacts(result);
  if (result.failures.length) {
    console.log(`\nFAIL: ${result.failures.length} of ${result.assertions.length} assertions failed`);
    process.exitCode = 1;
  } else {
    console.log(`\nPASS: ${result.assertions.length} assertions`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`e2e crashed: ${error.message}`);
    process.exitCode = 1;
  });
}