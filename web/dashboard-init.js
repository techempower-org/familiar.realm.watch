// dashboard-init.js — wire up the v1 block types (chat, palace, model) and
// mount the dashboard. Runs before app.js so that the chat/palace IDs are
// live in the document by the time app.js queries them.
//
// Each block type's render(el) function relocates the contents of a
// <template id="slot-..."> into the block's content area. Templates are the
// canonical source of the chat/palace markup so this file stays declarative
// and the dashboard layer never inlines big HTML strings.

import { dashboard } from "./dashboard.js";

const SETTINGS_DEFAULTS = {
  chat:   { autoScroll: true, showTimestamps: false, density: "comfortable" },
  palace: { defaultTab: "drawers", density: "comfortable" },
  model:  { showHint: true },
};

// Settings ↔ DOM: apply persisted setting bag to the live block content.
function applyChatSettings(content, s) {
  content.dataset.autoScroll = s.autoScroll ? "1" : "0";
  content.dataset.showTimestamps = s.showTimestamps ? "1" : "0";
  content.dataset.density = s.density || "comfortable";
}
function applyPalaceSettings(content, s) {
  content.dataset.density = s.density || "comfortable";
  if (s.defaultTab) content.dataset.defaultTab = s.defaultTab;
}
function applyModelSettings(content, s) {
  content.dataset.showHint = s.showHint ? "1" : "0";
}

function adoptTemplate(slotId, target) {
  const tpl = document.getElementById(slotId);
  if (!tpl || !(tpl instanceof HTMLTemplateElement)) {
    console.warn(`[dashboard-init] missing template: ${slotId}`);
    return;
  }
  // Adopt children once. After the first render, tpl.content is empty;
  // subsequent renders are no-ops (which is the right semantic: we want a
  // single canonical DOM subtree per slot — re-mounting must not duplicate).
  while (tpl.content.firstChild) target.appendChild(tpl.content.firstChild);
}

// Generic settings-row helper.
function settingRow(label, input) {
  const row = document.createElement("label");
  row.className = "block-settings-row";
  const span = document.createElement("span");
  span.className = "block-settings-row-label";
  span.textContent = label;
  row.appendChild(span);
  row.appendChild(input);
  return row;
}
function mkCheckbox(checked) {
  const i = document.createElement("input");
  i.type = "checkbox";
  i.checked = !!checked;
  return i;
}
function mkSelect(value, options) {
  const s = document.createElement("select");
  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    s.appendChild(o);
  }
  s.value = value;
  return s;
}

// Find a block-type's live content node (post-render) for settings to mutate.
function liveContent(host, cls) {
  const block = host.closest(".block");
  return block ? block.querySelector(cls) : null;
}

dashboard.registerBlockType({
  id: "chat",
  name: "chat",
  defaultRect: { col: 0, row: 0, w: 8, h: 12 },
  render(el) {
    el.classList.add("block-content-chat");
    applyChatSettings(el, { ...SETTINGS_DEFAULTS.chat });
    adoptTemplate("slot-chat", el);
  },
  renderSettings(host, state, save) {
    const s = state.settings = { ...SETTINGS_DEFAULTS.chat, ...(state.settings || {}) };
    const wrap = document.createElement("div");

    function sync() {
      const live = liveContent(host, ".block-content-chat");
      if (live) applyChatSettings(live, s);
    }

    const auto = mkCheckbox(s.autoScroll);
    auto.addEventListener("change", () => { s.autoScroll = auto.checked; save(); sync(); });
    wrap.appendChild(settingRow("auto-scroll on new", auto));

    const ts = mkCheckbox(s.showTimestamps);
    ts.addEventListener("change", () => { s.showTimestamps = ts.checked; save(); sync(); });
    wrap.appendChild(settingRow("show timestamps", ts));

    const dens = mkSelect(s.density, [
      { value: "comfortable", label: "comfortable" },
      { value: "compact",     label: "compact" },
      { value: "cozy",        label: "cozy" },
    ]);
    dens.addEventListener("change", () => { s.density = dens.value; save(); sync(); });
    wrap.appendChild(settingRow("density", dens));

    host.appendChild(wrap);
  },
});

dashboard.registerBlockType({
  id: "palace",
  name: "palace",
  defaultRect: { col: 0, row: 12, w: 12, h: 14 },
  render(el) {
    el.classList.add("block-content-palace");
    applyPalaceSettings(el, { ...SETTINGS_DEFAULTS.palace });
    adoptTemplate("slot-palace", el);
  },
  renderSettings(host, state, save) {
    const s = state.settings = { ...SETTINGS_DEFAULTS.palace, ...(state.settings || {}) };
    const wrap = document.createElement("div");

    function sync() {
      const live = liveContent(host, ".block-content-palace");
      if (live) applyPalaceSettings(live, s);
    }

    const tab = mkSelect(s.defaultTab, [
      { value: "wings",   label: "wings" },
      { value: "rooms",   label: "rooms" },
      { value: "drawers", label: "drawers" },
      { value: "kg",      label: "knowledge graph" },
    ]);
    tab.addEventListener("change", () => { s.defaultTab = tab.value; save(); sync(); });
    wrap.appendChild(settingRow("default column", tab));

    const dens = mkSelect(s.density, [
      { value: "comfortable", label: "comfortable" },
      { value: "compact",     label: "compact" },
    ]);
    dens.addEventListener("change", () => { s.density = dens.value; save(); sync(); });
    wrap.appendChild(settingRow("density", dens));

    host.appendChild(wrap);
  },
});

