// dashboard.js — Wave-Terminal-style movable+resizable block grid.
//
// Design note:
//   Vanilla TS/JS, no third-party dep. Wave Terminal's spatial behavior is
//   the inspiration; we hand-roll because GridStack/Muuri (~30-60 kb each)
//   would need glue code anyway and a bespoke implementation inherits every
//   existing CSS custom property naturally.
//
// Model:
//   - The dashboard is a 12-column grid laid over `<main class="dashboard">`.
//   - Each block has an integer cell rect {col, row, w, h}, persisted to
//     localStorage["familiar_dashboard_layout"] as { [blockId]: { rect,
//     visible, settings } }.
//   - Drag uses pointer events; movement is computed in pixels, snapped to
//     cell coords on release. A ghost preview shows the snapped target.
//   - Resize uses a bottom-right handle (nw-se cursor); also snaps to grid.
//   - Mobile (<768px): block rects collapse to a single-column stack;
//     drag/resize disabled. Layout still persists; restoring on wide
//     viewports brings back the saved rect.
//   - Reduced motion: transitions disabled (handled in CSS via the media
//     query — JS only adds/removes a `.dragging` class which CSS gates).
//
// Public API (used by app.js + future block authors):
//   dashboard.registerBlockType({ id, name, render(el), renderSettings(el), defaultRect })
//   dashboard.mount(rootEl)
//   dashboard.addBlock(typeId, { id?, rect? })       // for "+ add block" menu later
//   dashboard.resetLayout()
//
// Blocks are *content adapters*: render(el) gets the inner content area and
// is expected to populate it. The block's chrome (header, drag-bar, gear,
// close, resize handle) is managed entirely here.

const LAYOUT_KEY = "familiar_dashboard_layout";
const COLS = 12;
const ROW_PX = 48;          // px per row; cell height anchor for snap math
const GAP_PX = 8;
const MIN_W = 2;            // minimum block width in cells
const MIN_H = 3;            // minimum block height in cells
const MOBILE_BREAKPOINT = 768;
const LONG_PRESS_MS = 500;  // long-press duration to enter touch-edit mode
const LONG_PRESS_SLOP_PX = 10;  // movement above this aborts the press (treats as scroll)

/**
 * @typedef {Object} BlockRect
 * @property {number} col
 * @property {number} row
 * @property {number} w
 * @property {number} h
 *
 * @typedef {Object} BlockState
 * @property {BlockRect} rect
 * @property {boolean}   visible
 * @property {Object}    settings
 *
 * @typedef {Object} BlockType
 * @property {string}                       id
 * @property {string}                       name
 * @property {(el: HTMLElement) => void}    render
 * @property {(el: HTMLElement, state: BlockState, save: () => void) => void} [renderSettings]
 * @property {BlockRect}                    [defaultRect]
 */

/** @type {Map<string, BlockType>} */
const blockTypes = new Map();
/** @type {Map<string, HTMLElement>} */
const blockEls = new Map();

let root = null;
let drawer = null;
let drawerBody = null;
let drawerTitle = null;
let layout = loadLayout();
let activeSettingsBlockId = null;
let prefersReducedMotion = false;
let isMobile = window.innerWidth < MOBILE_BREAKPOINT;
// `(hover: none) and (pointer: coarse)` is the conventional "real touch
// device" signal — excludes desktop with a touchscreen attached (which
// usually reports `hover: hover`). We use it to gate long-press logic
// without breaking desktop drag/resize.
let isTouch = window.matchMedia?.("(hover: none) and (pointer: coarse)").matches ?? false;
/** @type {string | null} blockId currently in touch edit-mode (null = none) */
let touchEditingId = null;

function loadLayout() {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* corrupt — start fresh */ }
  return {};
}

function saveLayout() {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); }
  catch { /* quota — non-fatal */ }
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function ensureBlockState(typeId, blockId, fallbackRect) {
  if (!layout[blockId]) {
    layout[blockId] = {
      typeId,
      rect: { ...(fallbackRect || { col: 0, row: 0, w: 6, h: 6 }) },
      visible: true,
      settings: { tint: "none", fontScale: 1.0 },
    };
  } else if (!layout[blockId].typeId) {
    layout[blockId].typeId = typeId;   // migration for older layouts
  }
  return layout[blockId];
}

