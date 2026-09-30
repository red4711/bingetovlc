/**
 * bingetovlc — the in-page panel.
 *
 * Deliberately dumb: it builds one DOM subtree, exposes callbacks, and knows
 * nothing about Emby or about how a queue is assembled. main.js owns the state
 * and decides what to fetch; the panel only reports clicks and displays results.
 *
 * Element ids are part of the test contract (see docs/SPEC.md §8): the end-to-end
 * test in tests/e2e drives this panel by id, so renaming one of them breaks CI
 * on purpose.
 *
 * Layout rules worth keeping:
 *   - The panel never exceeds the viewport. It is capped and its body scrolls,
 *     because a panel that grows off the top of the screen hides its own header
 *     (and the first thing a tall queue does is grow).
 *   - Only the primary action is full width. Action rows are flex rows of
 *     buttons, so nothing stretches to the height of a neighbour: a row that
 *     contained a tall element used to stretch the button beside it into a
 *     390px empty slab.
 *   - `#bingetovlc-uri` contains the URI and nothing else: the end-to-end test
 *     anchor-matches its text against the scheme, so headings go in siblings.
 *
 * Styling is injected as a single stylesheet keyed off the panel id, uses no
 * framework, and stays out of the page's way: fixed position, high z-index,
 * `all: initial` on the root so an Emby theme cannot bleed into the controls.
 */

export const PANEL_ID = "bingetovlc-panel";
export const STYLE_ID = "bingetovlc-style";

