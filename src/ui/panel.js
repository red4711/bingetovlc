/**
 * bingetovlc — the in-page panel.
 *
 * Deliberately dumb: it builds one DOM subtree, exposes callbacks, and knows
 * nothing about Emby or about how a queue is assembled. main.js owns the state
 * and decides what to fetch; the panel only reports clicks and displays results.
 *
 * Element ids are part of the test contract (see docs/SPEC.md): the end-to-end
 * test in tests/e2e drives this panel by id, so renaming one of them breaks CI
 * on purpose.
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
  width: 320px;
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: #eaeef6;
  background: rgba(18, 20, 27, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}
#${PANEL_ID}.bingetovlc-collapsed .bingetovlc-body { display: none; }
#${PANEL_ID} .bingetovlc-head {
  display: flex; align-items: center; gap: 8px;
  padding: 9px 10px; cursor: default;
  background: rgba(255, 255, 255, 0.05);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
#${PANEL_ID} .bingetovlc-title { font-weight: 600; letter-spacing: 0.01em; flex: 1; }
#${PANEL_ID} .bingetovlc-dot { width: 8px; height: 8px; border-radius: 50%; background: #7fd18a; }
#${PANEL_ID} .bingetovlc-dot.bingetovlc-dot-off { background: #6b7280; }
#${PANEL_ID} .bingetovlc-body { padding: 10px; display: flex; flex-direction: column; gap: 8px; }
#${PANEL_ID} button, #${PANEL_ID} select {
  all: unset; box-sizing: border-box; cursor: pointer;
  padding: 7px 9px; border-radius: 7px; text-align: center;
  background: rgba(255, 255, 255, 0.09); color: inherit;
  border: 1px solid rgba(255, 255, 255, 0.12);
}
#${PANEL_ID} button:hover { background: rgba(255, 255, 255, 0.16); }
#${PANEL_ID} button[disabled] { opacity: 0.45; cursor: default; }
#${PANEL_ID} button.bingetovlc-primary { background: #2f7cf6; border-color: #2f7cf6; font-weight: 600; }
#${PANEL_ID} button.bingetovlc-primary:hover { background: #1f6ae0; }
#${PANEL_ID} .bingetovlc-row { display: flex; gap: 6px; }
#${PANEL_ID} .bingetovlc-row > * { flex: 1 1 0; min-width: 0; }
#${PANEL_ID} .bingetovlc-meta { opacity: 0.75; font-size: 12px; }
#${PANEL_ID} .bingetovlc-status { min-height: 18px; font-size: 12px; }
#${PANEL_ID} .bingetovlc-status.bingetovlc-error { color: #ff9d9d; }
#${PANEL_ID} .bingetovlc-status.bingetovlc-warn { color: #ffd479; }
#${PANEL_ID} .bingetovlc-list { max-height: 150px; overflow: auto; margin: 0; padding: 0; list-style: none; font-size: 12px; }
#${PANEL_ID} .bingetovlc-list li { padding: 2px 0; opacity: 0.85; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#${PANEL_ID} .bingetovlc-options { display: none; flex-direction: column; gap: 6px; }
#${PANEL_ID}.bingetovlc-show-options .bingetovlc-options { display: flex; }
#${PANEL_ID} .bingetovlc-options label { display: flex; align-items: center; gap: 6px; font-size: 12px; opacity: 0.9; }
#${PANEL_ID} .bingetovlc-uri {
  display: none; max-height: 90px; overflow: auto; word-break: break-all;
  font: 11px/1.4 ui-monospace, "SF Mono", Menlo, monospace; opacity: 0.7;
  background: rgba(0, 0, 0, 0.3); border-radius: 6px; padding: 6px;
}
#${PANEL_ID}.bingetovlc-show-uri .bingetovlc-uri { display: block; }
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

  const dot = element(doc, "span", { className: "bingetovlc-dot bingetovlc-dot-off" });
  const title = element(doc, "span", { className: "bingetovlc-title", textContent: "bingetovlc" });
  const collapse = element(doc, "button", { textContent: "–", title: "Collapse or expand" });
  collapse.setAttribute("data-bingetovlc", "collapse");
  const head = element(doc, "div", { className: "bingetovlc-head" }, [dot, title, collapse]);

  const scope = element(doc, "select");
  scope.id = "bingetovlc-scope";
  scope.title = "What to queue";
  const queueSummary = element(doc, "div", { className: "bingetovlc-meta", textContent: "Detecting Emby session…" });
  queueSummary.id = "bingetovlc-summary";

  const play = element(doc, "button", { className: "bingetovlc-primary", textContent: "Play in VLC" });
  play.id = "bingetovlc-play";
  play.setAttribute("data-bingetovlc", "play");

  const preview = element(doc, "button", { textContent: "Preview" });
  preview.id = "bingetovlc-preview";

  const download = element(doc, "button", { textContent: "Download .m3u" });
  download.id = "bingetovlc-download";

  const options = element(doc, "button", { textContent: "Settings" });
  options.id = "bingetovlc-options-toggle";

  const status = element(doc, "div", { className: "bingetovlc-status" });
  status.id = "bingetovlc-status";

  const list = element(doc, "ul", { className: "bingetovlc-list" });
  list.id = "bingetovlc-list";

  const uri = element(doc, "div", { className: "bingetovlc-uri" });
  uri.id = "bingetovlc-uri";

  const optionRows = element(doc, "div", { className: "bingetovlc-options" });
  optionRows.id = "bingetovlc-options";

  const copyUri = element(doc, "button", { textContent: "Copy URI" });
  copyUri.id = "bingetovlc-copy-uri";
  const diag = element(doc, "button", { textContent: "Copy report" });
  diag.id = "bingetovlc-diagnostics";
  const close = element(doc, "button", { textContent: "Hide" });
  close.id = "bingetovlc-hide";

  const body = element(doc, "div", { className: "bingetovlc-body" }, [
    scope,
    queueSummary,
    element(doc, "div", { className: "bingetovlc-row" }, [play, preview]),
    element(doc, "div", { className: "bingetovlc-row" }, [download, options]),
    status,
    list,
    uri,
    optionRows,
    element(doc, "div", { className: "bingetovlc-row" }, [copyUri, diag, close]),
  ]);

  root.appendChild(head);
  root.appendChild(body);

  collapse.addEventListener("click", () => root.classList.toggle("bingetovlc-collapsed"));
  options.addEventListener("click", () => root.classList.toggle("bingetovlc-show-options"));
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
    },
    setStatus(text, kind) {
      status.textContent = text || "";
      status.className = `bingetovlc-status${kind ? ` bingetovlc-${kind}` : ""}`;
    },
    setBusy(busy) {
      play.disabled = busy;
      preview.disabled = busy;
      download.disabled = busy;
    },
    renderList(items, max = 200) {
      list.textContent = "";
      for (const item of items.slice(0, max)) {
        const line = element(doc, "li", { textContent: item.title || item.url });
        line.title = item.title || item.url;
        list.appendChild(line);
      }
      if (items.length > max) {
        list.appendChild(element(doc, "li", { textContent: `…and ${items.length - max} more` }));
      }
    },
    setUri(text) {
      uri.textContent = text || "";
    },
    addOption(label, control) {
      options.appendChild(element(doc, "label", {}, [control, element(doc, "span", { textContent: label })]));
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
  input.style.width = "64px";
  input.style.all = "unset";
  input.style.background = "rgba(255,255,255,0.09)";
  input.style.border = "1px solid rgba(255,255,255,0.12)";
  input.style.borderRadius = "5px";
  input.style.padding = "2px 5px";
  input.style.color = "inherit";
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
