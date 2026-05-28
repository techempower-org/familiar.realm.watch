// CPU stat widget — load averages + per-core heatmap.

(function () {
  const util = window.statsUtil;
  const DEFAULTS = {
    coreAmberPct: 75,
    coreRedPct: 90,
    smoothing: 1,
    showIdle: true,
  };

  const instances = new WeakMap();

  function makeSmoother(window_) {
    const last = [];
    return function smooth(values) {
      if (window_ <= 1) return values.slice();
      last.push(values);
      while (last.length > window_) last.shift();
      const len = values.length;
      const out = new Array(len).fill(0);
      let weightSum = 0;
      last.forEach((sample, idx) => {
        const w = idx + 1;
        weightSum += w;
        for (let i = 0; i < len; i++) out[i] += (sample[i] || 0) * w;
      });
      for (let i = 0; i < len; i++) out[i] /= weightSum;
      return out;
    };
  }

  function loadAvgChip(label, value, cores) {
    const wrap = document.createElement('div');
    wrap.className = 'stat-cpu-load';
    const l = document.createElement('span');
    l.className = 'stat-cpu-load-label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'stat-cpu-load-value';
    v.textContent = (value != null) ? value.toFixed(2) : '—';
    if (value != null && cores) {
      if (value >= 2 * cores) v.style.color = 'var(--color-error)';
      else if (value >= cores) v.style.color = 'var(--color-warn)';
    }
    wrap.appendChild(l);
    wrap.appendChild(v);
    return wrap;
  }

  function coreCell(pct, s) {
    const cell = document.createElement('div');
    cell.className = 'stat-cpu-core';
    cell.style.background = util.colorVarForPct(pct, { amber: s.coreAmberPct, red: s.coreRedPct });
    cell.style.opacity = String(Math.max(0.18, Math.min(1, pct / 100)));
    cell.title = `${pct.toFixed(0)}%`;
    return cell;
  }

  function paintInto(el, data, s, smoother) {
    const error = data && data._error;
    const cpu = (data && data.cpu) || {};
    el.replaceChildren();
    const body = util.makeShell(el, {
      title: 'CPU',
      subtitle: cpu.cores ? `${cpu.cores} cores` : '',
      error,
    });

    const loadRow = document.createElement('div');
    loadRow.className = 'stat-cpu-loads';
    loadRow.appendChild(loadAvgChip('1m', cpu.load_1m, cpu.cores));
    loadRow.appendChild(loadAvgChip('5m', cpu.load_5m, cpu.cores));
    loadRow.appendChild(loadAvgChip('15m', cpu.load_15m, cpu.cores));
    body.appendChild(loadRow);

    const cores = Array.isArray(cpu.per_core_pct) ? cpu.per_core_pct : [];
    if (cores.length) {
      const smoothed = smoother(cores);
      const grid = document.createElement('div');
      grid.className = 'stat-cpu-grid';
      const cols = Math.min(16, Math.max(4, Math.ceil(Math.sqrt(cores.length * 2))));
      grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
      smoothed.forEach((pct) => {
        if (!s.showIdle && pct < 5) return;
        grid.appendChild(coreCell(pct, s));
      });
      body.appendChild(grid);

      const avg = smoothed.reduce((a, b) => a + b, 0) / Math.max(1, smoothed.length);
      const summary = document.createElement('div');
      summary.className = 'stat-cpu-summary';
      const sLabel = document.createElement('span');
      sLabel.className = 'stat-cpu-summary-label';
      sLabel.textContent = 'avg load';
      const sVal = document.createElement('span');
      sVal.className = 'stat-cpu-summary-val';
      sVal.textContent = `${avg.toFixed(0)}%`;
      summary.appendChild(sLabel); summary.appendChild(sVal);
      body.appendChild(summary);
    }
  }

  function render(el, ctx) {
    el.classList.add('block-content-stats-cpu');
    let settings = { ...DEFAULTS, ...((ctx && ctx.getSettings && ctx.getSettings()) || {}) };
    let smoother = makeSmoother(settings.smoothing);
    let lastSnapshot = null;
    const unsubscribe = window.statsPoller.subscribe((data) => {
      lastSnapshot = data;
      paintInto(el, data, settings, smoother);
    });
    instances.set(el, {
      setSettings(next) {
        settings = { ...DEFAULTS, ...next };
        smoother = makeSmoother(settings.smoothing);
        if (lastSnapshot) paintInto(el, lastSnapshot, settings, smoother);
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
      const el = block ? block.querySelector('.block-content-stats-cpu') : null;
      const inst = el ? instances.get(el) : null;
      if (inst) inst.setSettings({ ...s });
    }

    const amber = util.numberInput(s.coreAmberPct, { min: 1, max: 99, step: 1 });
    amber.addEventListener('change', () => { s.coreAmberPct = Number(amber.value); save(); bind(); });
    wrap.appendChild(util.settingRow('Core amber %', amber));

    const red = util.numberInput(s.coreRedPct, { min: 1, max: 100, step: 1 });
    red.addEventListener('change', () => { s.coreRedPct = Number(red.value); save(); bind(); });
    wrap.appendChild(util.settingRow('Core red %', red));

    const smooth = util.numberInput(s.smoothing, { min: 1, max: 30, step: 1 });
    smooth.addEventListener('change', () => { s.smoothing = Math.max(1, Number(smooth.value) | 0); save(); bind(); });
    wrap.appendChild(util.settingRow('Smoothing window', smooth));

    const idle = util.checkboxInput(s.showIdle);
    idle.addEventListener('change', () => { s.showIdle = idle.checked; save(); bind(); });
    wrap.appendChild(util.settingRow('Show idle cores', idle));

    host.appendChild(wrap);
  }

  (window.familiarStatsBlocks ||= {}).cpu = {
    id: 'stats-cpu',
    name: 'cpu',
    defaultRect: { col: 0, row: 6, w: 4, h: 6 },
    defaultSettings: DEFAULTS,
    render,
    renderSettings,
  };
})();