dashboard.registerBlockType({
  id: "model",
  name: "model",
  defaultRect: { col: 8, row: 0, w: 4, h: 6 },
  render(el) {
    el.classList.add("block-content-model");
    applyModelSettings(el, { ...SETTINGS_DEFAULTS.model });
    adoptTemplate("slot-model", el);
  },
  renderSettings(host, state, save) {
    const s = state.settings = { ...SETTINGS_DEFAULTS.model, ...(state.settings || {}) };
    const wrap = document.createElement("div");

    function sync() {
      const live = liveContent(host, ".block-content-model");
      if (live) applyModelSettings(live, s);
    }

    const hint = mkCheckbox(s.showHint);
    hint.addEventListener("change", () => { s.showHint = hint.checked; save(); sync(); });
    wrap.appendChild(settingRow("show hint text", hint));

    const note = document.createElement("p");
    note.className = "block-settings-note";
    note.textContent = "Richer slot picker available via the slots block.";
    wrap.appendChild(note);

    host.appendChild(wrap);
  },
});

const root = document.getElementById("dashboard");
if (root) dashboard.mount(root);

// ---------- Header: "+ add block" picker ----------
const addBtn = document.getElementById("dashboard-add");
let pickerEl = null;
function closePicker() {
  if (pickerEl) {
    pickerEl.remove();
    pickerEl = null;
    document.removeEventListener("pointerdown", onPickerOutside, true);
    document.removeEventListener("keydown", onPickerEscape, true);
  }
}
function onPickerOutside(e) {
  if (!pickerEl) return;
  if (pickerEl.contains(e.target)) return;
  if (e.target.closest("#dashboard-add")) return;
  closePicker();
}
function onPickerEscape(e) {
  if (!pickerEl) return;
  if (e.key === "Escape") {
    closePicker();
    // Return focus to the trigger so keyboard users keep their place.
    if (addBtn) addBtn.focus();
    return;
  }
  // Arrow-key navigation within the picker (#65).
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  const rows = Array.from(pickerEl.querySelectorAll(".dashboard-picker-row"));
  if (rows.length === 0) return;
  e.preventDefault();
  const active = document.activeElement;
  const idx = rows.indexOf(active);
  let next;
  if (e.key === "ArrowDown") next = idx < 0 ? 0 : (idx + 1) % rows.length;
  else next = idx <= 0 ? rows.length - 1 : idx - 1;
  rows[next].focus();
}
function openPicker() {
  if (pickerEl) { closePicker(); return; }
  closePresets();
  const types = dashboard.listTypes();
  const pop = document.createElement("div");
  pop.className = "dashboard-picker";
  pop.setAttribute("role", "menu");

  const head = document.createElement("div");
  head.className = "dashboard-picker-head";
  head.textContent = "blocks";
  pop.appendChild(head);

  if (!types.length) {
    const empty = document.createElement("div");
    empty.className = "dashboard-picker-empty";
    empty.textContent = "no registered block types";
    pop.appendChild(empty);
  } else {
    for (const t of types) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "dashboard-picker-row";
      row.setAttribute("role", "menuitem");
      if (t.visible) row.classList.add("dashboard-picker-row--on");

      const name = document.createElement("span");
      name.className = "dashboard-picker-row-name";
      name.textContent = t.name;
      row.appendChild(name);

      const stat = document.createElement("span");
      stat.className = "dashboard-picker-row-status";
      stat.textContent = t.visible ? "hide" : "add";
      row.appendChild(stat);

      row.addEventListener("click", () => {
        if (t.visible) dashboard.hideBlock(t.id);
        else dashboard.showBlock(t.id);
        closePicker();
        // Reopen to reflect new state for quick toggling? Keep closed — less surprising.
      });
      pop.appendChild(row);
    }
  }

  if (addBtn) {
    const r = addBtn.getBoundingClientRect();
    pop.style.top = `${Math.round(r.bottom + 6)}px`;
    pop.style.right = `${Math.max(8, document.documentElement.clientWidth - r.right)}px`;
  }
  document.body.appendChild(pop);
  pickerEl = pop;
  // Defer attaching outside-click handler one tick so the opening click doesn't fire it.
  // Auto-focus the first row so keyboard users land somewhere actionable (#65).
  requestAnimationFrame(() => {
    document.addEventListener("pointerdown", onPickerOutside, true);
    document.addEventListener("keydown", onPickerEscape, true);
    const firstRow = pop.querySelector(".dashboard-picker-row");
    if (firstRow) firstRow.focus();
  });
}
if (addBtn) addBtn.addEventListener("click", openPicker);

