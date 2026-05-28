// command-palette.js — Ctrl/Cmd+K fuzzy command launcher.
//
// Exposes an extensible registry on window.familiarDashboard so other
// modules can call dashboard.registerCommand({...}) to add their own
// actions. Built-in commands are registered after the dashboard mounts;
// slot variants are loaded live from /api/familiar/slots.
//
// Design notes:
//   * <dialog> for native modal semantics + automatic backdrop + Esc.
//   * Vanilla subsequence fuzzy match (no library). Case-insensitive.
//     Score = match-position-sum (lower is better; consecutive hits
//     get a small bonus so "ns" beats "n…s" against "new session").
//   * Sections render in registration order; rows within a section
//     reorder by score when the user types.
//   * Reduced-motion respected via CSS (animations swapped out there).
//
// Wire-up at the bottom of this file:
//   1. registers built-ins (chat, layout, theme, help)
//   2. fetches /api/familiar/slots to inject per-variant "set chat slot
//      to <variant>" commands (refreshes when palette is opened).
//   3. binds Ctrl+K / Cmd+K globally — ignored when an inline editable
//      area or another dialog already owns focus.

import { dashboard } from "./dashboard.js";

const SECTIONS = ["chat", "layout", "slots", "theme", "help"];

const commands = [];
let nextOrdinal = 0;

function registerCommand(spec) {
  if (!spec || !spec.id || !spec.label || typeof spec.run !== "function") {
    console.warn("[palette] registerCommand requires {id,label,run}", spec);
    return;
  }
  // Replace existing by id (lets slot variants refresh cleanly).
  const idx = commands.findIndex((c) => c.id === spec.id);
  const entry = {
    id: spec.id,
    label: String(spec.label),
    section: spec.section || "other",
    shortcut: spec.shortcut || "",
    icon: spec.icon || null,
    run: spec.run,
    ord: idx >= 0 ? commands[idx].ord : nextOrdinal++,
  };
  if (idx >= 0) commands[idx] = entry;
  else commands.push(entry);
}

function unregisterCommand(id) {
  const idx = commands.findIndex((c) => c.id === id);
  if (idx >= 0) commands.splice(idx, 1);
}

// Expose on the dashboard registry so future blocks can extend.
if (dashboard) {
  dashboard.registerCommand = registerCommand;
  dashboard.unregisterCommand = unregisterCommand;
  dashboard.openCommandPalette = open;
}

// ---------- fuzzy match ----------
// Subsequence scoring: walk pattern through label; track position spans.
// Returns { score, matched: number[] } or null if not a subsequence.
function fuzzyScore(pattern, label) {
  if (!pattern) return { score: 0, matched: [] };
  const p = pattern.toLowerCase();
  const t = label.toLowerCase();
  const matched = [];
  let ti = 0;
  let lastHit = -2;
  let score = 0;
  for (let pi = 0; pi < p.length; pi++) {
    const ch = p[pi];
    let found = -1;
    while (ti < t.length) {
      if (t[ti] === ch) { found = ti; ti++; break; }
      ti++;
    }
    if (found === -1) return null;
    matched.push(found);
    // Score: position penalty (later matches are worse) + gap penalty.
    score += found;
    if (lastHit >= 0 && found !== lastHit + 1) score += (found - lastHit) * 2;
    lastHit = found;
  }
  // Bonus: matches starting at word boundary.
  if (matched[0] === 0 || /\s|[._-]/.test(label[matched[0] - 1] || "")) score -= 4;
  return { score, matched };
}

function highlightLabel(label, matched) {
  if (!matched || matched.length === 0) return document.createTextNode(label);
  const frag = document.createDocumentFragment();
  let cursor = 0;
  for (const idx of matched) {
    if (idx > cursor) frag.appendChild(document.createTextNode(label.slice(cursor, idx)));
    const mk = document.createElement("mark");
    mk.textContent = label[idx];
    frag.appendChild(mk);
    cursor = idx + 1;
  }
  if (cursor < label.length) frag.appendChild(document.createTextNode(label.slice(cursor)));
  return frag;
}

// ---------- dialog + render ----------

let dlg = null;
let input = null;
let body = null;
let activeIndex = 0;
let lastResults = [];

