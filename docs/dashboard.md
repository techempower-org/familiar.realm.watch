# Dashboard block grid

Wave-Terminal-inspired movable+resizable blocks for the `web/` PWA. Lives in
[`web/dashboard.js`](../web/dashboard.js) (framework) and
[`web/dashboard-init.js`](../web/dashboard-init.js) (v1 block registry).

## Model

The dashboard is a 12-column CSS grid laid over `<main class="dashboard">`.
Each block has an integer cell rect `{col, row, w, h}`, persisted to
`localStorage["familiar_dashboard_layout"]` keyed by block id.

- Columns: 12
- Row height anchor: 48 px
- Gap: 8 px
- Min block size: 2 cols wide × 3 rows tall

Drag and resize happen in pointer-pixel space, then snap to cell coords on
release. A ghost preview shows the snapped target.

Mobile (`< 768px`) collapses to a single-column flex stack; drag/resize are
disabled, settings still work.

## Registering a block type

```js
import { dashboard } from "/dashboard.js";

dashboard.registerBlockType({
  id: "gpu",                // unique block-type id
  name: "gpu",              // shown in header bar + settings drawer title
  defaultRect: { col: 8, row: 0, w: 4, h: 4 },
  render(el) {
    // el is the block's `<div class="block-content">` — populate it.
    el.classList.add("block-content-gpu");
    el.append(renderGpuWidget());   // your DOM
  },
  renderSettings(el, state, save) {
    // Optional. el is the per-block section inside the settings drawer.
    // state is { rect, visible, settings } — write to state.settings.*
    // and call save() to persist + apply.
    const row = document.createElement("label");
    row.textContent = "show temperature";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!state.settings.showTemp;
    input.addEventListener("change", () => {
      state.settings.showTemp = input.checked;
      save();
    });
    row.appendChild(input);
    el.appendChild(row);
  },
});
```

Then mount once on the root:

```js
const root = document.getElementById("dashboard");
dashboard.mount(root);
```

`mount()` instantiates one block per registered type, restoring rect+settings
from localStorage when present.

## Common settings (all blocks get these)

The framework's settings drawer always includes:

- **visible** — toggle the block on/off (preserves rect+settings while hidden)
- **tint** — `none` | `warm` | `cool` (subtle accent overlay)
- **font scale** — `85%` | `100%` | `115%` (sets `--block-font-scale` on the
  block element; content using `font-size: 1em` will scale)

Block-type opt-in goes in `renderSettings(el, state, save)`.

## Theme conventions

- Use the existing CSS custom properties from `style.css`
  (`--bg`, `--fg`, `--fg-muted`, `--accent`, `--user-bg`, `--assistant-bg`,
  `--border`, `--sidebar-bg`, `--color-warn`, `--color-error`).
- Fonts via `--sans` / `--serif` / `--mono`.
- Match the parchment + sigil-gold aesthetic of the existing UI.
- Respect `prefers-reduced-motion: reduce` — kill transitions, keep state
  changes instant.

## Public API surface

```ts
type BlockRect = { col: number; row: number; w: number; h: number };

type BlockType = {
  id: string;
  name: string;
  defaultRect?: BlockRect;
  render(el: HTMLElement): void;
  renderSettings?(
    el: HTMLElement,
    state: { rect: BlockRect; visible: boolean; settings: Record<string, unknown> },
    save: () => void,
  ): void;
};

interface Dashboard {
  registerBlockType(type: BlockType): void;
  mount(root: HTMLElement): void;
  resetLayout(): void;                       // wipes localStorage + reloads
  applyPreset(id: string): void;             // rebuilds from a named preset
  presets: string[];                          // available preset ids
  showBlock(id: string): void;                // un-hide a hidden block
  hideBlock(id: string): void;                // hide (preserves rect+settings)
  listTypes(): Array<{ id: string; name: string; visible: boolean; registered: true }>;
  listBlocks(): Array<{ id: string; typeId: string; visible: boolean }>;
}
```

## Header controls (`dashboard-init.js`)

- **`+` (add block)** — opens a popover listing every registered block type with
  its current visibility. Click a row to toggle show/hide. Esc or click-outside
  dismisses.
- **layout** — opens a popover with named presets (`default`, `compact`,
  `data-dense`) plus a destructive `reset all` row. Selecting a preset rebuilds
  the layout map from `PRESETS[id]` and reloads; reset wipes localStorage.

Preset definitions live in `PRESETS` in `dashboard.js` — add a key per
block-type id (rect map), or `false` to hide a type in that preset.

Also exposed as `window.familiarDashboard` for debugging.

## v1 blocks (registered by `dashboard-init.js`)

| id       | type     | default rect (col,row,w,h) | notes                                       |
|----------|----------|----------------------------|---------------------------------------------|
| `chat`   | chat     | 0,0,8,12                   | wraps the existing `#log` + `#form` markup  |
| `palace` | palace   | 0,12,12,14                 | wraps the existing `#palace-view` markup    |
| `model`  | model    | 8,0,4,6                    | placeholder; real picker lands via slot-picker |

Future block authors (Echo: `/api/familiar/stats` endpoint, Luna: stat
widgets) just call `dashboard.registerBlockType({...})` before
`dashboard.mount()` is invoked. Add the registration to
`dashboard-init.js` (or a new init file loaded ahead of `app.js`).