/** Apply a {col,row,w,h} rect to the block element. */
function applyRect(el, rect) {
  if (isMobile) {
    // Mobile: ignore rect, let CSS flow the block in source order.
    el.style.gridColumn = "";
    el.style.gridRow = "";
    return;
  }
  const c = clamp(rect.col, 0, COLS - MIN_W);
  const w = clamp(rect.w, MIN_W, COLS - c);
  const r = Math.max(0, rect.row);
  const h = Math.max(MIN_H, rect.h);
  el.style.gridColumn = `${c + 1} / span ${w}`;
  el.style.gridRow = `${r + 1} / span ${h}`;
}

/** Compute current grid cell metrics (cell width in px). */
function cellMetrics() {
  const r = root.getBoundingClientRect();
  // Effective width minus (COLS-1)*gap, divided by COLS.
  const cellW = (r.width - GAP_PX * (COLS - 1)) / COLS;
  return { cellW, cellH: ROW_PX, gridLeft: r.left, gridTop: r.top };
}

/** Convert a pointer delta in px → cell delta (rounded). */
function pxToCell(dxPx, dyPx) {
  const { cellW, cellH } = cellMetrics();
  return {
    dCol: Math.round(dxPx / (cellW + GAP_PX)),
    dRow: Math.round(dyPx / (cellH + GAP_PX)),
  };
}

/** Build the block chrome (header + content + resize handle). */
function buildBlockEl(type, id, state) {
  const el = document.createElement("section");
  el.className = "block";
  el.dataset.blockId = id;
  el.dataset.blockType = type.id;
  // Stable title id so we can promote <section> to a named landmark
  // region via aria-labelledby. Without an accessible name, <section>
  // has no implicit role for AT users.
  const titleId = `block-title-${id}`;
  el.setAttribute("aria-labelledby", titleId);
  if (!state.visible) el.classList.add("hidden");
  if (state.settings?.tint && state.settings.tint !== "none") {
    el.dataset.tint = state.settings.tint;
  }
  if (state.settings?.fontScale && state.settings.fontScale !== 1.0) {
    el.style.setProperty("--block-font-scale", String(state.settings.fontScale));
  }

  // Header: drag bar (the whole row is grabbable) + title + controls.
  const head = document.createElement("header");
  head.className = "block-header";
  head.dataset.role = "drag-handle";

  const title = document.createElement("span");
  title.className = "block-title";
  title.id = titleId;
  title.textContent = type.name;
  head.appendChild(title);

  // Reorder chevrons — shown only when the block is in touch edit-mode
  // and the dashboard is in single-column stacked mobile layout. On wide
  // viewports the gesture is real drag; on mobile, source-order swap.
  const reorder = document.createElement("div");
  reorder.className = "block-reorder";
  const upBtn = mkIconBtn("reorder-up", "move up", svgChevronUp());
  upBtn.addEventListener("click", (e) => { e.stopPropagation(); reorderBlock(id, -1); });
  reorder.appendChild(upBtn);
  const downBtn = mkIconBtn("reorder-down", "move down", svgChevronDown());
  downBtn.addEventListener("click", (e) => { e.stopPropagation(); reorderBlock(id, +1); });
  reorder.appendChild(downBtn);
  head.appendChild(reorder);

  const ctrls = document.createElement("div");
  ctrls.className = "block-ctrls";

  const gearBtn = mkIconBtn("gear", "settings", svgGear());
  gearBtn.addEventListener("click", (e) => { e.stopPropagation(); openSettings(id); });
  ctrls.appendChild(gearBtn);

  const hideBtn = mkIconBtn("hide", "hide block", svgX());
  hideBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    hideBlock(id);
  });
  ctrls.appendChild(hideBtn);

  head.appendChild(ctrls);
  el.appendChild(head);

  // Content area — block type renders into this.
  const content = document.createElement("div");
  content.className = "block-content";
  el.appendChild(content);

  // Resize handle bottom-right.
  const handle = document.createElement("div");
  handle.className = "block-resize-handle";
  handle.dataset.role = "resize-handle";
  handle.setAttribute("aria-label", "resize block");
  el.appendChild(handle);

  // Wire pointer interactions (no-ops on mobile).
  wireDrag(el, head, id);
  wireResize(el, handle, id);

  return { el, content };
}