function ensureDialog() {
  if (dlg) return dlg;
  dlg = document.createElement("dialog");
  dlg.className = "command-palette";
  dlg.setAttribute("aria-label", "command palette");

  const head = document.createElement("div");
  head.className = "command-palette-head";

  const sigil = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  sigil.setAttribute("viewBox", "0 0 16 16");
  sigil.setAttribute("aria-hidden", "true");
  sigil.classList.add("command-palette-sigil");
  // Concentric rings with a single keyhole notch — minimal sigil that
  // reads at 14px and rhymes with the sidebar sigil glyph.
  sigil.innerHTML = `
    <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1"/>
    <circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="0.6" stroke-opacity="0.6"/>
    <circle cx="8" cy="8" r="1" fill="currentColor"/>
    <path d="M8 1 L8 2.5 M8 13.5 L8 15 M1 8 L2.5 8 M13.5 8 L15 8" stroke="currentColor" stroke-width="0.8" stroke-linecap="round"/>
  `;
  head.appendChild(sigil);

  input = document.createElement("input");
  input.type = "text";
  input.className = "command-palette-input";
  input.placeholder = "speak the command…";
  input.setAttribute("aria-label", "search commands");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "false");
  head.appendChild(input);

  const hint = document.createElement("span");
  hint.className = "command-palette-hint";
  hint.textContent = isMac() ? "⌘K" : "Ctrl+K";
  head.appendChild(hint);

  dlg.appendChild(head);

  body = document.createElement("div");
  body.className = "command-palette-body";
  body.setAttribute("role", "listbox");
  dlg.appendChild(body);

  const foot = document.createElement("div");
  foot.className = "command-palette-foot";
  function footRow(keys, label) {
    const span = document.createElement("span");
    for (const k of keys) {
      const kbd = document.createElement("kbd");
      kbd.textContent = k;
      span.appendChild(kbd);
    }
    span.appendChild(document.createTextNode(" " + label));
    return span;
  }
  foot.appendChild(footRow(["↑", "↓"], "navigate"));
  foot.appendChild(footRow(["↵"], "run"));
  foot.appendChild(footRow(["esc"], "close"));
  dlg.appendChild(foot);

  input.addEventListener("input", () => { activeIndex = 0; renderRows(); });
  input.addEventListener("keydown", onInputKey);
  // Click outside the inner contents (i.e. on the backdrop) closes the dialog.
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) close();
  });
  dlg.addEventListener("close", () => {
    // <dialog> emits "close" on Esc as well as on close() call.
    input.value = "";
    lastResults = [];
    activeIndex = 0;
  });

  document.body.appendChild(dlg);
  return dlg;
}

function isMac() {
  return typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/i.test(navigator.platform || "");
}

function open() {
  ensureDialog();
  // Refresh slot variants on each open so the live state is current.
  refreshSlotCommands();
  activeIndex = 0;
  renderRows();
  if (typeof dlg.showModal === "function") {
    try { dlg.showModal(); } catch { dlg.show(); }
  } else {
    dlg.show();
  }
  requestAnimationFrame(() => input.focus());
}

function close() {
  if (dlg && dlg.open) dlg.close();
}

function toggle() {
  if (dlg && dlg.open) close();
  else open();
}

function onInputKey(e) {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    moveActive(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    moveActive(-1);
  } else if (e.key === "PageDown") {
    e.preventDefault();
    moveActive(5);
  } else if (e.key === "PageUp") {
    e.preventDefault();
    moveActive(-5);
  } else if (e.key === "Home" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    activeIndex = 0;
    updateActive();
  } else if (e.key === "End" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    activeIndex = Math.max(0, lastResults.length - 1);
    updateActive();
  } else if (e.key === "Enter") {
    e.preventDefault();
    const pick = lastResults[activeIndex];
    if (pick) {
      close();
      // Defer so close() finishes and focus returns before the command
      // tries to focus another element (avoid focus-fight on chat input).
      requestAnimationFrame(() => {
        try { pick.run(); } catch (err) { console.error("[palette] command failed:", err); }
      });
    }
  } else if (e.key === "Escape") {
    // Native <dialog> handles this; nothing extra to do.
  }
}

function moveActive(delta) {
  if (lastResults.length === 0) return;
  activeIndex = (activeIndex + delta + lastResults.length) % lastResults.length;
  updateActive();
}

function updateActive() {
  const rows = body.querySelectorAll(".command-palette-row");
  rows.forEach((r, i) => {
    if (i === activeIndex) {
      r.classList.add("is-active");
      r.scrollIntoView({ block: "nearest" });
    } else {
      r.classList.remove("is-active");
    }
  });
}