// Named with a prefix because tools/build.py flattens every module into one
// scope, and two modules both declaring `STYLE` would be a build error.
const PANEL_STYLE = `
#${PANEL_ID} {
  all: initial;
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483000;
  box-sizing: border-box;
  width: 340px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 32px);
  display: flex;
  flex-direction: column;
  /* Native popups (the scope and scheme dropdowns) follow the theme. */
  color-scheme: dark;

  --btv-text: #e9edf5;
  --btv-muted: rgba(233, 237, 245, 0.62);
  --btv-line: rgba(255, 255, 255, 0.10);
  --btv-fill: rgba(255, 255, 255, 0.06);
  --btv-fill-hover: rgba(255, 255, 255, 0.12);
  --btv-accent: #2f7cf6;
  --btv-accent-hover: #1f6ae0;
  --btv-ok: #6ee7a0;
  --btv-warn: #ffc857;
  --btv-error: #ff9d9d;

  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--btv-text);
  background: #14161d;
  border: 1px solid rgba(255, 255, 255, 0.13);
  border-radius: 12px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.5), 0 2px 10px rgba(0, 0, 0, 0.35);
  overflow: hidden;
}
#${PANEL_ID}.bingetovlc-collapsed .bingetovlc-body { display: none; }
/* Collapsing means a pill: the footer actions belong to the open panel. */
#${PANEL_ID}.bingetovlc-collapsed .bingetovlc-foot { display: none; }

/* ---------------------------------------------------------------- header -- */
#${PANEL_ID} .bingetovlc-head {
  display: flex;
  align-items: center;
  gap: 9px;
  flex: 0 0 auto;
  padding: 9px 8px 9px 12px;
  background: rgba(255, 255, 255, 0.035);
  border-bottom: 1px solid var(--btv-line);
}
#${PANEL_ID} .bingetovlc-dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--btv-ok);
  box-shadow: 0 0 0 3px rgba(110, 231, 160, 0.16);
}
#${PANEL_ID} .bingetovlc-dot-off { background: #64748b; box-shadow: none; }
#${PANEL_ID} .bingetovlc-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* --------------------------------------------------------------- controls -- */
#${PANEL_ID} button,
#${PANEL_ID} select {
  all: unset;
  box-sizing: border-box;
  cursor: pointer;
  font: inherit;
  color: inherit;
  padding: 8px 10px;
  border-radius: 8px;
  text-align: center;
  background: var(--btv-fill);
  border: 1px solid var(--btv-line);
  transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
}
#${PANEL_ID} button:hover:not([disabled]),
#${PANEL_ID} select:hover { background: var(--btv-fill-hover); }
#${PANEL_ID} button[disabled] { opacity: 0.42; cursor: default; }
#${PANEL_ID} button.bingetovlc-primary {
  padding: 10px;
  color: #fff;
  font-weight: 600;
  background: var(--btv-accent);
  border-color: transparent;
}
#${PANEL_ID} button.bingetovlc-primary:hover:not([disabled]) { background: var(--btv-accent-hover); }
/* The all:unset reset removes the dropdown arrow, so it is drawn back on. */
#${PANEL_ID} select {
  appearance: none;
  padding-right: 26px;
  text-align: left;
  background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath fill='%23b9c2d4' d='M0 0h10L5 6z'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 8px center;
  background-size: 9px 6px;
}
#${PANEL_ID} input[type="number"],
#${PANEL_ID} input[type="text"] {
  all: unset;
  box-sizing: border-box;
  font: inherit;
  color: inherit;
  width: 84px;
  padding: 6px 8px;
  border-radius: 7px;
  text-align: right;
  background: rgba(0, 0, 0, 0.28);
  border: 1px solid var(--btv-line);
}
#${PANEL_ID} input[type="checkbox"] {
  flex: 0 0 auto;
  width: 15px;
  height: 15px;
  margin: 0;
  accent-color: var(--btv-accent);
  cursor: pointer;
}
#${PANEL_ID} :focus-visible { outline: 2px solid var(--btv-accent); outline-offset: 1px; }

/* ------------------------------------------------------------------ body -- */
#${PANEL_ID} .bingetovlc-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 1 1 auto;
  min-height: 0;
  padding: 12px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
/*
 * Every row keeps its natural height and the body scrolls instead. Without this,
 * flex shrinking collapses anything that sets overflow:hidden (the clamped
 * summary, the ellipsised queue rows) because a non-visible overflow removes the
 * automatic minimum size: a 28-item queue rendered as 4px-tall clipped lines.
 */
#${PANEL_ID} .bingetovlc-body > * { flex: 0 0 auto; }
/* The queue is the one row allowed to give up space, down to a usable minimum. */
#${PANEL_ID} .bingetovlc-body > .bingetovlc-list { flex: 0 1 auto; min-height: 54px; }
#${PANEL_ID} .bingetovlc-label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--btv-muted);
}
#${PANEL_ID} .bingetovlc-meta {
  font-size: 12px;
  color: var(--btv-muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
#${PANEL_ID} .bingetovlc-row { display: flex; gap: 8px; }
#${PANEL_ID} .bingetovlc-row > button { flex: 1 1 0; min-width: 0; }

/* --------------------------------------------------------------- settings -- */
#${PANEL_ID} .bingetovlc-disclosure {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  color: var(--btv-muted);
  font-size: 12.5px;
}
#${PANEL_ID} .bingetovlc-disclosure:hover { color: var(--btv-text); }
#${PANEL_ID} .bingetovlc-chevron {
  flex: 0 0 auto;
  display: inline-block;
  transition: transform 140ms ease;
  font-size: 10px;
}
#${PANEL_ID}.bingetovlc-show-options .bingetovlc-chevron { transform: rotate(90deg); }
#${PANEL_ID} .bingetovlc-options {
  display: none;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--btv-line);
  border-radius: 9px;
  background: rgba(0, 0, 0, 0.24);
}
#${PANEL_ID}.bingetovlc-show-options .bingetovlc-options { display: flex; }
#${PANEL_ID} .bingetovlc-group + .bingetovlc-group {
  margin-top: 9px;
  padding-top: 9px;
  border-top: 1px solid var(--btv-line);
}
#${PANEL_ID} .bingetovlc-group-title {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--btv-muted);
  margin-bottom: 4px;
}
#${PANEL_ID} .bingetovlc-check {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 3px 0;
  font-size: 12.5px;
  cursor: pointer;
}
#${PANEL_ID} .bingetovlc-check input { margin-top: 2px; }
#${PANEL_ID} .bingetovlc-check-text { flex: 1 1 auto; min-width: 0; }
#${PANEL_ID} .bingetovlc-field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 0;
  font-size: 12.5px;
}
#${PANEL_ID} .bingetovlc-field > .bingetovlc-check-text { flex: 0 1 auto; }

/* ------------------------------------------------------- status and queue -- */
#${PANEL_ID} .bingetovlc-status { font-size: 12px; color: var(--btv-muted); }
#${PANEL_ID} .bingetovlc-status:empty { display: none; }
#${PANEL_ID} .bingetovlc-status.bingetovlc-error { color: var(--btv-error); }
#${PANEL_ID} .bingetovlc-status.bingetovlc-warn { color: var(--btv-warn); }
#${PANEL_ID} .bingetovlc-list-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--btv-muted);
}
#${PANEL_ID} .bingetovlc-list-head:empty { display: none; }
#${PANEL_ID} .bingetovlc-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 0;
  padding: 0;
  max-height: 132px;
  overflow: auto;
  overscroll-behavior: contain;
  list-style: none;
  font-size: 12px;
}
#${PANEL_ID} .bingetovlc-list:empty { display: none; }
#${PANEL_ID} .bingetovlc-list li {
  flex: 0 0 auto;
  padding: 2px 0;
  color: rgba(233, 237, 245, 0.86);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
#${PANEL_ID} .bingetovlc-uri {
  display: none;
  max-height: 96px;
  overflow: auto;
  word-break: break-all;
  font: 11px/1.45 ui-monospace, "SF Mono", Menlo, monospace;
  color: var(--btv-muted);
  padding: 7px 8px;
  border-radius: 7px;
  background: rgba(0, 0, 0, 0.32);
  border: 1px solid var(--btv-line);
}
#${PANEL_ID}.bingetovlc-show-uri .bingetovlc-uri { display: block; }
/* The heading travels with the block it names, so an empty "Handoff URI" label
   never sits above nothing. */
#${PANEL_ID} .bingetovlc-uri-label { display: none; }
#${PANEL_ID}.bingetovlc-show-uri .bingetovlc-uri-label { display: block; }

/* ---------------------------------------------------------------- footer -- */
#${PANEL_ID} .bingetovlc-foot {
  display: flex;
  gap: 6px;
  flex: 0 0 auto;
  padding: 10px 12px;
  border-top: 1px solid var(--btv-line);
  background: rgba(255, 255, 255, 0.02);
}
#${PANEL_ID} .bingetovlc-foot > button {
  flex: 1 1 0;
  min-width: 0;
  padding: 6px 8px;
  font-size: 11.5px;
  color: var(--btv-muted);
  background: transparent;
  border-color: transparent;
}
#${PANEL_ID} .bingetovlc-foot > button:hover { color: var(--btv-text); background: var(--btv-fill); }
`;