function mkIconBtn(cls, label, svgEl) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `block-btn block-btn-${cls}`;
  b.title = label;
  b.setAttribute("aria-label", label);
  b.appendChild(svgEl);
  return b;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function mkSvg(width, height) {
  const s = document.createElementNS(SVG_NS, "svg");
  s.setAttribute("viewBox", "0 0 16 16");
  s.setAttribute("width", String(width));
  s.setAttribute("height", String(height));
  s.setAttribute("aria-hidden", "true");
  return s;
}
function mkPath(attrs) {
  const p = document.createElementNS(SVG_NS, "path");
  for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v);
  return p;
}
function svgGear() {
  const s = mkSvg(14, 14);
  s.appendChild(mkPath({
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    d: "M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM8 1.5v1.5M8 13v1.5M14.5 8H13M3 8H1.5M12.6 3.4l-1 1M4.4 11.6l-1 1M12.6 12.6l-1-1M4.4 4.4l-1-1",
  }));
  return s;
}
function svgX() {
  const s = mkSvg(14, 14);
  s.appendChild(mkPath({
    stroke: "currentColor",
    "stroke-width": "1.4",
    "stroke-linecap": "round",
    d: "M4 4l8 8M12 4l-8 8",
  }));
  return s;
}
function svgChevronUp() {
  const s = mkSvg(14, 14);
  s.appendChild(mkPath({
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.6",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    d: "M3 10 L8 5 L13 10",
  }));
  return s;
}
function svgChevronDown() {
  const s = mkSvg(14, 14);
  s.appendChild(mkPath({
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.6",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    d: "M3 6 L8 11 L13 6",
  }));
  return s;
}

// ---- Drag ----------------------------------------------------------------

function wireDrag(el, handleEl, id) {
  handleEl.addEventListener("pointerdown", (e) => {
    // Only the bar itself, not children with their own click semantics
    // (the gear/hide buttons stop propagation, so this is mostly belt+brace).
    if (e.target.closest(".block-btn")) return;
    if (e.button !== 0) return;

    if (isTouch) {
      // Touch path: long-press promotes the block into edit-mode. On wide
      // touch viewports (tablet) edit-mode also enables free drag. On
      // narrow viewports (phone, single-column) it shows reorder chevrons.
      if (touchEditingId === id) {
        // Already in edit-mode for this block — start drag immediately
        // (only meaningful on non-mobile touch — mobile uses chevrons).
        if (!isMobile) startDrag(e, el, id);
        return;
      }
      startLongPress(e, el, id);
      return;
    }

    if (isMobile) return;   // mouse on a narrow window: no-op
    startDrag(e, el, id);
  });
}

/**
 * Begin a long-press timer on touch. If the finger holds still for
 * LONG_PRESS_MS, the block enters touch edit-mode. If it moves more
 * than LONG_PRESS_SLOP_PX before then, the press is cancelled (treat
 * as a scroll gesture and let the page pan).
 */
function startLongPress(e, el, id) {
  const startX = e.clientX;
  const startY = e.clientY;
  const head = el.querySelector(".block-header");
  if (head) head.classList.add("pressing");

  let cancelled = false;
  const timerId = setTimeout(() => {
    if (cancelled) return;
    cleanup();
    enterTouchEdit(id);
  }, LONG_PRESS_MS);

  function cleanup() {
    if (head) head.classList.remove("pressing");
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onCancel);
    document.removeEventListener("pointercancel", onCancel);
  }
  function onMove(ev) {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (Math.hypot(dx, dy) > LONG_PRESS_SLOP_PX) {
      cancelled = true;
      clearTimeout(timerId);
      cleanup();
    }
  }
  function onCancel() {
    cancelled = true;
    clearTimeout(timerId);
    cleanup();
  }
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onCancel);
  document.addEventListener("pointercancel", onCancel);
}

/** Enter touch edit-mode for a block — exits any previous edit-mode. */
function enterTouchEdit(id) {
  if (touchEditingId && touchEditingId !== id) exitTouchEdit();
  const el = blockEls.get(id);
  if (!el) return;
  el.classList.add("touch-editing");
  touchEditingId = id;
  refreshReorderState(id);
  // Outside-tap dismiss. Wait one frame so the long-press release
  // doesn't fire it.
  requestAnimationFrame(() => {
    document.addEventListener("pointerdown", onTouchEditOutside, true);
  });
}

function exitTouchEdit() {
  if (!touchEditingId) return;
  const el = blockEls.get(touchEditingId);
  if (el) el.classList.remove("touch-editing");
  touchEditingId = null;
  document.removeEventListener("pointerdown", onTouchEditOutside, true);
}