function renderRows() {
  while (body.firstChild) body.removeChild(body.firstChild);
  const query = (input.value || "").trim();

  // Score every command.
  const scored = [];
  for (const cmd of commands) {
    const r = fuzzyScore(query, cmd.label);
    if (!r) continue;
    scored.push({ ...cmd, score: r.score, matched: r.matched });
  }

  if (scored.length === 0) {
    const empty = document.createElement("div");
    empty.className = "command-palette-empty";
    empty.textContent = query
      ? `no command matches “${query}”`
      : "no commands registered yet";
    body.appendChild(empty);
    lastResults = [];
    return;
  }

  // Sort: by score asc when query present, by section + ord when not.
  if (query) {
    scored.sort((a, b) => a.score - b.score || a.ord - b.ord);
  } else {
    scored.sort((a, b) => {
      const sa = SECTIONS.indexOf(a.section);
      const sb = SECTIONS.indexOf(b.section);
      const ka = sa < 0 ? 99 : sa;
      const kb = sb < 0 ? 99 : sb;
      return ka - kb || a.ord - b.ord;
    });
  }

  // Render with section headers (only when there's no active query, so
  // typing flattens the list and ranks by score across all sections).
  let lastSection = null;
  scored.forEach((cmd, i) => {
    if (!query && cmd.section !== lastSection) {
      lastSection = cmd.section;
      const hd = document.createElement("div");
      hd.className = "command-palette-section";
      hd.textContent = cmd.section;
      body.appendChild(hd);
    }
    body.appendChild(rowEl(cmd, i));
  });
  lastResults = scored;
  updateActive();
}

function rowEl(cmd, i) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "command-palette-row";
  row.setAttribute("role", "option");
  row.dataset.cmdId = cmd.id;

  const icon = document.createElement("span");
  icon.className = "command-palette-row-icon";
  // Only accept Node icons — strings are rejected so callers can't smuggle
  // markup through the public registerCommand surface. Section glyph is
  // the safe default.
  if (cmd.icon instanceof Node) {
    icon.appendChild(cmd.icon.cloneNode(true));
  } else {
    icon.textContent = sectionGlyph(cmd.section);
  }
  row.appendChild(icon);

  const label = document.createElement("span");
  label.className = "command-palette-row-label";
  label.appendChild(highlightLabel(cmd.label, cmd.matched));
  row.appendChild(label);

  if (cmd.shortcut) {
    const sc = document.createElement("span");
    sc.className = "command-palette-row-shortcut";
    sc.textContent = cmd.shortcut;
    row.appendChild(sc);
  }

  row.addEventListener("mousemove", () => {
    if (activeIndex !== i) { activeIndex = i; updateActive(); }
  });
  row.addEventListener("click", () => {
    close();
    requestAnimationFrame(() => {
      try { cmd.run(); } catch (err) { console.error("[palette] command failed:", err); }
    });
  });
  return row;
}

function sectionGlyph(section) {
  switch (section) {
    case "chat":   return "❝";
    case "layout": return "▦";
    case "slots":  return "◉";
    case "theme":  return "☾";
    case "help":   return "?";
    default:       return "·";
  }
}

// ---------- built-in commands ----------

function clickById(id) {
  const el = document.getElementById(id);
  if (el) el.click();
}

function focusChat() {
  const inputEl = document.getElementById("input");
  if (inputEl) inputEl.focus();
}

function clearChatLog() {
  // The chat log is a live aria container in #log; emptying it visually
  // resets the transcript without touching the underlying session store
  // (the session itself is preserved — refreshing or switching restores).
  const log = document.getElementById("log");
  if (log) {
    while (log.firstChild) log.removeChild(log.firstChild);
  }
}

function newSession() {
  const btn = document.getElementById("sessions-new");
  if (btn) btn.click();
}

