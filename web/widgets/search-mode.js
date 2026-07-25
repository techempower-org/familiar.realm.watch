// Search-mode block — retrieval-strategy picker for familiar's palace search.
//
// Lets the user choose HOW the familiar searches the palace before it speaks:
//   vector     — pure embedding similarity (fastest, baseline)
//   hybrid     — vector + BM25 + graph rerank (the server default)
//   age-fused  — vector + AGE knowledge-graph walk, RRF-merged (surfaces
//                graph-connected memories; falls back to hybrid/vector if
//                the postgres/AGE backend isn't available)
//
// Two parts, kept deliberately separate:
//   1. A DOM-free STATE MODULE published as `window.familiarSearchMode` —
//      get/set/subscribe/modes. The chat-send path in app.js reads `.get()`
//      and attaches `chatBody.search_mode` exactly like the model override.
//   2. A dashboard BLOCK that renders against that state (mirrors the
//      slot-picker block contract: registerBlockType + render/renderSettings
//      + defaultRect). The block subscribes to the state so picks made in
//      another tab (cross-tab via the `storage` event) reflect live.
//
// Bonus "dynamic" surface: app.js forwards the trace SSE `retrieval` object
// (n_vector / n_graph / n_after_fusion / fell_back_to) into the state module
// via `_ingestRetrieval(...)`. The block shows a live "N vector · N graph · N
// fused" readout per turn so the user SEES the AGE graph contribution.
//
// Backend contract (issue #88): POST /v1/chat/completions accepts an optional
// `search_mode` field. Omitting it (or an unknown value) → server default.
// Harmless if the backend isn't wired yet (unknown body fields are ignored).

import { dashboard } from "../dashboard.js";
import { sound } from "./sound.js";

const STORAGE_KEY = "familiar_search_mode";
const VALID = ["vector", "hybrid", "age-fused"];

// Mode metadata table (the CONTRACT.md table). Order here is the render order.
const MODES = [
  {
    id: "vector",
    label: "Vector",
    glyph: "◈",
    tagline: "pure similarity",
    description:
      "Pure embedding similarity. Fastest, baseline — finds memories that read like your words.",
    endpoint: "GET /search",
  },
  {
    id: "hybrid",
    label: "Hybrid",
    glyph: "✶",
    tagline: "balanced default",
    description:
      "Vector + BM25 keyword + graph rerank. The current server default — broad recall with keyword precision.",
    endpoint: "POST /search/hybrid",
    isDefault: true,
  },
  {
    id: "age-fused",
    label: "Graph-Fused",
    glyph: "✧",
    tagline: "walks the graph",
    description:
      "Vector + AGE knowledge-graph walk, RRF-merged. Surfaces graph-connected memories the others miss. Needs the postgres backend; degrades to hybrid/vector automatically.",
    endpoint: "POST /search/age-fused",
  },
];

// ---------------------------------------------------------------------------
// State module — DOM-free. Published on window so app.js + the block share it.
// ---------------------------------------------------------------------------

let current = readPref();
let lastRetrieval = null;            // most recent trace `retrieval` object
const subscribers = new Set();

function readPref() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return VALID.includes(v) ? v : null;
  } catch {
    return null;
  }
}
function writePref(mode) {
  try {
    if (mode && VALID.includes(mode)) localStorage.setItem(STORAGE_KEY, mode);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* quota — non-fatal, in-memory value still drives this session */
  }
}

function notify() {
  for (const fn of subscribers) {
    try {
      fn({ mode: current, retrieval: lastRetrieval });
    } catch (err) {
      console.error("[search-mode] subscriber threw:", err);
    }
  }
}

const api = {
  /** Current selected mode, or null = use the server default. */
  get() {
    return current;
  },
  /**
   * Persist + broadcast a mode. `null` (or an invalid value) clears the
   * override so the server falls back to its default.
   */
  set(mode) {
    const next = VALID.includes(mode) ? mode : null;
    if (next === current) return;
    current = next;
    writePref(next);
    notify();
  },
  /** Subscribe to changes; returns an unsubscribe fn. Fires immediately. */
  subscribe(fn) {
    if (typeof fn !== "function") return () => {};
    subscribers.add(fn);
    try {
      fn({ mode: current, retrieval: lastRetrieval });
    } catch (err) {
      console.error("[search-mode] subscriber threw on attach:", err);
    }
    return () => subscribers.delete(fn);
  },
  /** Metadata table (label / description / endpoint per mode). */
  modes() {
    return MODES.map((m) => ({ ...m }));
  },
  /** Most recent retrieval readout (or null). */
  retrieval() {
    return lastRetrieval;
  },
  /**
   * Internal: app.js forwards the trace SSE `retrieval` object here so the
   * block can show the live graph-contribution readout. Not part of the
   * documented public API — underscore-prefixed.
   */
  _ingestRetrieval(retrieval) {
    if (!retrieval || typeof retrieval !== "object") return;
    lastRetrieval = retrieval;
    notify();
  },
};

