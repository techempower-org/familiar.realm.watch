// dashboard-init.js — wire up the v1 block types (chat, palace, model) and
// mount the dashboard. Runs before app.js so that the chat/palace IDs are
// live in the document by the time app.js queries them.
//
// Each block type's render(el) function relocates the contents of a
// <template id="slot-..."> into the block's content area. Templates are the
// canonical source of the chat/palace markup so this file stays declarative
// and the dashboard layer never inlines big HTML strings.

import { dashboard } from "./dashboard.js";

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

dashboard.registerBlockType({
  id: "chat",
  name: "chat",
  defaultRect: { col: 0, row: 0, w: 8, h: 12 },
  render(el) {
    el.classList.add("block-content-chat");
    adoptTemplate("slot-chat", el);
  },
});

dashboard.registerBlockType({
  id: "palace",
  name: "palace",
  defaultRect: { col: 0, row: 12, w: 12, h: 14 },
  render(el) {
    el.classList.add("block-content-palace");
    adoptTemplate("slot-palace", el);
  },
});

dashboard.registerBlockType({
  id: "model",
  name: "model",
  defaultRect: { col: 8, row: 0, w: 4, h: 6 },
  render(el) {
    el.classList.add("block-content-model");
    adoptTemplate("slot-model", el);
  },
});

const root = document.getElementById("dashboard");
if (root) dashboard.mount(root);

// Reset-layout button in the header.
const resetBtn = document.getElementById("dashboard-reset");
if (resetBtn) {
  resetBtn.addEventListener("click", () => {
    if (confirm("Reset block layout to defaults? Your changes will be lost.")) {
      dashboard.resetLayout();
    }
  });
}