function abortGeneration() {
  const btn = document.getElementById("abort-btn");
  if (btn && !btn.hidden) {
    btn.click();
  } else {
    // No active generation — dispatch Escape so any listener that wants
    // to honor "abort anywhere" still fires. Harmless when nothing
    // matches.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  }
}

function openAddBlock() { clickById("dashboard-add"); }
function openLayoutMenu() { clickById("dashboard-reset"); }
function toggleSidebar() { document.body.classList.toggle("sidebar-open"); }

function setTheme(pref) {
  // dark.js owns the canonical resolution. We just write the storage key
  // it reads (drw-theme) and dispatch the event so highlight.js styles
  // resync on the fly.
  try {
    if (pref === "system") localStorage.removeItem("drw-theme");
    else localStorage.setItem("drw-theme", pref);
  } catch { /* private mode — best effort */ }
  if (pref === "dark" || pref === "light") {
    document.documentElement.setAttribute("data-theme", pref);
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  document.dispatchEvent(new CustomEvent("dark:change", { detail: { pref } }));
}

function openSlotPickerBlock() {
  // The slot-picker is its own block; make sure it's visible, then scroll
  // to the first slot-picker block in the dashboard.
  try {
    if (dashboard && typeof dashboard.showBlock === "function") {
      dashboard.showBlock("slot-picker");
    }
  } catch { /* block not registered — fall through */ }
  requestAnimationFrame(() => {
    const block = document.querySelector(".block-content-slot-picker")?.closest(".block");
    if (block) block.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

async function setChatSlotVariant(variantId) {
  try {
    const r = await fetch(`/api/familiar/admin/slots/chat`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variant_id: variantId }),
      credentials: "same-origin",
    });
    if (!r.ok) {
      console.warn("[palette] PATCH chat slot failed:", r.status, await r.text().catch(() => ""));
    }
  } catch (err) {
    console.warn("[palette] PATCH chat slot threw:", err);
  }
}

// Version modal — "what's new this deploy?" — uses a separate <dialog>.
// All content is built with createElement/textContent so the /api/version
// payload can't smuggle markup or javascript: URLs into the page.
let verDlg = null;

function clearChildren(el) { while (el.firstChild) el.removeChild(el.firstChild); }

function safeHttpUrl(s) {
  try {
    const u = new URL(s, window.location.origin);
    if (u.protocol === "http:" || u.protocol === "https:") return u.href;
  } catch { /* not a URL */ }
  return null;
}

function buildVersionLoading() {
  clearChildren(verDlg);
  const h = document.createElement("h3");
  h.textContent = "checking…";
  verDlg.appendChild(h);
}

function buildVersionError(message) {
  clearChildren(verDlg);
  const h = document.createElement("h3");
  h.textContent = "version unavailable";
  verDlg.appendChild(h);
  const p = document.createElement("p");
  p.style.color = "var(--fg-muted)";
  p.style.fontStyle = "italic";
  p.style.fontFamily = "var(--serif)";
  p.textContent = message;
  verDlg.appendChild(p);
  const foot = document.createElement("div");
  foot.className = "cpv-foot";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "close";
  closeBtn.addEventListener("click", () => verDlg.close());
  foot.appendChild(closeBtn);
  verDlg.appendChild(foot);
}

function buildVersionContent(d) {
  clearChildren(verDlg);
  const h = document.createElement("h3");
  h.textContent = d.word || "this deploy";
  verDlg.appendChild(h);

  const dl = document.createElement("dl");
  const rows = [
    ["version", d.pkg_version || "—"],
    ["hash", d.hash || "—"],
    ["branch", (d.branch || "—") + (d.dirty ? " (dirty)" : "")],
    ["built", d.built ? new Date(d.built).toLocaleString() : "unknown"],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
  verDlg.appendChild(dl);

  const foot = document.createElement("div");
  foot.className = "cpv-foot";
  const commitUrl = d.commit_url ? safeHttpUrl(d.commit_url) : null;
  if (commitUrl) {
    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.textContent = "open commit";
    openBtn.addEventListener("click", () => {
      window.open(commitUrl, "_blank", "noopener");
    });
    foot.appendChild(openBtn);
  }
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "close";
  closeBtn.addEventListener("click", () => verDlg.close());
  foot.appendChild(closeBtn);
  verDlg.appendChild(foot);
}

async function openVersionModal() {
  if (!verDlg) {
    verDlg = document.createElement("dialog");
    verDlg.className = "command-palette-version";
    verDlg.setAttribute("aria-label", "deploy info");
    document.body.appendChild(verDlg);
  }
  buildVersionLoading();
  try { verDlg.showModal(); } catch { verDlg.show(); }
  try {
    const r = await fetch("/api/version", { credentials: "same-origin" });
    if (!r.ok) throw new Error(`status ${r.status}`);
    const d = await r.json();
    buildVersionContent(d);
  } catch (err) {
    buildVersionError(String(err && err.message || err));
  }
}

// ---------- slot variants (live from /api/familiar/slots) ----------

let slotsInflight = null;

async function refreshSlotCommands() {
  // Don't double-fetch in flight — share the promise.
  if (slotsInflight) return slotsInflight;
  slotsInflight = (async () => {
    try {
      const r = await fetch("/api/familiar/slots", { credentials: "same-origin" });
      if (!r.ok) return;
      const data = await r.json();
      const variants = data?.registry?.variants || [];
      // Remove old slot-variant commands before re-registering.
      for (let i = commands.length - 1; i >= 0; i--) {
        if (commands[i].id.startsWith("slot:chat:")) commands.splice(i, 1);
      }
      for (const v of variants) {
        if (!Array.isArray(v.capabilities) || !v.capabilities.includes("chat")) continue;
        registerCommand({
          id: `slot:chat:${v.id}`,
          label: `set chat slot to ${v.label || v.id}`,
          section: "slots",
          run: () => setChatSlotVariant(v.id),
        });
      }
    } catch {
      /* offline / 5xx — palette stays functional without slot variants */
    } finally {
      slotsInflight = null;
    }
  })();
  return slotsInflight;
}

// ---------- registration ----------

registerCommand({ id: "chat.focus", label: "focus chat input", section: "chat",
  shortcut: "/", run: focusChat });
registerCommand({ id: "chat.new", label: "new session", section: "chat",
  shortcut: "Ctrl+Shift+N", run: newSession });
registerCommand({ id: "chat.clear", label: "clear chat log", section: "chat",
  run: clearChatLog });
registerCommand({ id: "chat.abort", label: "abort current generation", section: "chat",
  shortcut: "Esc", run: abortGeneration });

registerCommand({ id: "layout.add-block", label: "add or hide block…", section: "layout",
  run: openAddBlock });
registerCommand({ id: "layout.menu", label: "open layout menu", section: "layout",
  run: openLayoutMenu });
registerCommand({ id: "layout.sidebar", label: "toggle sidebar", section: "layout",
  shortcut: "Ctrl+Shift+S", run: toggleSidebar });

// Preset commands are added once the dashboard reports its registered presets.
function registerPresetCommands() {
  try {
    const presets = (dashboard && dashboard.presets) || [];
    for (const p of presets) {
      registerCommand({
        id: `layout.preset:${p}`,
        label: `apply ${p} layout`,
        section: "layout",
        run: () => {
          if (confirm(`Apply "${p}" layout? Block positions will be replaced.`)) {
            dashboard.applyPreset(p);
          }
        },
      });
    }
    registerCommand({
      id: "layout.reset",
      label: "reset layout to defaults",
      section: "layout",
      run: () => {
        if (confirm("Reset block layout to defaults? Your changes will be lost.")) {
          dashboard.resetLayout();
        }
      },
    });
  } catch (err) {
    console.warn("[palette] could not register preset commands:", err);
  }
}
registerPresetCommands();

registerCommand({ id: "slots.picker", label: "open slot picker", section: "slots",
  run: openSlotPickerBlock });

registerCommand({ id: "theme.dark", label: "switch to dark theme", section: "theme",
  run: () => setTheme("dark") });
registerCommand({ id: "theme.light", label: "switch to light theme", section: "theme",
  run: () => setTheme("light") });
registerCommand({ id: "theme.system", label: "follow system theme", section: "theme",
  run: () => setTheme("system") });

registerCommand({ id: "help.version", label: "what's new this deploy?", section: "help",
  run: openVersionModal });

// Best-effort prefetch of slot variants on idle so the first Ctrl+K
// already shows them. Falls back silently if the endpoint isn't there.
if (typeof window !== "undefined") {
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(() => refreshSlotCommands(), { timeout: 2000 });
  } else {
    setTimeout(() => refreshSlotCommands(), 800);
  }
}

// ---------- global hotkey ----------

document.addEventListener("keydown", (e) => {
  // Ctrl+K (Linux/Windows) or Cmd+K (Mac). Avoid stealing when an inline
  // editable element has focus and the user is typing real text — but a
  // command palette explicitly *should* work from inside chat input too,
  // so we intentionally do not bail on those.
  const isK = e.key === "k" || e.key === "K";
  const mod = e.ctrlKey || e.metaKey;
  if (mod && isK && !e.altKey) {
    e.preventDefault();
    toggle();
  }
});
