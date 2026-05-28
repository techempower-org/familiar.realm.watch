// Slot picker block — model/GPU selector for familiar's five inference slots.
//
// Conforms to Reverie's dashboard.registerBlockType contract:
//   { id, name, render(el), renderSettings(el, state, save), defaultRect }
// (See web/dashboard.js for the public API. render() receives the inner
// content area; chrome is owned by the framework.)
//
// Backend contract (Sandman / PR #55, feat/slot-picker):
//   GET  /api/familiar/slots
//        → { registry, slots, gpu_usage }
//   PATCH /api/familiar/admin/slots/:slot   body { variant_id: string|null }
//        → 200 | 400 | 403 | 409 (vram overflow) | 503 (health/startup failure)
//
// PATCH may take up to ~30s (model startup / nvidia warmup); we keep the
// pulse running for the full duration — no client-side timeout.

import { dashboard } from "../dashboard.js";
import { sound } from "./sound.js";

const SLOT_ORDER = ["chat", "embed", "extract", "hyde", "reflect"];
const NULLABLE_SLOTS = new Set(["hyde", "reflect"]);
const ERROR_TINT_MS = 4000;
const POLL_INTERVAL_MS = 15_000;
const VRAM_AMBER_FRACTION = 0.85;

const DEFAULTS = {
  showDisabled: true,
  compact: false,
};

// Each mounted block keeps its own poller + DOM refs so settings repaints
// don't need a network round-trip.
const instances = new WeakMap();

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

async function fetchSnapshot(signal) {
  const r = await fetch("/api/familiar/slots", {
    headers: { accept: "application/json" },
    signal,
  });
  if (!r.ok) throw new Error(`GET /api/familiar/slots → ${r.status}`);
  return await r.json();
}

async function patchSlot(slot, variantId, signal) {
  const r = await fetch(`/api/familiar/admin/slots/${encodeURIComponent(slot)}`, {
    method: "PATCH",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ variant_id: variantId }),
    signal,
  });
  let body = null;
  try { body = await r.json(); } catch { /* may be empty on some errors */ }
  return { status: r.status, ok: r.ok, body };
}

function variantsFor(slot, registry) {
  if (!registry || !Array.isArray(registry.variants)) return [];
  return registry.variants.filter((v) =>
    Array.isArray(v.capabilities) && v.capabilities.includes(slot)
  );
}

function findVariant(registry, id) {
  if (!registry || !id) return null;
  return registry.variants.find((v) => v.id === id) ?? null;
}