if (typeof window !== "undefined") {
  window.familiarSearchMode = api;
  // Cross-tab sync — another tab's pick updates this one's state + block.
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    const next = VALID.includes(e.newValue) ? e.newValue : null;
    if (next === current) return;
    current = next;
    notify();
  });
}

// ---------------------------------------------------------------------------
// Dashboard block — renders against the state module.
// ---------------------------------------------------------------------------

const DEFAULTS = { compact: false, showReadout: true };

// Per-mounted-block bag of DOM refs + its state-subscription teardown.
const instances = new WeakMap();

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function paintInto(host, settings) {
  host.replaceChildren();
  host.classList.add("search-mode");
  host.classList.toggle("search-mode--compact", !!settings.compact);

  const selected = api.get();          // null = server default
  const retrieval = api.retrieval();

  // ----- Header -----
  const head = el("div", "search-mode-head");
  head.appendChild(el("span", "search-mode-title", "Search"));
  head.appendChild(el("span", "search-mode-sub", "RETRIEVAL"));
  host.appendChild(head);

  // ----- Mode options -----
  const list = el("div", "search-mode-list");
  list.setAttribute("role", "radiogroup");
  list.setAttribute("aria-label", "palace retrieval strategy");

  for (const mode of MODES) {
    // "default" pill is active when nothing is explicitly picked AND this is
    // the server-default mode (hybrid). An explicit pick of hybrid still
    // counts as selected (so the user can pin it).
    const isSelected = selected === mode.id;
    const isServerDefaultActive = selected === null && !!mode.isDefault;

    const opt = el("button", "search-mode-opt");
    opt.type = "button";
    opt.setAttribute("role", "radio");
    opt.setAttribute("aria-checked", String(isSelected || isServerDefaultActive));
    opt.dataset.mode = mode.id;
    if (isSelected) opt.classList.add("search-mode-opt--selected");
    if (isServerDefaultActive) opt.classList.add("search-mode-opt--server-default");

    const accent = el("span", "search-mode-accent");
    opt.appendChild(accent);

    const glyph = el("span", "search-mode-glyph", mode.glyph);
    glyph.setAttribute("aria-hidden", "true");
    opt.appendChild(glyph);

    const text = el("div", "search-mode-opt-text");
    const labelRow = el("div", "search-mode-opt-labelrow");
    labelRow.appendChild(el("span", "search-mode-opt-label", mode.label));
    if (mode.isDefault) {
      const tag = el("span", "search-mode-defaulttag", "default");
      labelRow.appendChild(tag);
    }
    text.appendChild(labelRow);
    if (!settings.compact) {
      text.appendChild(el("div", "search-mode-opt-desc", mode.description));
      const endpoint = el("code", "search-mode-opt-endpoint", mode.endpoint);
      text.appendChild(endpoint);
    } else {
      text.appendChild(el("div", "search-mode-opt-tagline", mode.tagline));
    }
    opt.appendChild(text);

    const check = el("span", "search-mode-check");
    check.setAttribute("aria-hidden", "true");
    opt.appendChild(check);

    opt.addEventListener("click", () => {
      // Clicking the already-selected explicit mode clears it back to the
      // server default (a small "untoggle" affordance). Clicking any other
      // mode pins it.
      if (selected === mode.id) {
        api.set(null);
      } else {
        api.set(mode.id);
      }
      sound.chime?.();
    });

    list.appendChild(opt);
  }
  host.appendChild(list);

  // ----- Footer: effective-mode note + live retrieval readout -----
  const foot = el("div", "search-mode-foot");

  const effective = el("div", "search-mode-effective");
  if (selected === null) {
    effective.appendChild(el("span", "search-mode-effective-dot", ""));
    effective.appendChild(
      el("span", "search-mode-effective-text", "using server default (hybrid)"),
    );
  } else {
    effective.classList.add("search-mode-effective--pinned");
    effective.appendChild(el("span", "search-mode-effective-dot", ""));
    const lbl = MODES.find((m) => m.id === selected)?.label || selected;
    effective.appendChild(
      el("span", "search-mode-effective-text", `pinned · ${lbl}`),
    );
  }
  foot.appendChild(effective);

  if (settings.showReadout) {
    foot.appendChild(buildReadout(retrieval));
  }

  host.appendChild(foot);
}

