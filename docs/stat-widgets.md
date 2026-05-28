# Stat widgets

Five Wave-Terminal-style stat blocks for the familiar PWA: **GPU, CPU, Memory, Storage, Network**. Each widget is a `BlockType` matching Reverie's [dashboard framework](dashboard.md): it subscribes to the shared `statsPoller`, paints into the block content area, and exposes its own settings drawer.

## Files

```
web/widgets/
├── stats-mock.json         # development mock matching Echo's response shape
├── stats-poller.js         # singleton, one fetch per cycle, multi-subscriber
├── stats-util.js           # bars, sparklines, formatters, threshold colors
├── stats-gpu.js            # → window.familiarStatsBlocks.gpu
├── stats-cpu.js            # → .cpu
├── stats-mem.js            # → .mem
├── stats-disk.js           # → .disk
├── stats-net.js            # → .net
├── stats-init.js           # ES module — registers all five with dashboard
├── stats.css
├── block-registry-stub.js  # preview-only minimal mount harness
└── preview.html            # standalone preview against the mock
```

## Visual language

Parchment-and-sigil-gold "scrying glass" — serif widget titles, mono numerics, sans labels. Bars use `color-mix(in srgb, var(--accent) X%, transparent)`; thresholds shift to `var(--color-warn)` (default ≥ 85%) and `var(--color-error)` (≥ 95%). Temperature uses a three-tier cool/amber/red cue via a new `--accent-cool` token (green-gold blend).

All transitions are 180ms ease; `prefers-reduced-motion: reduce` zeros them out.

## Polling

`statsPoller` is a singleton attached to `window.statsPoller`. Subscribers register a callback via `subscribe(fn) -> unsubscribe`. The poller starts on first subscribe, stops when the last one unsubscribes. Default interval: 2000 ms (`setInterval(ms)` to change). Net history (≤ 60 samples per interface) is kept under `statsPoller.history.net` for the network sparklines.

To force the mock during development:

```js
window.STATS_MOCK_URL = '/widgets/stats-mock.json';
```

(set this before stats-poller.js runs)

## Block-type contract

Each widget exports `window.familiarStatsBlocks.<id>` matching Reverie's `BlockType`:

```js
{
  id: 'stats-gpu',
  name: 'gpu',
  defaultRect: { col, row, w, h },
  defaultSettings: { ... },
  render(el, ctx) { ... },                       // ctx.getSettings() optional
  renderSettings(el, state, save) { ... },       // state.settings is live; call save() to persist
}
```

`stats-init.js` walks this object and calls `dashboard.registerBlockType(...)` for each — it must run before `dashboard-init.js`'s `mount()`.

## Wiring into index.html

Insert ahead of `dashboard-init.js`:

```html
<script src="/widgets/stats-util.js"></script>
<script src="/widgets/stats-poller.js"></script>
<script src="/widgets/stats-gpu.js"></script>
<script src="/widgets/stats-cpu.js"></script>
<script src="/widgets/stats-mem.js"></script>
<script src="/widgets/stats-disk.js"></script>
<script src="/widgets/stats-net.js"></script>
<script type="module" src="/widgets/stats-init.js"></script>
<!-- existing -->
<script type="module" src="/dashboard-init.js"></script>
```

`stats-init.js` is the only ES-module file in this folder; everything else is plain script so the preview harness works without a module bundler.

## Settings schemas

| Widget   | Key                | Default     | Notes |
|----------|--------------------|-------------|-------|
| **GPU**  | `units`            | `'auto'`    | `'auto' \| 'mb' \| 'gb'` |
|          | `vramAmberPct`     | `85`        | bar color shift |
|          | `vramRedPct`       | `95`        | |
|          | `tempAmberC`       | `70`        | dot + value tint |
|          | `tempRedC`         | `85`        | |
|          | `hiddenIndices`    | `[]`        | GPU indices to hide |
| **CPU**  | `coreAmberPct`     | `75`        | heatmap cell threshold |
|          | `coreRedPct`       | `90`        | |
|          | `smoothing`        | `1`         | EMA window (samples) |
|          | `showIdle`         | `true`      | show cores below 5% |
| **Mem**  | `units`            | `'auto'`    | |
|          | `amberPct`         | `85`        | |
|          | `redPct`           | `95`        | |
|          | `includeSwap`      | `true`      | render swap row |
|          | `showBuffCache`    | `false`     | include buff/cache in "used" |
| **Disk** | `units`            | `'auto'`    | |
|          | `amberPct`         | `85`        | |
|          | `redPct`           | `95`        | |
|          | `hiddenMounts`     | `[]`        | mount paths to hide |
|          | `alertPct`         | `0`         | glow if any mount ≥ X% (0 = off) |
| **Net**  | `units`            | `'auto'`    | `'auto' \| 'Mbps' \| 'MBps'` |
|          | `hiddenIfaces`     | `[]`        | interfaces to hide |
|          | `showSparkline`    | `true`      | rx + tx mini sparklines |
|          | `historyWindow`    | `60`        | samples to show |

In production, settings live under each block's framework-persisted `state.settings`. The preview harness uses `localStorage[familiar-widget-<id>-settings]`.

## Preview

To eyeball widgets in isolation against the mock:

1. `bun run dev` to start the familiar server.
2. Open `http://localhost:8080/widgets/preview.html`.

If the route isn't exposed, copy `web/widgets/preview.html` to any path served by Bun.serve's static fileSystem.

The repo `.gitignore` excludes `*.png`, so screenshots aren't committed — captures of the preview live at `docs/screenshots/stat-widgets.png` on local checkouts only.

## Response shape

The poller expects this shape from `GET /api/familiar/stats` (matching Echo's endpoint). Field names are load-bearing — don't rename without coordinating:

```json
{
  "timestamp": "ISO-8601",
  "host": "string",
  "gpus": [{ "index": 0, "name": "...", "vram_used_mb": 0, "vram_total_mb": 0, "utilization_pct": 0, "temperature_c": 0, "power_w": 0 }],
  "cpu":  { "cores": 0, "load_1m": 0, "load_5m": 0, "load_15m": 0, "per_core_pct": [...] },
  "memory": { "total_mb": 0, "used_mb": 0, "free_mb": 0, "buffers_mb": 0, "cache_mb": 0, "swap_total_mb": 0, "swap_used_mb": 0 },
  "disks": [{ "mount": "/", "used_mb": 0, "total_mb": 0 }],
  "network": [{ "iface": "eth0", "rx_bps": 0, "tx_bps": 0 }]
}
```

Fields may be missing — widgets render an empty state rather than throwing.
