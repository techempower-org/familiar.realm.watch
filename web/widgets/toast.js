// Minimal toast/notification module (#79).
//
// Usage:
//   import { toast } from "/widgets/toast.js";
//   toast.info("layout reset");
//   toast.success("slot swapped");
//   toast.warn("palace slow");
//   toast.error("network error");
//
// Behavior:
// - Bottom-right floating stack, max 3 visible at once.
// - 3s auto-dismiss; click to dismiss earlier.
// - aria-live=polite so assistive tech picks them up.
// - Variants tint via existing CSS custom properties: --accent (info /
//   success), --color-warn, --color-error.
// - prefers-reduced-motion zeros the slide animation; toasts still fade.

const MAX_VISIBLE = 3;
const DEFAULT_TTL_MS = 3000;

let host = null;
const queue = [];

function ensureHost() {
  if (host) return host;
  host = document.createElement("div");
  host.className = "toast-host";
  host.setAttribute("role", "status");
  host.setAttribute("aria-live", "polite");
  document.body.appendChild(host);
  return host;
}

function show(variant, message, opts = {}) {
  const h = ensureHost();
  const t = document.createElement("button");
  t.type = "button";
  t.className = `toast toast-${variant}`;
  t.textContent = message;
  t.setAttribute("aria-label", `dismiss notification: ${message}`);
  h.appendChild(t);
  queue.push(t);

  // Cap visible count: pop the oldest if we exceed.
  while (queue.length > MAX_VISIBLE) {
    const old = queue.shift();
    old?.remove();
  }

  // Slide-in (CSS animation triggers off `.show` class).
  requestAnimationFrame(() => t.classList.add("show"));

  const ttl = opts.ttl ?? DEFAULT_TTL_MS;
  const timer = setTimeout(() => dismiss(t), ttl);
  t.addEventListener("click", () => {
    clearTimeout(timer);
    dismiss(t);
  });
}

function dismiss(t) {
  if (!t || !t.parentNode) return;
  t.classList.remove("show");
  const idx = queue.indexOf(t);
  if (idx >= 0) queue.splice(idx, 1);
  // Wait for fade-out, then remove. Reduced-motion = instant.
  const dur = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : 200;
  setTimeout(() => t.remove(), dur);
}

export const toast = {
  info:    (msg, opts) => show("info", msg, opts),
  success: (msg, opts) => show("success", msg, opts),
  warn:    (msg, opts) => show("warn", msg, opts),
  error:   (msg, opts) => show("error", msg, opts),
};

// Surface globally for non-module callers (legacy app.js consumers).
window.familiarToast = toast;