function onTouchEditOutside(e) {
  if (!touchEditingId) return;
  const el = blockEls.get(touchEditingId);
  if (!el) { exitTouchEdit(); return; }
  if (el.contains(e.target)) return;
  exitTouchEdit();
}

/** Re-enable/disable up/down chevrons based on this block's source-order
 *  position relative to visible siblings. */
function refreshReorderState(id) {
  const el = blockEls.get(id);
  if (!el || !root) return;
  const visibleSiblings = Array.from(root.children).filter(
    (n) => n.classList.contains("block") && !n.classList.contains("hidden"),
  );
  const idx = visibleSiblings.indexOf(el);
  const up = el.querySelector(".block-btn-reorder-up");
  const down = el.querySelector(".block-btn-reorder-down");
  if (up) up.toggleAttribute("disabled", idx <= 0);
  if (down) down.toggleAttribute("disabled", idx < 0 || idx >= visibleSiblings.length - 1);
}

/** Swap a block with its neighbor in source order (by flex order index).
 *  Persists by re-numbering the `order` CSS property on all blocks. */
function reorderBlock(id, dir) {
  if (!root) return;
  const el = blockEls.get(id);
  if (!el) return;
  const visibleSiblings = Array.from(root.children).filter(
    (n) => n.classList.contains("block") && !n.classList.contains("hidden"),
  );
  const idx = visibleSiblings.indexOf(el);
  const target = idx + dir;
  if (idx < 0 || target < 0 || target >= visibleSiblings.length) return;

  // Swap DOM order (also drives CSS flex order). Persist as state.order on
  // each block so a reload restores the same arrangement.
  if (dir < 0) {
    root.insertBefore(el, visibleSiblings[target]);
  } else {
    root.insertBefore(el, visibleSiblings[target].nextSibling);
  }
  // Renumber `style.order` and persist into layout[id].order for restore.
  const allBlocks = Array.from(root.children).filter((n) => n.classList.contains("block"));
  allBlocks.forEach((node, i) => {
    node.style.order = String(i);
    const bid = node.dataset.blockId;
    if (bid && layout[bid]) layout[bid].order = i;
  });
  saveLayout();
  refreshReorderState(id);
}

function startDrag(e, el, id) {
  const state = layout[id];
  if (!state) return;
  const startRect = { ...state.rect };
  const startX = e.clientX;
  const startY = e.clientY;
  const ghost = mkGhost(state.rect);
  root.appendChild(ghost);
  el.classList.add("dragging");
  handleEl_capture(e);

  function onMove(ev) {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    const { dCol, dRow } = pxToCell(dx, dy);
    const newRect = {
      col: clamp(startRect.col + dCol, 0, COLS - startRect.w),
      row: Math.max(0, startRect.row + dRow),
      w: startRect.w,
      h: startRect.h,
    };
    ghost.style.gridColumn = `${newRect.col + 1} / span ${newRect.w}`;
    ghost.style.gridRow = `${newRect.row + 1} / span ${newRect.h}`;
    ghost.dataset.pendingRect = JSON.stringify(newRect);
  }
  function onUp() {
    el.classList.remove("dragging");
    const pending = ghost.dataset.pendingRect ? JSON.parse(ghost.dataset.pendingRect) : null;
    ghost.remove();
    if (pending) {
      state.rect = pending;
      applyRect(el, pending);
      saveLayout();
    }
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
  }
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onUp);
}

function handleEl_capture(e) {
  try { e.target.setPointerCapture?.(e.pointerId); } catch { /* harmless */ }
}

function mkGhost(rect) {
  const g = document.createElement("div");
  g.className = "block-ghost";
  g.style.gridColumn = `${rect.col + 1} / span ${rect.w}`;
  g.style.gridRow = `${rect.row + 1} / span ${rect.h}`;
  return g;
}

// ---- Resize --------------------------------------------------------------

function wireResize(el, handle, id) {
  handle.addEventListener("pointerdown", (e) => {
    if (isMobile) return;
    if (e.button !== 0) return;
    // On touch (tablet), resize requires edit-mode first to prevent
    // accidental resize during normal interaction with block content.
    if (isTouch && touchEditingId !== id) return;
    e.stopPropagation();
    startResize(e, el, id);
  });
}