// ---------- Header: reset/preset menu ----------
const resetBtn = document.getElementById("dashboard-reset");
let presetEl = null;
function closePresets() {
  if (presetEl) {
    presetEl.remove();
    presetEl = null;
    document.removeEventListener("pointerdown", onPresetOutside, true);
    document.removeEventListener("keydown", onPresetEscape, true);
  }
}
function onPresetOutside(e) {
  if (!presetEl) return;
  if (presetEl.contains(e.target)) return;
  if (e.target.closest("#dashboard-reset")) return;
  closePresets();
}
function onPresetEscape(e) {
  if (e.key === "Escape") closePresets();
}
function openPresets() {
  if (presetEl) { closePresets(); return; }
  closePicker();
  const pop = document.createElement("div");
  pop.className = "dashboard-picker";
  pop.setAttribute("role", "menu");

  const head = document.createElement("div");
  head.className = "dashboard-picker-head";
  head.textContent = "layout";
  pop.appendChild(head);

  for (const presetId of dashboard.presets) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "dashboard-picker-row";
    row.setAttribute("role", "menuitem");
    const name = document.createElement("span");
    name.className = "dashboard-picker-row-name";
    name.textContent = presetId;
    row.appendChild(name);
    const stat = document.createElement("span");
    stat.className = "dashboard-picker-row-status";
    stat.textContent = "apply";
    row.appendChild(stat);
    row.addEventListener("click", () => {
      if (confirm(`Apply "${presetId}" layout? Block positions will be replaced.`)) {
        dashboard.applyPreset(presetId);
      }
      closePresets();
    });
    pop.appendChild(row);
  }

  // Reset row at the bottom — separator handled by CSS.
  const sep = document.createElement("div");
  sep.className = "dashboard-picker-sep";
  pop.appendChild(sep);

  const resetRow = document.createElement("button");
  resetRow.type = "button";
  resetRow.className = "dashboard-picker-row dashboard-picker-row--danger";
  resetRow.setAttribute("role", "menuitem");
  const resetName = document.createElement("span");
  resetName.className = "dashboard-picker-row-name";
  resetName.textContent = "reset all";
  resetRow.appendChild(resetName);
  const resetStat = document.createElement("span");
  resetStat.className = "dashboard-picker-row-status";
  resetStat.textContent = "wipe";
  resetRow.appendChild(resetStat);
  resetRow.addEventListener("click", () => {
    if (confirm("Reset block layout to defaults? Your changes will be lost.")) {
      dashboard.resetLayout();
    }
    closePresets();
  });
  pop.appendChild(resetRow);

  if (resetBtn) {
    const r = resetBtn.getBoundingClientRect();
    pop.style.top = `${Math.round(r.bottom + 6)}px`;
    pop.style.right = `${Math.max(8, document.documentElement.clientWidth - r.right)}px`;
  }
  document.body.appendChild(pop);
  presetEl = pop;
  requestAnimationFrame(() => {
    document.addEventListener("pointerdown", onPresetOutside, true);
    document.addEventListener("keydown", onPresetEscape, true);
  });
}
if (resetBtn) resetBtn.addEventListener("click", openPresets);

// ---------- Welcome ritual (once per deploy hash) ----------
// First visit OR first visit after a new deploy: fade the realm word in
// over the dashboard for ~1.5s before fading out. Plays sound.flourish()
// at peak if the user has audio enabled. Stored as the realm hash so
// each new deploy gets its own flourish. Respects prefers-reduced-motion.
(async function welcomeRitual() {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  let version;
  try {
    const r = await fetch("/api/version", { credentials: "same-origin" });
    if (!r.ok) return;
    version = await r.json();
  } catch { return; }
  if (!version || !version.hash || !version.word) return;
  const key = `familiar_welcomed_${version.hash}`;
  let lastSeen;
  try { lastSeen = localStorage.getItem(key); } catch { return; }
  if (lastSeen) return;

  const overlay = document.createElement("div");
  overlay.className = "welcome-flourish";
  overlay.setAttribute("aria-hidden", "true");
  const inner = document.createElement("div");
  inner.className = "welcome-flourish-inner";
  const word = document.createElement("div");
  word.className = "welcome-flourish-word";
  word.textContent = version.word;
  const sub = document.createElement("div");
  sub.className = "welcome-flourish-sub";
  sub.textContent = `· ${version.hash.slice(0, 7)} ·`;
  inner.appendChild(word);
  inner.appendChild(sub);
  overlay.appendChild(inner);
  document.body.appendChild(overlay);

  try {
    const { sound } = await import("/widgets/sound.js");
    requestAnimationFrame(() => sound.flourish?.());
  } catch { /* sound module not present yet — silent flourish is still fine */ }

  requestAnimationFrame(() => overlay.classList.add("show"));
  setTimeout(() => {
    overlay.classList.remove("show");
    setTimeout(() => overlay.remove(), 700);
    try { localStorage.setItem(key, "1"); } catch { /* full quota */ }
  }, 1500);
})();