function paintInto(host, state, snapshot, expanded, pending, errors) {
  host.replaceChildren();
  host.classList.add("slot-picker");
  host.classList.toggle("slot-picker--compact", !!state.settings.compact);

  const head = el("div", "slot-picker-head");
  head.appendChild(el("span", "slot-picker-title", "Slots"));
  head.appendChild(el("span", "slot-picker-sub", "SLOTS"));
  host.appendChild(head);

  if (!snapshot) {
    host.appendChild(el("div", "slot-empty", "loading…"));
    return;
  }
  if (snapshot._error) {
    const e = el("div", "slot-empty slot-empty--error", snapshot._error);
    host.appendChild(e);
    return;
  }

  const { registry, slots, gpu_usage } = snapshot;
  if (!slots || !slots.slots) {
    host.appendChild(el("div", "slot-empty", "no slots reported"));
    return;
  }

  const list = el("div", "slot-list");
  for (const slot of SLOT_ORDER) {
    const binding = slots.slots[slot];
    if (!binding) continue;
    const isOff = binding.variant_id === null;
    if (isOff && !state.settings.showDisabled && NULLABLE_SLOTS.has(slot)) continue;

    const variant = findVariant(registry, binding.variant_id);
    const row = el("section", "slot-row");
    row.dataset.slot = slot;
    if (expanded.slot === slot) row.classList.add("slot-row--expanded");
    if (pending.slot === slot) row.classList.add("slot-row--pending");
    const err = errors.get(slot);
    if (err) {
      row.classList.add(err.kind === "conflict" ? "slot-row--conflict" : "slot-row--error");
      row.title = err.message;
    }

    const head2 = el("button", "slot-row-head");
    head2.type = "button";
    head2.setAttribute("aria-expanded", String(expanded.slot === slot));
    head2.addEventListener("click", () => {
      const inst = instances.get(host);
      if (!inst) return;
      inst.expanded.slot = (inst.expanded.slot === slot) ? null : slot;
      inst.repaint();
    });

    const accent = el("span", "slot-row-accent");
    head2.appendChild(accent);

    const text = el("div", "slot-row-text");
    text.appendChild(el("div", "slot-row-name", slot));
    if (!state.settings.compact) {
      const sub = el("div", "slot-row-variant");
      if (isOff) {
        const off = el("span", "slot-row-off", "Off");
        sub.appendChild(off);
      } else if (variant) {
        sub.textContent = variant.id;
      } else if (binding.variant_id) {
        sub.textContent = `${binding.variant_id} (unknown)`;
        sub.classList.add("slot-row-variant--missing");
      }
      text.appendChild(sub);
    }
    head2.appendChild(text);

    if (pending.slot === slot) {
      const dots = el("span", "slot-pulse", null);
      dots.setAttribute("aria-label", "applying change");
      for (let i = 0; i < 3; i++) dots.appendChild(el("span", "slot-pulse-dot"));
      head2.appendChild(dots);
    } else if (variant && !state.settings.compact) {
      const meta = el("span", "slot-row-meta");
      const gpuLabel = variant.gpu === null ? "cpu" : `gpu${variant.gpu}`;
      meta.textContent = `${gpuLabel} · ${formatVram(variant.vram_mb)}`;
      head2.appendChild(meta);
    }

    row.appendChild(head2);

    if (expanded.slot === slot) {
      const options = variantsFor(slot, registry);
      const drop = el("div", "slot-variant-list");
      drop.setAttribute("role", "listbox");

      if (NULLABLE_SLOTS.has(slot)) {
        drop.appendChild(buildVariantOption(host, slot, null, binding.variant_id, pending));
        drop.appendChild(el("div", "slot-variant-divider"));
      }
      if (!options.length) {
        drop.appendChild(el("div", "slot-empty", "no compatible variants registered"));
      } else {
        for (const v of options) {
          drop.appendChild(buildVariantOption(host, slot, v, binding.variant_id, pending));
        }
      }

      if (err) {
        const tip = el("div", "slot-row-errtip");
        tip.textContent = err.message;
        drop.appendChild(tip);
      }
      row.appendChild(drop);
    }

    list.appendChild(row);
  }
  host.appendChild(list);

  // GPU usage footer
  if (Array.isArray(gpu_usage) && gpu_usage.length) {
    const foot = el("div", "slot-vram-foot");
    for (const u of gpu_usage) {
      if (u.gpu === "cpu") continue;
      foot.appendChild(buildVramBar(u));
    }
    if (foot.childElementCount) host.appendChild(foot);
  }
}

function buildVariantOption(host, slot, variant, currentVariantId, pending) {
  const isOff = variant === null;
  const selected = isOff
    ? (currentVariantId === null)
    : (currentVariantId === variant.id);
  const targetId = isOff ? null : variant.id;

  const opt = el("button", "slot-variant-opt");
  opt.type = "button";
  opt.setAttribute("role", "option");
  opt.setAttribute("aria-selected", String(selected));
  if (selected) opt.classList.add("slot-variant-opt--selected");
  if (isOff) opt.classList.add("slot-variant-opt--off");

  const accent = el("span", "slot-variant-accent");
  opt.appendChild(accent);

  const text = el("div", "slot-variant-text");
  if (isOff) {
    text.appendChild(el("div", "slot-variant-label slot-variant-off-label", "Off"));
    text.appendChild(el("div", "slot-variant-sub", "disable this slot"));
  } else {
    text.appendChild(el("div", "slot-variant-label", variant.label || variant.id));
    const sub = el("div", "slot-variant-sub");
    const gpuLabel = variant.gpu === null ? "cpu" : `gpu${variant.gpu}`;
    const ctxLabel = variant.context ? ` · ${formatCtx(variant.context)} ctx` : "";
    sub.textContent = `${variant.id} · ${gpuLabel} · ${formatVram(variant.vram_mb)}${ctxLabel}`;
    text.appendChild(sub);
  }
  opt.appendChild(text);

  // Click commit. Disabled while any PATCH is in flight (single-slot mutex
  // mirrors the server's serialized chain).
  opt.disabled = !!pending.slot;
  opt.addEventListener("click", () => {
    if (selected) return;
    const inst = instances.get(host);
    if (!inst) return;
    inst.commitChange(slot, targetId);
  });

  return opt;
}

