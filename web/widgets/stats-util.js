// Shared helpers for stat widgets. Color thresholds, byte/bit formatting,
// declarative bar/sparkline rendering. Keep this small.

(function () {
  if (window.statsUtil) return;

  // Default amber/red thresholds (percent). Settings can override per widget.
  const DEFAULT_THRESHOLDS = { amber: 85, red: 95 };
  const DEFAULT_TEMP = { amber: 70, red: 85 }; // celsius

  function clampPct(v) { return Math.max(0, Math.min(100, v)); }

  // Map a fill percent to a CSS var name; widgets use this to color bars.
  function colorVarForPct(pct, t = DEFAULT_THRESHOLDS) {
    if (pct >= t.red) return 'var(--color-error)';
    if (pct >= t.amber) return 'var(--color-warn)';
    return 'var(--accent)';
  }

  function colorVarForTemp(c, t = DEFAULT_TEMP) {
    if (c >= t.red) return 'var(--color-error)';
    if (c >= t.amber) return 'var(--color-warn)';
    return 'var(--accent-cool, #6ab68f)';
  }

  // Format MB into a human string. unit ∈ 'auto'|'mb'|'gb'.
  function formatMB(mb, unit = 'auto') {
    if (mb == null || Number.isNaN(mb)) return '—';
    if (unit === 'mb') return `${mb.toLocaleString(undefined, { maximumFractionDigits: 0 })} MB`;
    if (unit === 'gb') return `${(mb / 1024).toFixed(1)} GB`;
    // auto: GB above 1024MB
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
  }

  // Format bytes-per-second into Mbps / MBps / auto.
  function formatBps(bps, unit = 'auto') {
    if (bps == null || Number.isNaN(bps)) return '—';
    if (unit === 'Mbps') return `${(bps * 8 / 1e6).toFixed(2)} Mbps`;
    if (unit === 'MBps') return `${(bps / 1e6).toFixed(2)} MB/s`;
    // auto: bits when small, bytes when large
    const bits = bps * 8;
    if (bits < 1e6) return `${(bits / 1e3).toFixed(0)} kbps`;
    if (bits < 1e9) return `${(bits / 1e6).toFixed(1)} Mbps`;
    return `${(bits / 1e9).toFixed(2)} Gbps`;
  }

  // Build a horizontal bar element. Returns a <div class="stat-bar"> with
  // .stat-bar-fill inside. The fill color picks the threshold color by
  // pct. Repeated calls update both width and color smoothly.
  function bar(pct, opts = {}) {
    pct = clampPct(pct);
    const color = opts.color || colorVarForPct(pct, opts.thresholds);
    const wrap = document.createElement('div');
    wrap.className = 'stat-bar';
    if (opts.compact) wrap.classList.add('stat-bar--compact');
    const fill = document.createElement('div');
    fill.className = 'stat-bar-fill';
    fill.style.width = pct + '%';
    fill.style.background = color;
    wrap.appendChild(fill);
    return wrap;
  }

  function updateBar(wrap, pct, opts = {}) {
    pct = clampPct(pct);
    const fill = wrap.querySelector('.stat-bar-fill');
    if (!fill) return;
    fill.style.width = pct + '%';
    fill.style.background = opts.color || colorVarForPct(pct, opts.thresholds);
  }

  // SVG sparkline. Points are an array of numbers; the polyline is
  // normalized to the widget width and given a soft gradient underlay.
  // Returns an <svg> element you can append. Pass min/max to lock the
  // y-axis (otherwise inferred). Width/height in px.
  function sparkline(points, opts = {}) {
    const w = opts.width || 100;
    const h = opts.height || 24;
    const stroke = opts.color || 'var(--accent)';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'stat-spark');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.width = '100%';
    svg.style.height = h + 'px';

    if (!points || points.length < 2) {
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('x', w / 2); t.setAttribute('y', h / 2 + 3);
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('class', 'stat-spark-empty');
      t.textContent = '—';
      svg.appendChild(t);
      return svg;
    }

    let lo = opts.min, hi = opts.max;
    if (lo == null) lo = Math.min(...points);
    if (hi == null) hi = Math.max(...points);
    if (hi === lo) hi = lo + 1;

    const xs = points.map((_, i) => (i / (points.length - 1)) * w);
    const ys = points.map(v => h - ((v - lo) / (hi - lo)) * (h - 2) - 1);
    const d = xs.map((x, i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${ys[i].toFixed(1)}`).join('');

    // gradient under the line — built via createElementNS, no innerHTML
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const gradId = 'spark-grad-' + Math.random().toString(36).slice(2, 8);
    const defs = document.createElementNS(SVG_NS, 'defs');
    const grad = document.createElementNS(SVG_NS, 'linearGradient');
    grad.setAttribute('id', gradId);
    grad.setAttribute('x1', '0'); grad.setAttribute('x2', '0');
    grad.setAttribute('y1', '0'); grad.setAttribute('y2', '1');
    const stop1 = document.createElementNS(SVG_NS, 'stop');
    stop1.setAttribute('offset', '0%');
    stop1.setAttribute('stop-color', stroke);
    stop1.setAttribute('stop-opacity', '0.35');
    const stop2 = document.createElementNS(SVG_NS, 'stop');
    stop2.setAttribute('offset', '100%');
    stop2.setAttribute('stop-color', stroke);
    stop2.setAttribute('stop-opacity', '0');
    grad.appendChild(stop1); grad.appendChild(stop2);
    defs.appendChild(grad);
    svg.appendChild(defs);

    const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    area.setAttribute('d', d + ` L${w},${h} L0,${h} Z`);
    area.setAttribute('fill', `url(#${gradId})`);
    area.setAttribute('stroke', 'none');
    svg.appendChild(area);

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    line.setAttribute('d', d);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', stroke);
    line.setAttribute('stroke-width', '1.4');
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(line);

    return svg;
  }

  // Per-widget settings persistence. localStorage key 'familiar-widget-<type>-settings'.
  function loadSettings(type, defaults) {
    try {
      const raw = localStorage.getItem('familiar-widget-' + type + '-settings');
      if (!raw) return { ...defaults };
      return { ...defaults, ...JSON.parse(raw) };
    } catch (_) { return { ...defaults }; }
  }
  function saveSettings(type, value) {
    try { localStorage.setItem('familiar-widget-' + type + '-settings', JSON.stringify(value)); } catch (_) {}
  }

  // Widget shell — every widget renders into a host element provided by
  // the dashboard framework. This helper builds an internal stat-card
  // body wrapper with title + grid so widgets don't repeat the chrome.
  function makeShell(host, { title, subtitle, error } = {}) {
    host.replaceChildren();
    host.classList.add('stat-widget');
    const head = document.createElement('div');
    head.className = 'stat-widget-head';
    const h = document.createElement('div');
    h.className = 'stat-widget-title';
    h.textContent = title || '';
    head.appendChild(h);
    if (subtitle) {
      const s = document.createElement('div');
      s.className = 'stat-widget-sub';
      s.textContent = subtitle;
      head.appendChild(s);
    }
    if (error) {
      const e = document.createElement('div');
      e.className = 'stat-widget-error';
      e.title = error;
      e.textContent = 'stale';
      head.appendChild(e);
    }
    host.appendChild(head);
    const body = document.createElement('div');
    body.className = 'stat-widget-body';
    host.appendChild(body);
    return body;
  }

  // Settings drawer — small helper for renderSettings. Builds rows.
  function settingRow(label, input) {
    const row = document.createElement('label');
    row.className = 'stat-setting-row';
    const lab = document.createElement('span');
    lab.className = 'stat-setting-label';
    lab.textContent = label;
    row.appendChild(lab);
    row.appendChild(input);
    return row;
  }
  function numberInput(value, opts = {}) {
    const i = document.createElement('input');
    i.type = 'number';
    i.className = 'stat-setting-input';
    if (opts.min != null) i.min = opts.min;
    if (opts.max != null) i.max = opts.max;
    if (opts.step != null) i.step = opts.step;
    i.value = value;
    return i;
  }
  function selectInput(value, options) {
    const s = document.createElement('select');
    s.className = 'stat-setting-input';
    for (const opt of options) {
      const o = document.createElement('option');
      if (typeof opt === 'string') { o.value = opt; o.textContent = opt; }
      else { o.value = opt.value; o.textContent = opt.label; }
      s.appendChild(o);
    }
    s.value = value;
    return s;
  }
  function checkboxInput(value) {
    const i = document.createElement('input');
    i.type = 'checkbox';
    i.className = 'stat-setting-check';
    i.checked = !!value;
    return i;
  }

  window.statsUtil = {
    DEFAULT_THRESHOLDS,
    DEFAULT_TEMP,
    clampPct,
    colorVarForPct,
    colorVarForTemp,
    formatMB,
    formatBps,
    bar,
    updateBar,
    sparkline,
    loadSettings,
    saveSettings,
    makeShell,
    settingRow,
    numberInput,
    selectInput,
    checkboxInput,
  };
})();
