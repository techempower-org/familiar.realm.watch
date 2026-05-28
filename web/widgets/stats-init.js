// stats-init.js — register the five stat block types with Reverie's
// dashboard before dashboard-init.js calls mount().
//
// Load order in index.html (insert ahead of dashboard-init.js):
//
//   <script src="/widgets/stats-util.js"></script>
//   <script src="/widgets/stats-poller.js"></script>
//   <script src="/widgets/stats-gpu.js"></script>
//   <script src="/widgets/stats-cpu.js"></script>
//   <script src="/widgets/stats-mem.js"></script>
//   <script src="/widgets/stats-disk.js"></script>
//   <script src="/widgets/stats-net.js"></script>
//   <script type="module" src="/widgets/stats-init.js"></script>
//   <script type="module" src="/dashboard-init.js"></script>
//
// stats-init.js is the only ES-module file in this folder; everything
// else is plain script so it works in the preview harness too.

import { dashboard } from "/dashboard.js";

const blocks = window.familiarStatsBlocks || {};
for (const key of ["gpu", "cpu", "mem", "disk", "net"]) {
  const def = blocks[key];
  if (!def) {
    console.warn(`[stats-init] block "${key}" missing — script not loaded?`);
    continue;
  }
  dashboard.registerBlockType({
    id: def.id,
    name: def.name,
    defaultRect: def.defaultRect,
    render: def.render,
    renderSettings: def.renderSettings,
  });
}
