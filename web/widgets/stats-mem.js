// Memory stat widget — RAM bar (+swap), buffers/cache toggle.

(function () {
  const util = window.statsUtil;
  const DEFAULTS = {
    units: 'auto',
    amberPct: 85,
    redPct: 95,
    includeSwap: true,
    showBuffCache: false,
  };

  const instances = new WeakMap();

  function metaRow(label, value) {
    const row = document.createElement('div');
    row.className = 'stat-mem-meta';
    const l = document.createElement('span');
    l.className = 'stat-gpu-meta-label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'stat-gpu-meta-val';
    v.textContent = value;
    row.appendChild(l); row.appendChild(v);
    return row;
  }

  function paintInto(el, data, s) {
    const error = data && data._error;
    const m = (data && data.memory) || {};
    el.replaceChildren();
    const body = util.makeShell(el, {
      title: 'Memory',
      subtitle: m.total_mb ? util.formatMB(m.total_mb, s.units) + ' total' : '',
      error,
    });

    if (!m.total_mb) {
      const empty = document.createElement('div');
      empty.className = 'stat-empty';
      empty.textContent = 'No memory data.';
      body.appendChild(empty);
      return;
    }

    const usedMb = s.showBuffCache
      ? (m.used_mb || 0) + (m.buffers_mb || 0) + (m.cache_mb || 0)
      : (m.used_mb || 0);
    const ramPct = 100 * usedMb / m.total_mb;
    const thresholds = { amber: s.amberPct, red: s.redPct };

    const ramLabel = document.createElement('div');
    ramLabel.className = 'stat-mem-row-label';
    const ramLeft = document.createElement('span');
    ramLeft.className = 'stat-gpu-meta-label';
    ramLeft.textContent = 'RAM';
    const ramRight = document.createElement('span');
    ramRight.className = 'stat-gpu-meta-val';
    ramRight.textContent = `${util.formatMB(usedMb, s.units)} / ${util.formatMB(m.total_mb, s.units)} (${ramPct.toFixed(0)}%)`;
    ramLabel.appendChild(ramLeft); ramLabel.appendChild(ramRight);
    body.appendChild(ramLabel);
    body.appendChild(util.bar(ramPct, { thresholds }));

    if (s.showBuffCache && (m.buffers_mb || m.cache_mb)) {
      body.appendChild(metaRow('buff/cache', util.formatMB((m.buffers_mb || 0) + (m.cache_mb || 0), s.units)));
    }

    if (s.includeSwap && m.swap_total_mb) {
      const swapPct = 100 * (m.swap_used_mb || 0) / m.swap_total_mb;
      const swapLabel = document.createElement('div');
      swapLabel.className = 'stat-mem-row-label stat-mem-row-label--alt';
      const sLeft = document.createElement('span');
      sLeft.className = 'stat-gpu-meta-label';
      sLeft.textContent = 'Swap';
      const sRight = document.createElement('span');
      sRight.className = 'stat-gpu-meta-val';
      sRight.textContent = `${util.formatMB(m.swap_used_mb || 0, s.units)} / ${util.formatMB(m.swap_total_mb, s.units)} (${swapPct.toFixed(0)}%)`;
      swapLabel.appendChild(sLeft); swapLabel.appendChild(sRight);
      body.appendChild(swapLabel);
      body.appendChild(util.bar(swapPct, { thresholds, compact: true }));
    }
  }

  function render(el, ctx) {
    el.classList.add('block-content-stats-mem');
    let settings = { ...DEFAULTS, ...((ctx && ctx.getSettings && ctx.getSettings()) || {}) };
    let lastSnapshot = null;
    const unsubscribe = window.statsPoller.subscribe((data) => {
      lastSnapshot = data;
      paintInto(el, data, settings);
    });
    instances.set(el, {
      setSettings(next) {
        settings = { ...DEFAULTS, ...next };
        if (lastSnapshot) paintInto(el, lastSnapshot, settings);
      },
      destroy() { unsubscribe(); },
    });
  }

  function renderSettings(host, state, save) {
    const s = state.settings;
    for (const [k, v] of Object.entries(DEFAULTS)) if (!(k in s)) s[k] = v;
    const wrap = document.createElement('div');
    wrap.className = 'stat-settings';

    function bind() {
      const block = host.closest('.block');
      const el = block ? block.querySelector('.block-content-stats-mem') : null;
      const inst = el ? instances.get(el) : null;
      if (inst) inst.setSettings({ ...s });
    }

    const units = util.selectInput(s.units, [
      { value: 'auto', label: 'Auto' }, { value: 'mb', label: 'MB' }, { value: 'gb', label: 'GB' },
    ]);
    units.addEventListener('change', () => { s.units = units.value; save(); bind(); });
    wrap.appendChild(util.settingRow('Units', units));

    const amber = util.numberInput(s.amberPct, { min: 1, max: 99, step: 1 });
    amber.addEventListener('change', () => { s.amberPct = Number(amber.value); save(); bind(); });
    wrap.appendChild(util.settingRow('Amber %', amber));

    const red = util.numberInput(s.redPct, { min: 1, max: 100, step: 1 });
    red.addEventListener('change', () => { s.redPct = Number(red.value); save(); bind(); });
    wrap.appendChild(util.settingRow('Red %', red));

    const swap = util.checkboxInput(s.includeSwap);
    swap.addEventListener('change', () => { s.includeSwap = swap.checked; save(); bind(); });
    wrap.appendChild(util.settingRow('Show swap', swap));

    const bc = util.checkboxInput(s.showBuffCache);
    bc.addEventListener('change', () => { s.showBuffCache = bc.checked; save(); bind(); });
    wrap.appendChild(util.settingRow('Include buff/cache in "used"', bc));

    host.appendChild(wrap);
  }

  (window.familiarStatsBlocks ||= {}).mem = {
    id: 'stats-mem',
    name: 'memory',
    defaultRect: { col: 4, row: 6, w: 4, h: 4 },
    defaultSettings: DEFAULTS,
    render,
    renderSettings,
  };
})();