function buildVramBar(usage) {
  const total = Math.max(1, usage.total_mb || 0);
  const usedPct = Math.max(0, Math.min(100, (usage.used_mb / total) * 100));
  const overAmber = usage.used_mb >= usage.budget_mb * VRAM_AMBER_FRACTION;

  const wrap = el("div", "slot-vram-row");
  wrap.classList.toggle("slot-vram-row--amber", overAmber);

  const label = el("div", "slot-vram-label", `gpu${usage.gpu}`);
  wrap.appendChild(label);

  const bar = el("div", "slot-vram-bar");
  const fill = el("div", "slot-vram-bar-fill");
  fill.style.width = `${usedPct.toFixed(1)}%`;
  bar.appendChild(fill);
  wrap.appendChild(bar);

  const meta = el("div", "slot-vram-meta");
  meta.textContent = `${formatVram(usage.used_mb)} / ${formatVram(usage.budget_mb)}`;
  meta.title = `total ${formatVram(usage.total_mb)} · budget ${formatVram(usage.budget_mb)}`;
  wrap.appendChild(meta);
  return wrap;
}

function formatVram(mb) {
  if (mb == null) return "—";
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}
function formatCtx(n) {
  if (n >= 1024) return `${Math.round(n / 1024)}k`;
  return String(n);
}

function describeError(status, body) {
  if (status === 409 && body) {
    return {
      kind: "conflict",
      message: `VRAM budget exceeded on GPU ${body.gpu} — would use ${formatVram(body.would_use_mb)} of ${formatVram(body.budget_mb)} (total ${formatVram(body.total_mb)})`,
    };
  }
  if (status === 403) {
    return { kind: "error", message: body?.error || "Slots admin disabled (FAMILIAR_SLOTS_ADMIN != true)" };
  }
  if (status === 400) {
    return { kind: "error", message: body?.error || "Bad request" };
  }
  if (status === 503 && body) {
    const detail = body.last_error ? ` — ${body.last_error}` : "";
    return {
      kind: "error",
      message: `Health check failed for "${body.variant_id || ""}"${detail} (reverted)`,
    };
  }
  return { kind: "error", message: body?.error || `Request failed (${status})` };
}