function startResize(e, el, id) {
  const state = layout[id];
  if (!state) return;
  const startRect = { ...state.rect };
  const startX = e.clientX;
  const startY = e.clientY;
  const ghost = mkGhost(state.rect);
  root.appendChild(ghost);
  el.classList.add("resizing");
  handleEl_capture(e);

  function onMove(ev) {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    const { dCol, dRow } = pxToCell(dx, dy);
    const newRect = {
      col: startRect.col,
      row: startRect.row,
      w: clamp(startRect.w + dCol, MIN_W, COLS - startRect.col),
      h: Math.max(MIN_H, startRect.h + dRow),
    };
    ghost.style.gridColumn = `${newRect.col + 1} / span ${newRect.w}`;
    ghost.style.gridRow = `${newRect.row + 1} / span ${newRect.h}`;
    ghost.dataset.pendingRect = JSON.stringify(newRect);
  }
  function onUp() {
    el.classList.remove("resizing");
    const pending = ghost.dataset.pendingRect ? JSON.parse(ghost.dataset.pendingRect) : null;
    ghost.remove();
    if (pending) {
      state.rect = pending;
      applyRect(el, pending);
      saveLayout();
    }
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
  }
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onUp);
}

// ---- Settings drawer -----------------------------------------------------

function ensureDrawer() {
  if (drawer) return;
  drawer = document.createElement("aside");
  drawer.className = "block-settings-drawer";
  drawer.hidden = true;
  // Modal dialog semantics. role + aria-modal + aria-labelledby make
  // screen readers announce "settings dialog, <block-name> settings"
  // when focus enters, matching the visual modal affordance (scrim,
  // focus trap, Esc-close).
  drawer.setAttribute("role", "dialog");
  drawer.setAttribute("aria-modal", "true");

  const head = document.createElement("header");
  head.className = "block-settings-head";
  drawerTitle = document.createElement("span");
  drawerTitle.className = "block-settings-title";
  drawerTitle.id = "block-settings-title";
  drawerTitle.textContent = "settings";
  drawer.setAttribute("aria-labelledby", drawerTitle.id);
  head.appendChild(drawerTitle);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "block-btn block-btn-close-drawer";
  closeBtn.setAttribute("aria-label", "close settings");
  closeBtn.title = "close";
  closeBtn.appendChild(svgX());
  closeBtn.addEventListener("click", closeSettings);
  head.appendChild(closeBtn);

  drawer.appendChild(head);

  drawerBody = document.createElement("div");
  drawerBody.className = "block-settings-body";
  drawer.appendChild(drawerBody);

  document.body.appendChild(drawer);
  // Click-outside dismiss.
  document.addEventListener("pointerdown", (e) => {
    if (!drawer || drawer.hidden) return;
    if (drawer.contains(e.target)) return;
    if (e.target.closest('.block-btn-gear')) return;
    closeSettings();
  });
  // Escape dismiss + Tab focus trap (#65).
  document.addEventListener("keydown", (e) => {
    if (!drawer || drawer.hidden) return;
    if (e.key === "Escape") { e.stopPropagation(); closeSettings(); return; }
    trapDrawerFocus(e);
  });
}

function openSettings(blockId) {
  ensureDrawer();
  const state = layout[blockId];
  if (!state) return;
  const type = blockTypes.get(state.typeId);
  if (!type) return;
  activeSettingsBlockId = blockId;
  drawerTitle.textContent = `${type.name} · settings`;
  while (drawerBody.firstChild) drawerBody.removeChild(drawerBody.firstChild);

  // Common settings (apply to all blocks).
  drawerBody.appendChild(buildCommonSettings(blockId, state));

  // Per-block settings (block-type opt-in).
  if (type.renderSettings) {
    const customWrap = document.createElement("div");
    customWrap.className = "block-settings-section";
    const heading = document.createElement("h4");
    heading.textContent = "block options";
    customWrap.appendChild(heading);
    const customBody = document.createElement("div");
    customWrap.appendChild(customBody);
    drawerBody.appendChild(customWrap);
    try {
      type.renderSettings(customBody, state, () => { saveLayout(); applyCommonStyling(blockId); });
    } catch (err) {
      console.error(`[dashboard] renderSettings for ${type.id} threw:`, err);
    }
  }

  drawer.hidden = false;
  // Remember which element to return focus to on close (#65).
  drawer._returnFocus = document.activeElement;
  requestAnimationFrame(() => {
    drawer.classList.add("open");
    // Move keyboard focus into the drawer — close button is the
    // safest first stop because it's always present and pressing
    // Enter on it cleanly dismisses. Settings inputs receive Tab.
    const firstInput = drawer.querySelector("input, select, textarea, button");
    if (firstInput) firstInput.focus();
  });
}