// Live "N vector · N graph · N fused" readout from the last trace turn.
function buildReadout(retrieval) {
  const wrap = el("div", "search-mode-readout");
  wrap.setAttribute("aria-live", "polite");

  if (!retrieval) {
    wrap.classList.add("search-mode-readout--empty");
    wrap.appendChild(el("span", "search-mode-readout-hint", "no turn yet"));
    return wrap;
  }

  const head = el("div", "search-mode-readout-head");
  head.appendChild(el("span", "search-mode-readout-label", "last turn"));
  if (retrieval.mode) {
    head.appendChild(el("span", "search-mode-readout-mode", retrieval.mode));
  }
  wrap.appendChild(head);

  const bars = el("div", "search-mode-readout-bars");
  const nV = num(retrieval.n_vector);
  const nG = num(retrieval.n_graph);
  const nF = num(retrieval.n_after_fusion);
  bars.appendChild(statCell("vector", nV, "v"));
  bars.appendChild(statCell("graph", nG, "g"));
  bars.appendChild(statCell("fused", nF, "f"));
  wrap.appendChild(bars);

  // Graph-contribution micro-bar: how much of the fused set came via the
  // graph walk vs. vector. Purely illustrative; shows the AGE contribution.
  if (nV + nG > 0) {
    const total = nV + nG;
    const gPct = Math.round((nG / total) * 100);
    const meter = el("div", "search-mode-graphbar");
    meter.setAttribute("role", "img");
    meter.setAttribute(
      "aria-label",
      `graph contributed ${nG} of ${total} candidates (${gPct}%)`,
    );
    const fill = el("div", "search-mode-graphbar-fill");
    fill.style.width = `${gPct}%`;
    meter.appendChild(fill);
    wrap.appendChild(meter);
    const cap = el("div", "search-mode-graphbar-cap", `${gPct}% from graph`);
    wrap.appendChild(cap);
  }

  if (retrieval.fell_back_to) {
    const fb = el(
      "div",
      "search-mode-fallback",
      `requested mode degraded → ${retrieval.fell_back_to}`,
    );
    wrap.appendChild(fb);
  }

  return wrap;
}

function statCell(name, value, short) {
  const cell = el("div", `search-mode-stat search-mode-stat--${name}`);
  cell.appendChild(el("span", "search-mode-stat-num", String(value)));
  cell.appendChild(el("span", "search-mode-stat-name", name));
  cell.dataset.short = short;
  return cell;
}

function num(n) {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

function render(host) {
  host.classList.add("block-content-search-mode");

  const state = { settings: { ...DEFAULTS } };
  const repaint = () => paintInto(host, state.settings);

  // Subscribe to the shared state module — covers explicit picks here, picks
  // from another tab (storage event), and live retrieval readouts forwarded
  // from app.js. The subscribe callback fires immediately for first paint.
  const unsubscribe = api.subscribe(() => repaint());

  instances.set(host, {
    state,
    repaint,
    setSettings(next) {
      state.settings = { ...DEFAULTS, ...next };
      repaint();
    },
    destroy() {
      unsubscribe();
    },
  });

  // subscribe() already painted once; nothing else to do.
}

function renderSettings(host, layoutState, save) {
  if (!layoutState.settings) layoutState.settings = {};
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (!(k in layoutState.settings)) layoutState.settings[k] = v;
  }
  const s = layoutState.settings;

  function syncLive() {
    const block = host.closest(".block");
    const content = block?.querySelector(".block-content-search-mode");
    if (!content) return;
    const inst = instances.get(content);
    if (inst) inst.setSettings({ ...s });
  }

  const wrap = el("div", "search-mode-settings");
  wrap.appendChild(
    checkRow("Compact rows", !!s.compact, (v) => {
      s.compact = v;
      save();
      syncLive();
    }),
  );
  wrap.appendChild(
    checkRow("Show live readout", !!s.showReadout, (v) => {
      s.showReadout = v;
      save();
      syncLive();
    }),
  );
  host.appendChild(wrap);
}

function checkRow(label, checked, onChange) {
  const row = el("label", "search-mode-setting-row");
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.className = "search-mode-setting-check";
  cb.checked = checked;
  cb.addEventListener("change", () => onChange(cb.checked));
  row.appendChild(cb);
  row.appendChild(el("span", "search-mode-setting-label", label));
  return row;
}

dashboard.registerBlockType({
  id: "search-mode",
  name: "search",
  defaultRect: { col: 8, row: 16, w: 4, h: 9 },
  render,
  renderSettings,
});