function render(host) {
  host.classList.add("block-content-slot-picker");

  // Settings come from layout state — readable via getSettings if Reverie
  // hands us a ctx (future); for now we read it once at mount and the
  // settings drawer mutates this object in place.
  const state = { settings: { ...DEFAULTS } };
  // The framework calls render() before renderSettings, with the same
  // state object live across both; we keep a fresh defaults baseline.
  // Subsequent settings updates will trigger a repaint via inst.repaint().

  let snapshot = null;
  let abortInflight = null;
  const expanded = { slot: null };
  const pending = { slot: null };
  const errors = new Map();
  const errorTimers = new Map();
  let pollTimer = null;
  let detachReducedMotion = null;

  const repaint = () => paintInto(host, state, snapshot, expanded, pending, errors);

  async function loadSnapshot() {
    try {
      abortInflight?.abort();
      const controller = new AbortController();
      abortInflight = controller;
      const data = await fetchSnapshot(controller.signal);
      snapshot = data;
      repaint();
    } catch (err) {
      if (err && err.name === "AbortError") return;
      snapshot = { _error: `unable to reach slot service — ${err.message || err}` };
      repaint();
    }
  }

  async function commitChange(slot, variantId) {
    if (pending.slot) return;
    if (!snapshot || !snapshot.slots) return;
    const priorBinding = snapshot.slots.slots[slot]?.variant_id ?? null;
    if (priorBinding === variantId) return;

    pending.slot = slot;
    errors.delete(slot);
    clearErrorTimer(slot);
    repaint();

    try {
      const result = await patchSlot(slot, variantId);
      pending.slot = null;
      if (result.ok && result.body && result.body.ok) {
        // Optimistic local update; refresh to pick up usage shifts.
        snapshot.slots.slots[slot] = { variant_id: variantId };
        repaint();
        flashRowSuccess(slot);
        sound.chime();
        loadSnapshot();
      } else {
        const e = describeError(result.status, result.body || {});
        errors.set(slot, e);
        scheduleErrorClear(slot);
        sound.thunk();
        // State stays at priorBinding (we never wrote the new value to snapshot.slots).
        repaint();
      }
    } catch (err) {
      pending.slot = null;
      errors.set(slot, { kind: "error", message: err?.message || String(err) });
      scheduleErrorClear(slot);
      sound.thunk();
      repaint();
    }
  }

  // Brief gold-wash animation across the row that just committed. The
  // .slot-row--success class adds a transient overlay (CSS keyframes); we
  // strip it after the animation ends so it can play again on the next
  // commit.
  function flashRowSuccess(slot) {
    // Find the row in the next paint frame — `repaint()` above has just
    // rebuilt the DOM synchronously, so we can query right now.
    const row = host.querySelector(`.slot-row[data-slot="${slot}"]`);
    if (!row) return;
    row.classList.add("slot-row--success");
    const cleanup = () => row.classList.remove("slot-row--success");
    row.addEventListener("animationend", cleanup, { once: true });
    setTimeout(cleanup, 900);   // belt + braces for reduced-motion path
  }

  function scheduleErrorClear(slot) {
    clearErrorTimer(slot);
    const t = setTimeout(() => {
      errors.delete(slot);
      errorTimers.delete(slot);
      repaint();
    }, ERROR_TINT_MS);
    errorTimers.set(slot, t);
  }
  function clearErrorTimer(slot) {
    const t = errorTimers.get(slot);
    if (t) clearTimeout(t);
    errorTimers.delete(slot);
  }

  instances.set(host, {
    state,
    expanded,
    pending,
    repaint,
    commitChange,
    setSettings(next) {
      state.settings = { ...DEFAULTS, ...next };
      host.classList.toggle("slot-picker--compact", !!state.settings.compact);
      repaint();
    },
    destroy() {
      abortInflight?.abort();
      if (pollTimer) clearInterval(pollTimer);
      for (const t of errorTimers.values()) clearTimeout(t);
      detachReducedMotion?.();
    },
  });

  // Render once with the empty snapshot so the block shows "loading…"
  // instead of a flash of nothing.
  repaint();
  loadSnapshot();

  pollTimer = setInterval(loadSnapshot, POLL_INTERVAL_MS);

  // Refresh on window focus — the slot binding may have changed in another
  // tab or via a sysadmin's curl PATCH.
  const onFocus = () => loadSnapshot();
  window.addEventListener("focus", onFocus);
  detachReducedMotion = () => window.removeEventListener("focus", onFocus);
}

function renderSettings(host, layoutState, save) {
  // layoutState.settings is the persisted bag from the framework.
  if (!layoutState.settings) layoutState.settings = {};
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (!(k in layoutState.settings)) layoutState.settings[k] = v;
  }
  const s = layoutState.settings;

  // Sync the live block instance whenever settings change.
  function syncLive() {
    const block = host.closest(".block");
    const content = block?.querySelector(".block-content-slot-picker");
    if (!content) return;
    const inst = instances.get(content);
    if (inst) inst.setSettings({ ...s });
  }

  const wrap = el("div", "slot-picker-settings");

  wrap.appendChild(checkRow("Show disabled slots", !!s.showDisabled, (v) => {
    s.showDisabled = v; save(); syncLive();
  }));
  wrap.appendChild(checkRow("Compact mode", !!s.compact, (v) => {
    s.compact = v; save(); syncLive();
  }));

  host.appendChild(wrap);
}

function checkRow(label, checked, onChange) {
  const row = el("label", "slot-picker-setting-row");
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.className = "slot-picker-setting-check";
  cb.checked = checked;
  cb.addEventListener("change", () => onChange(cb.checked));
  row.appendChild(cb);
  row.appendChild(el("span", "slot-picker-setting-label", label));
  return row;
}

dashboard.registerBlockType({
  id: "slot-picker",
  name: "slots",
  defaultRect: { col: 8, row: 6, w: 4, h: 10 },
  render,
  renderSettings,
});
