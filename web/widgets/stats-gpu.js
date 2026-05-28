// GPU stat widget — per-card VRAM bar, utilization, temperature.
// Exposes window.familiarStatsBlocks.gpu as a BlockType matching Reverie's
// dashboard.registerBlockType contract.

(function () {
  const util = window.statsUtil;
  const DEFAULTS = {
    units: 'auto',
    vramAmberPct: 85,
    vramRedPct: 95,
    tempAmberC: 70,
    tempRedC: 85,
    hiddenIndices: [],
  };

  // Bag of per-element state so renderSettings can repaint without a poll.
  const instances = new WeakMap();

  function renderRow(g, s) {
    const row = document.createElement('div');
    row.className = 'stat-gpu-row';
    row.dataset.gpuIndex = String(g.index);

    const head = document.createElement('div');
    head.className = 'stat-gpu-head';
    const title = document.createElement('div');
    title.className = 'stat-gpu-title';
    title.textContent = `GPU ${g.index} — ${g.name}`;
    head.appendChild(title);
    const utilPct = document.createElement('div');
    utilPct.className = 'stat-gpu-util';
    utilPct.title = 'Compute utilization';
    utilPct.textContent = g.utilization_pct != null ? `${g.utilization_pct}%` : '—';
    head.appendChild(utilPct);
    row.appendChild(head);

    const vramPct = (g.vram_total_mb > 0) ? (100 * g.vram_used_mb / g.vram_total_mb) : 0;
    row.appendChild(util.bar(vramPct, { thresholds: { amber: s.vramAmberPct, red: s.vramRedPct } }));

    const vramMeta = document.createElement('div');
    vramMeta.className = 'stat-gpu-meta';
    const usedLabel = document.createElement('span');
    usedLabel.className = 'stat-gpu-meta-label';
    usedLabel.textContent = 'VRAM';
    const usedVal = document.createElement('span');
    usedVal.className = 'stat-gpu-meta-val';
    usedVal.textContent = `${util.formatMB(g.vram_used_mb, s.units)} / ${util.formatMB(g.vram_total_mb, s.units)} (${vramPct.toFixed(0)}%)`;
    vramMeta.appendChild(usedLabel);
    vramMeta.appendChild(usedVal);
    row.appendChild(vramMeta);

    const temp = document.createElement('div');
    temp.className = 'stat-gpu-temp';
    const tempColor = util.colorVarForTemp(g.temperature_c, { amber: s.tempAmberC, red: s.tempRedC });
    const dot = document.createElement('span');
    dot.className = 'stat-gpu-temp-dot';
    dot.style.background = tempColor;
    const tempLabel = document.createElement('span');
    tempLabel.className = 'stat-gpu-meta-label';
    tempLabel.textContent = 'Temp';
    const tempVal = document.createElement('span');
    tempVal.className = 'stat-gpu-temp-val';
    tempVal.textContent = g.temperature_c != null ? `${g.temperature_c}°C` : '—';
    tempVal.style.color = tempColor;
    temp.appendChild(dot); temp.appendChild(tempLabel); temp.appendChild(tempVal);

    if (g.power_w != null) {
      const sep = document.createElement('span');
      sep.className = 'stat-gpu-temp-sep'; sep.textContent = '·';
      const powerLabel = document.createElement('span');
      powerLabel.className = 'stat-gpu-meta-label';
      powerLabel.textContent = 'Power';
      const powerVal = document.createElement('span');
      powerVal.className = 'stat-gpu-power-val';
      powerVal.textContent = `${g.power_w} W`;
      temp.appendChild(sep); temp.appendChild(powerLabel); temp.appendChild(powerVal);
    }
    row.appendChild(temp);
    return row;
  }

  function paintInto(el, data, s) {
    const error = data && data._error;
    el.replaceChildren();
    const body = util.makeShell(el, {
      title: 'Graphics',
      subtitle: data && data.host ? data.host : '',
      error,
    });
    const gpus = (data && Array.isArray(data.gpus)) ? data.gpus : [];
    if (!gpus.length) {
      const empty = document.createElement('div');
      empty.className = 'stat-empty';
      empty.textContent = 'No GPUs reported.';
      body.appendChild(empty);
      return;
    }
    const visible = gpus.filter(g => !(s.hiddenIndices || []).includes(g.index));
    if (!visible.length) {
      const empty = document.createElement('div');
      empty.className = 'stat-empty';
      empty.textContent = 'All GPUs hidden in settings.';
      body.appendChild(empty);
      return;
    }
    for (const g of visible) body.appendChild(renderRow(g, s));
  }

  function render(el, ctx) {
    el.classList.add('block-content-stats-gpu');
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
      // Find the matching .block-content-stats-gpu for this block.
      const block = host.closest('.block');
      const el = block ? block.querySelector('.block-content-stats-gpu') : null;
      const inst = el ? instances.get(el) : null;
      if (inst) inst.setSettings({ ...s });
    }

    const units = util.selectInput(s.units, [
      { value: 'auto', label: 'Auto' }, { value: 'mb', label: 'MB' }, { value: 'gb', label: 'GB' },
    ]);
    units.addEventListener('change', () => { s.units = units.value; save(); bind(); });
    wrap.appendChild(util.settingRow('Units', units));

    const amber = util.numberInput(s.vramAmberPct, { min: 1, max: 99, step: 1 });
    amber.addEventListener('change', () => { s.vramAmberPct = Number(amber.value); save(); bind(); });
    wrap.appendChild(util.settingRow('VRAM amber %', amber));

    const red = util.numberInput(s.vramRedPct, { min: 1, max: 100, step: 1 });
    red.addEventListener('change', () => { s.vramRedPct = Number(red.value); save(); bind(); });
    wrap.appendChild(util.settingRow('VRAM red %', red));

    const tAmber = util.numberInput(s.tempAmberC, { min: 30, max: 110, step: 1 });
    tAmber.addEventListener('change', () => { s.tempAmberC = Number(tAmber.value); save(); bind(); });
    wrap.appendChild(util.settingRow('Temp amber °C', tAmber));

    const tRed = util.numberInput(s.tempRedC, { min: 30, max: 110, step: 1 });
    tRed.addEventListener('change', () => { s.tempRedC = Number(tRed.value); save(); bind(); });
    wrap.appendChild(util.settingRow('Temp red °C', tRed));

    const hide = document.createElement('input');
    hide.type = 'text';
    hide.className = 'stat-setting-input';
    hide.placeholder = 'e.g. 1, 2';
    hide.value = (s.hiddenIndices || []).join(', ');
    hide.addEventListener('change', () => {
      s.hiddenIndices = hide.value.split(',').map(x => x.trim()).filter(Boolean).map(Number).filter(Number.isFinite);
      save(); bind();
    });
    wrap.appendChild(util.settingRow('Hide GPUs (indices)', hide));

    host.appendChild(wrap);
  }

  (window.familiarStatsBlocks ||= {}).gpu = {
    id: 'stats-gpu',
    name: 'gpu',
    defaultRect: { col: 8, row: 6, w: 4, h: 6 },
    defaultSettings: DEFAULTS,
    render,
    renderSettings,
  };
})();
