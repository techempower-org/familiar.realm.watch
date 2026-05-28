// Network stat widget — per-NIC RX/TX with optional sparkline.

(function () {
  const util = window.statsUtil;
  const DEFAULTS = {
    units: 'auto',
    hiddenIfaces: [],
    showSparkline: true,
    historyWindow: 60,
  };

  const instances = new WeakMap();

  function ifaceRow(nic, s) {
    const row = document.createElement('div');
    row.className = 'stat-net-row';
    const head = document.createElement('div');
    head.className = 'stat-net-head';
    const name = document.createElement('div');
    name.className = 'stat-net-iface';
    name.textContent = nic.iface;
    head.appendChild(name);

    const vals = document.createElement('div');
    vals.className = 'stat-net-vals';
    const rx = document.createElement('span');
    rx.className = 'stat-net-rx'; rx.title = 'Receive';
    rx.textContent = `↓ ${util.formatBps(nic.rx_bps, s.units)}`;
    const tx = document.createElement('span');
    tx.className = 'stat-net-tx'; tx.title = 'Transmit';
    tx.textContent = `↑ ${util.formatBps(nic.tx_bps, s.units)}`;
    vals.appendChild(rx); vals.appendChild(tx);
    head.appendChild(vals);
    row.appendChild(head);

    if (s.showSparkline) {
      const history = window.statsPoller.history.net[nic.iface] || [];
      const slice = history.slice(-Math.min(s.historyWindow, history.length));
      const rxPts = slice.map(p => p.rx);
      const txPts = slice.map(p => p.tx);
      const max = Math.max(1, ...rxPts, ...txPts);

      const sparks = document.createElement('div');
      sparks.className = 'stat-net-sparks';

      const rxLabel = document.createElement('div');
      rxLabel.className = 'stat-net-spark-label';
      rxLabel.textContent = 'rx';
      const rxWrap = document.createElement('div');
      rxWrap.className = 'stat-net-spark-row';
      rxWrap.appendChild(rxLabel);
      rxWrap.appendChild(util.sparkline(rxPts, { color: 'var(--accent)', min: 0, max, height: 18 }));
      sparks.appendChild(rxWrap);

      const txLabel = document.createElement('div');
      txLabel.className = 'stat-net-spark-label';
      txLabel.textContent = 'tx';
      const txWrap = document.createElement('div');
      txWrap.className = 'stat-net-spark-row';
      txWrap.appendChild(txLabel);
      txWrap.appendChild(util.sparkline(txPts, { color: 'var(--color-warn)', min: 0, max, height: 18 }));
      sparks.appendChild(txWrap);
      row.appendChild(sparks);
    }
    return row;
  }

  function paintInto(el, data, s) {
    const error = data && data._error;
    const nics = (data && Array.isArray(data.network)) ? data.network : [];
    el.replaceChildren();
    const body = util.makeShell(el, {
      title: 'Network',
      subtitle: nics.length ? `${nics.length} interfaces` : '',
      error,
    });
    if (!nics.length) {
      const empty = document.createElement('div');
      empty.className = 'stat-empty';
      empty.textContent = 'No interfaces reported.';
      body.appendChild(empty);
      return;
    }
    const visible = nics.filter(n => !(s.hiddenIfaces || []).includes(n.iface));
    if (!visible.length) {
      const empty = document.createElement('div');
      empty.className = 'stat-empty';
      empty.textContent = 'All interfaces hidden in settings.';
      body.appendChild(empty);
      return;
    }
    for (const n of visible) body.appendChild(ifaceRow(n, s));
  }

  function render(el, ctx) {
    el.classList.add('block-content-stats-net');
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
      const el = block ? block.querySelector('.block-content-stats-net') : null;
      const inst = el ? instances.get(el) : null;
      if (inst) inst.setSettings({ ...s });
    }

    const units = util.selectInput(s.units, [
      { value: 'auto', label: 'Auto' }, { value: 'Mbps', label: 'Mbps' }, { value: 'MBps', label: 'MB/s' },
    ]);
    units.addEventListener('change', () => { s.units = units.value; save(); bind(); });
    wrap.appendChild(util.settingRow('Units', units));

    const spark = util.checkboxInput(s.showSparkline);
    spark.addEventListener('change', () => { s.showSparkline = spark.checked; save(); bind(); });
    wrap.appendChild(util.settingRow('Show sparkline', spark));

    const win = util.numberInput(s.historyWindow, { min: 5, max: 120, step: 1 });
    win.addEventListener('change', () => { s.historyWindow = Math.max(5, Number(win.value) | 0); save(); bind(); });
    wrap.appendChild(util.settingRow('History samples', win));

    const hide = document.createElement('input');
    hide.type = 'text';
    hide.className = 'stat-setting-input';
    hide.placeholder = 'e.g. lo, docker0';
    hide.value = (s.hiddenIfaces || []).join(', ');
    hide.addEventListener('change', () => {
      s.hiddenIfaces = hide.value.split(',').map(x => x.trim()).filter(Boolean);
      save(); bind();
    });
    wrap.appendChild(util.settingRow('Hide interfaces', hide));

    host.appendChild(wrap);
  }

  (window.familiarStatsBlocks ||= {}).net = {
    id: 'stats-net',
    name: 'network',
    defaultRect: { col: 6, row: 12, w: 6, h: 5 },
    defaultSettings: DEFAULTS,
    render,
    renderSettings,
  };
})();