/**
 * Focus trap for the settings drawer (#65). Tab + Shift-Tab wrap
 * around the drawer's focusable children when the drawer is open.
 */
function trapDrawerFocus(e) {
  if (!drawer || drawer.hidden) return;
  if (e.key !== "Tab") return;
  const focusables = drawer.querySelectorAll(
    'input, select, textarea, button, a[href], [tabindex]:not([tabindex="-1"])',
  );
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function closeSettings() {
  if (!drawer) return;
  drawer.classList.remove("open");
  // Return focus to the gear that opened us, so keyboard users keep their place.
  const returnTo = drawer._returnFocus;
  drawer._returnFocus = null;
  // Wait for transition unless reduced-motion (in which case it's instant).
  const dur = prefersReducedMotion ? 0 : 220;
  setTimeout(() => {
    if (drawer) drawer.hidden = true;
    if (returnTo && typeof returnTo.focus === "function") returnTo.focus();
  }, dur);
  activeSettingsBlockId = null;
}

function buildCommonSettings(blockId, state) {
  const wrap = document.createElement("div");
  wrap.className = "block-settings-section";
  const heading = document.createElement("h4");
  heading.textContent = "appearance";
  wrap.appendChild(heading);

  // Visibility toggle.
  const visRow = mkRow("visible");
  const visInput = document.createElement("input");
  visInput.type = "checkbox";
  visInput.checked = !!state.visible;
  visInput.addEventListener("change", () => {
    state.visible = visInput.checked;
    const el = blockEls.get(blockId);
    if (el) el.classList.toggle("hidden", !state.visible);
    saveLayout();
  });
  visRow.appendChild(visInput);
  wrap.appendChild(visRow);

  // Tint.
  const tintRow = mkRow("tint");
  const tintSel = document.createElement("select");
  for (const opt of ["none", "warm", "cool"]) {
    const o = document.createElement("option");
    o.value = opt; o.textContent = opt;
    tintSel.appendChild(o);
  }
  tintSel.value = state.settings?.tint || "none";
  tintSel.addEventListener("change", () => {
    state.settings = { ...(state.settings || {}), tint: tintSel.value };
    applyCommonStyling(blockId);
    saveLayout();
  });
  tintRow.appendChild(tintSel);
  wrap.appendChild(tintRow);

  // Font scale.
  const scaleRow = mkRow("font scale");
  const scaleSel = document.createElement("select");
  for (const opt of [0.85, 1.0, 1.15]) {
    const o = document.createElement("option");
    o.value = String(opt); o.textContent = `${Math.round(opt * 100)}%`;
    scaleSel.appendChild(o);
  }
  scaleSel.value = String(state.settings?.fontScale ?? 1.0);
  scaleSel.addEventListener("change", () => {
    state.settings = { ...(state.settings || {}), fontScale: parseFloat(scaleSel.value) };
    applyCommonStyling(blockId);
    saveLayout();
  });
  scaleRow.appendChild(scaleSel);
  wrap.appendChild(scaleRow);

  return wrap;
}

function applyCommonStyling(blockId) {
  const el = blockEls.get(blockId);
  const state = layout[blockId];
  if (!el || !state) return;
  if (state.settings?.tint && state.settings.tint !== "none") {
    el.dataset.tint = state.settings.tint;
  } else {
    delete el.dataset.tint;
  }
  if (state.settings?.fontScale && state.settings.fontScale !== 1.0) {
    el.style.setProperty("--block-font-scale", String(state.settings.fontScale));
  } else {
    el.style.removeProperty("--block-font-scale");
  }
}

function mkRow(labelText) {
  const r = document.createElement("label");
  r.className = "block-settings-row";
  const l = document.createElement("span");
  l.className = "block-settings-row-label";
  l.textContent = labelText;
  r.appendChild(l);
  return r;
}

// ---- Public API ----------------------------------------------------------

/** @param {BlockType} type */
function registerBlockType(type) {
  if (!type || !type.id || typeof type.render !== "function") {
    throw new Error("registerBlockType: { id, name, render } required");
  }
  blockTypes.set(type.id, type);
}

/**
 * Mount the dashboard. Creates one block per registered type (using
 * defaultRect or saved rect from localStorage).
 *
 * @param {HTMLElement} rootEl  the `<main class="dashboard">` element.
 */
function mount(rootEl) {
  root = rootEl;
  root.classList.add("dashboard");
  prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  window.matchMedia?.("(prefers-reduced-motion: reduce)")?.addEventListener?.("change", (e) => {
    prefersReducedMotion = e.matches;
  });

  // Mobile reflow on resize.
  let resizeT = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => {
      const wasMobile = isMobile;
      isMobile = window.innerWidth < MOBILE_BREAKPOINT;
      if (wasMobile !== isMobile) {
        // Exit any lingering touch-edit so its outline doesn't leak across
        // the layout swap.
        exitTouchEdit();
        for (const [id, el] of blockEls) {
          const state = layout[id];
          if (state) applyRect(el, state.rect);
        }
      }
    }, 100);
  });

  // Touch capability can flip on hybrid devices (Surface, iPad with mouse).
  const touchMQ = window.matchMedia?.("(hover: none) and (pointer: coarse)");
  touchMQ?.addEventListener?.("change", (e) => {
    isTouch = e.matches;
    if (!isTouch) exitTouchEdit();
  });

  // Instantiate one block per registered type. Skip any types we have no
  // rect for AND that opted out of a default (defaultRect: null).
  // Sort by saved `order` if present so reorder chevrons persist across
  // reloads; fall back to registration order.
  const types = Array.from(blockTypes.values());
  types.sort((a, b) => {
    const ao = layout[a.id]?.order;
    const bo = layout[b.id]?.order;
    if (typeof ao === "number" && typeof bo === "number") return ao - bo;
    if (typeof ao === "number") return -1;
    if (typeof bo === "number") return 1;
    return 0;
  });
  let order = 0;
  for (const type of types) {
    const id = type.id;
    const state = ensureBlockState(type.id, id, type.defaultRect);
    const { el, content } = buildBlockEl(type, id, state);
    applyRect(el, state.rect);
    el.style.order = String(order);   // mobile: source order
    state.order = order;
    order++;
    blockEls.set(id, el);
    root.appendChild(el);
    try { type.render(content); }
    catch (err) { console.error(`[dashboard] render for ${type.id} threw:`, err); }
  }

  saveLayout();   // persist any defaults that were synthesized
}