export function ensureStyles(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = PANEL_STYLE;
  doc.head.appendChild(style);
}

function element(doc, tag, props = {}, children = []) {
  const node = doc.createElement(tag);
  Object.assign(node, props);
  for (const child of [].concat(children)) if (child) node.appendChild(child);
  return node;
}

const checkboxRowClasses = (control) => (control && control.type === "checkbox" ? "bingetovlc-check" : "bingetovlc-field");

/**
 * Create the panel.
 *
 * @param {Document} doc
 * @param {object} handlers  callbacks: onPlay, onPreview, onDownload, onCopyUri,
 *                           onDiagnostics, onScopeChange, onSettingChange
 */
export function createPanel(doc, handlers = {}) {
  const root = element(doc, "div");
  root.id = PANEL_ID;
  root.setAttribute("data-bingetovlc", "panel");
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "bingetovlc");

  const dot = element(doc, "span", { className: "bingetovlc-dot bingetovlc-dot-off" });
  dot.setAttribute("title", "Waiting for an Emby session");
  const title = element(doc, "span", { className: "bingetovlc-title", textContent: "bingetovlc" });
  const collapse = element(doc, "button", { className: "bingetovlc-collapse", textContent: "\u2013" });
  collapse.setAttribute("data-bingetovlc", "collapse");
  collapse.setAttribute("title", "Collapse or expand");
  collapse.setAttribute("aria-label", "Collapse or expand");
  const head = element(doc, "div", { className: "bingetovlc-head" }, [dot, title, collapse]);

  const scopeLabel = element(doc, "div", { className: "bingetovlc-label", textContent: "Queue" });
  const scope = element(doc, "select");
  scope.id = "bingetovlc-scope";
  scope.setAttribute("title", "What to queue");
  scope.setAttribute("aria-label", "What to queue");

  const queueSummary = element(doc, "div", { className: "bingetovlc-meta", textContent: "Detecting Emby session…" });
  queueSummary.id = "bingetovlc-summary";

  const play = element(doc, "button", { className: "bingetovlc-primary" });
  play.id = "bingetovlc-play";
  play.setAttribute("data-bingetovlc", "play");
  play.appendChild(element(doc, "span", { textContent: "▶  " }));
  play.appendChild(element(doc, "span", { textContent: "Play in VLC" }));

  const preview = element(doc, "button", { textContent: "Preview" });
  preview.id = "bingetovlc-preview";
  preview.setAttribute("title", "Build the queue and show the URI without launching anything");

  const download = element(doc, "button", { textContent: "Download .m3u" });
  download.id = "bingetovlc-download";
  download.setAttribute("title", "Save the queue as a playlist file, then open it with VLC");

  // The disclosure is a button, and the settings live in the container it
  // controls. They used to be the same variable, so the controls were appended
  // into the button itself: it grew to fit them, stretched its row, and the
  // toggle then showed and hid an element that was always empty.
  const optionsToggle = element(doc, "button", { className: "bingetovlc-disclosure" });
  optionsToggle.id = "bingetovlc-options-toggle";
  optionsToggle.setAttribute("aria-expanded", "false");
  optionsToggle.setAttribute("aria-controls", "bingetovlc-options");
  optionsToggle.appendChild(element(doc, "span", { className: "bingetovlc-chevron", textContent: "▶" }));
  optionsToggle.appendChild(element(doc, "span", { className: "bingetovlc-check-text", textContent: "Settings" }));

  const status = element(doc, "div", { className: "bingetovlc-status" });
  status.id = "bingetovlc-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  const listHead = element(doc, "div", { className: "bingetovlc-list-head" });
  listHead.id = "bingetovlc-list-head";

  const list = element(doc, "ul", { className: "bingetovlc-list" });
  list.id = "bingetovlc-list";

  const uriLabel = element(doc, "div", { className: "bingetovlc-label bingetovlc-uri-label", textContent: "Handoff URI" });
  const uri = element(doc, "div", { className: "bingetovlc-uri" });
  uri.id = "bingetovlc-uri";

  const optionRows = element(doc, "div", { className: "bingetovlc-options" });
  optionRows.id = "bingetovlc-options";
  optionRows.setAttribute("role", "group");
  optionRows.setAttribute("aria-label", "Settings");

  const copyUri = element(doc, "button", { textContent: "Copy URI" });
  copyUri.id = "bingetovlc-copy-uri";
  const diag = element(doc, "button", { textContent: "Copy report" });
  diag.id = "bingetovlc-diagnostics";
  const close = element(doc, "button", { textContent: "Hide" });
  close.id = "bingetovlc-hide";
  const foot = element(doc, "div", { className: "bingetovlc-foot" }, [copyUri, diag, close]);

  const body = element(doc, "div", { className: "bingetovlc-body" }, [
    scopeLabel,
    scope,
    queueSummary,
    play,
    element(doc, "div", { className: "bingetovlc-row" }, [preview, download]),
    optionsToggle,
    optionRows,
    status,
    listHead,
    list,
    uriLabel,
    uri,
  ]);

  root.appendChild(head);
  root.appendChild(body);
  root.appendChild(foot);

  const setOptionsOpen = (open) => {
    root.classList.toggle("bingetovlc-show-options", open);
    optionsToggle.setAttribute("aria-expanded", open ? "true" : "false");
  };

  collapse.addEventListener("click", () => root.classList.toggle("bingetovlc-collapsed"));
  optionsToggle.addEventListener("click", () => setOptionsOpen(!root.classList.contains("bingetovlc-show-options")));
  close.addEventListener("click", () => root.remove());
  play.addEventListener("click", () => handlers.onPlay && handlers.onPlay());
  preview.addEventListener("click", () => {
    root.classList.add("bingetovlc-show-uri");
    handlers.onPreview && handlers.onPreview();
  });
  download.addEventListener("click", () => handlers.onDownload && handlers.onDownload());
  copyUri.addEventListener("click", () => handlers.onCopyUri && handlers.onCopyUri());
  diag.addEventListener("click", () => handlers.onDiagnostics && handlers.onDiagnostics());
  scope.addEventListener("change", () => handlers.onScopeChange && handlers.onScopeChange(scope.value));

  // Settings are grouped by what they affect, created on first use so a group
  // heading never appears above nothing.
  const groups = new Map();
  const groupBody = (name) => {
    if (groups.has(name)) return groups.get(name);
    const body = element(doc, "div", { className: "bingetovlc-group-body" });
    const group = element(doc, "div", { className: "bingetovlc-group" }, [
      element(doc, "div", { className: "bingetovlc-group-title", textContent: name }),
      body,
    ]);
    optionRows.appendChild(group);
    groups.set(name, body);
    return body;
  };

  return {
    root,
    scope,
    summary: queueSummary,
    status,
    list,
    uri,
    options: optionRows,
    dot,
    setScopes(scopes, selected) {
      scope.textContent = "";
      const LABELS = {
        item: "This item",
        "rest-of-season": "From here to end of season",
        season: "Whole season",
        series: "Whole show (all seasons)",
      };
      for (const value of scopes) {
        const option = element(doc, "option", { value, textContent: LABELS[value] || value });
        if (value === selected) option.selected = true;
        scope.appendChild(option);
      }
      scope.disabled = scopes.length <= 1;
    },
    setSummary(text, connected) {
      queueSummary.textContent = text;
      dot.className = `bingetovlc-dot${connected ? "" : " bingetovlc-dot-off"}`;
      dot.setAttribute("title", connected ? "Signed in to Emby" : "No Emby session yet");
    },
    setStatus(text, kind) {
      status.textContent = text || "";
      status.className = `bingetovlc-status${kind ? ` bingetovlc-${kind}` : ""}`;
    },
    setBusy(busy) {
      play.disabled = busy;
      preview.disabled = busy;
      download.disabled = busy;
      root.classList.toggle("bingetovlc-busy", Boolean(busy));
    },
    renderList(items, max = 200) {
      list.textContent = "";
      const entries = items || [];
      listHead.textContent = "";
      if (entries.length) {
        listHead.appendChild(element(doc, "span", { textContent: "Queue" }));
        listHead.appendChild(
          element(doc, "span", { textContent: `${entries.length} item${entries.length === 1 ? "" : "s"}` }),
        );
      }
      for (const item of entries.slice(0, max)) {
        const line = element(doc, "li", { textContent: item.title || item.url });
        line.setAttribute("title", item.title || item.url);
        list.appendChild(line);
      }
      if (entries.length > max) {
        list.appendChild(element(doc, "li", { textContent: `…and ${entries.length - max} more` }));
      }
    },
    setUri(text) {
      uri.textContent = text || "";
    },
    /**
     * Add one setting. `group` is the heading it belongs under; controls render
     * with the box first (checkboxes) or the value on the right (fields), so a
     * narrow panel wraps the label rather than squashing the control.
     */
    addOption(label, control, { group = "Options" } = {}) {
      const row = element(doc, "label", { className: checkboxRowClasses(control) });
      const text = element(doc, "span", { className: "bingetovlc-check-text", textContent: label });
      if (checkboxRowClasses(control) === "bingetovlc-check") row.appendChild(control);
      row.appendChild(text);
      if (checkboxRowClasses(control) !== "bingetovlc-check") row.appendChild(control);
      groupBody(group).appendChild(row);
      return row;
    },
  };
}

export function checkbox(doc, id, checked) {
  const input = element(doc, "input", { type: "checkbox", checked });
  input.id = id;
  return input;
}

export function numberInput(doc, id, value, { min = 0, max = 100000 } = {}) {
  const input = element(doc, "input", { type: "number", value: String(value), min: String(min), max: String(max) });
  input.id = id;
  return input;
}

export function selectInput(doc, id, values, selected) {
  const select = element(doc, "select");
  select.id = id;
  for (const value of values) {
    const option = element(doc, "option", { value: value.value, textContent: value.label });
    if (value.value === selected) option.selected = true;
    select.appendChild(option);
  }
  return select;
}