function resetLayout() {
  layout = {};
  saveLayout();
  // Reload to rebuild blocks from defaults.
  window.location.reload();
}

/** Apply a named preset layout (rect map by type id). Reloads to remount. */
function applyPreset(presetId) {
  const preset = PRESETS[presetId];
  if (!preset) return;
  const next = {};
  for (const type of blockTypes.values()) {
    const rect = preset[type.id] || type.defaultRect || { col: 0, row: 0, w: 6, h: 6 };
    const visible = preset[type.id] !== false;   // explicit false hides
    next[type.id] = {
      typeId: type.id,
      rect: { ...rect },
      visible,
      settings: layout[type.id]?.settings || { tint: "none", fontScale: 1.0 },
    };
  }
  layout = next;
  saveLayout();
  window.location.reload();
}

/** Toggle a hidden block back on (used by an "add block" menu). */
function showBlock(blockId) {
  const state = layout[blockId];
  const el = blockEls.get(blockId);
  if (!state || !el) return;
  state.visible = true;
  el.classList.remove("hidden");
  // Enter choreography — strip any leftover .block-leaving and play the
  // fade+scale. Reduced motion: animation is no-op via CSS media query.
  el.classList.remove("block-leaving");
  el.classList.add("block-entering");
  const cleanup = () => el.classList.remove("block-entering");
  el.addEventListener("animationend", cleanup, { once: true });
  // Belt-and-braces in case animation never runs (e.g. reduced motion).
  setTimeout(cleanup, 320);
  saveLayout();
}

/** Hide a block (same as the header X — keeps state for re-add). */
function hideBlock(blockId) {
  const state = layout[blockId];
  const el = blockEls.get(blockId);
  if (!state || !el) return;
  if (touchEditingId === blockId) exitTouchEdit();
  state.visible = false;
  // Exit choreography — play the reverse, then commit display:none. Reduced
  // motion skips the wait via CSS (animation: none → animationend never fires,
  // so we fall back to the timeout cleanup).
  el.classList.add("block-leaving");
  const finish = () => {
    el.classList.remove("block-leaving");
    el.classList.add("hidden");
  };
  el.addEventListener("animationend", finish, { once: true });
  setTimeout(finish, 250);
  saveLayout();
}

/** All registered types with their current visibility. */
function listTypes() {
  return Array.from(blockTypes.values()).map((t) => ({
    id: t.id,
    name: t.name,
    visible: !!layout[t.id]?.visible,
    registered: true,
  }));
}

/** Built-in layout presets — rect map keyed by block-type id. */
const PRESETS = {
  default: {
    chat:         { col: 0, row: 0,  w: 8,  h: 12 },
    palace:       { col: 0, row: 12, w: 12, h: 14 },
    model:        { col: 8, row: 0,  w: 4,  h: 6  },
    "slot-picker":{ col: 8, row: 6,  w: 4,  h: 10 },
    "stats-gpu":  { col: 8, row: 16, w: 4,  h: 6  },
    "stats-cpu":  { col: 0, row: 26, w: 4,  h: 6  },
    "stats-mem":  { col: 4, row: 26, w: 4,  h: 6  },
    "stats-disk": { col: 8, row: 26, w: 4,  h: 6  },
    "stats-net":  { col: 0, row: 32, w: 6,  h: 6  },
  },
  compact: {
    chat:         { col: 0, row: 0,  w: 12, h: 10 },
    palace:       { col: 0, row: 10, w: 12, h: 10 },
    model:        { col: 0, row: 20, w: 4,  h: 4  },
    "slot-picker":{ col: 4, row: 20, w: 4,  h: 6  },
    "stats-gpu":  { col: 8, row: 20, w: 4,  h: 5  },
    "stats-cpu":  { col: 0, row: 26, w: 3,  h: 4  },
    "stats-mem":  { col: 3, row: 26, w: 3,  h: 4  },
    "stats-disk": { col: 6, row: 26, w: 3,  h: 4  },
    "stats-net":  { col: 9, row: 26, w: 3,  h: 4  },
  },
  "data-dense": {
    chat:         { col: 0, row: 0,  w: 6,  h: 14 },
    palace:       { col: 0, row: 14, w: 12, h: 12 },
    model:        false,   // hidden — picker covers it
    "slot-picker":{ col: 6, row: 0,  w: 3,  h: 14 },
    "stats-gpu":  { col: 9, row: 0,  w: 3,  h: 5  },
    "stats-cpu":  { col: 9, row: 5,  w: 3,  h: 5  },
    "stats-mem":  { col: 9, row: 10, w: 3,  h: 4  },
    "stats-disk": { col: 0, row: 26, w: 6,  h: 4  },
    "stats-net":  { col: 6, row: 26, w: 6,  h: 4  },
  },
  // Mobile-stack: full-width per block, stacked top-to-bottom. CSS already
  // does this at <768px viewports; this preset lets desktop operators
  // preview the mobile experience without resizing the window.
  "mobile-stack": {
    chat:         { col: 0, row: 0,  w: 12, h: 10 },
    palace:       { col: 0, row: 10, w: 12, h: 12 },
    model:        { col: 0, row: 22, w: 12, h: 5  },
    "slot-picker":{ col: 0, row: 27, w: 12, h: 8  },
    "stats-gpu":  { col: 0, row: 35, w: 12, h: 5  },
    "stats-cpu":  { col: 0, row: 40, w: 12, h: 4  },
    "stats-mem":  { col: 0, row: 44, w: 12, h: 4  },
    "stats-disk": { col: 0, row: 48, w: 12, h: 4  },
    "stats-net":  { col: 0, row: 52, w: 12, h: 5  },
  },
};

export const dashboard = {
  registerBlockType,
  mount,
  resetLayout,
  applyPreset,
  presets: Object.keys(PRESETS),
  showBlock,
  hideBlock,
  listTypes,
  // Surfaced for the future "add block" picker.
  listBlocks() {
    return Array.from(blockEls.keys()).map((id) => ({
      id,
      typeId: layout[id]?.typeId,
      visible: !!layout[id]?.visible,
    }));
  },
};

// Also expose on window for non-module consumers / debug.
if (typeof window !== "undefined") window.familiarDashboard = dashboard;
