// Disk stat widget — per-mountpoint bars.

(function () {
  const util = window.statsUtil;
  const DEFAULTS = {
    units: 'auto',
    amberPct: 85,
    redPct: 95,
    hiddenMounts: [],
    alertPct: 0,
  };

  const instances = new WeakMap();

  function diskRow(d, s) {
    const row = document.createElement('div');
    row.className = 'stat-disk-row';
    const head = document.createElement('div');
    head.className = 'stat-disk-head';
    const path = document.createElement('div');
    path.className = 'stat-disk-mount';
    path.textContent = d.mount;
    const val = document.createElement('div');
    val.className = 'stat-disk-val';
    const pct = d.total_mb ? (100 * d.used_mb / d.total_mb) : 0;
    val.textContent = `${util.formatMB(d.used_mb, s.units)} / ${util.formatMB(d.total_mb, s.units)}  ·  ${pct.toFixed(0)}%`;
    head.appendChild(path); head.appendChild(val);
    row.appendChild(head);
    row.appendChild(util.bar(pct, { thresholds: { amber: s.amberPct, red: s.redPct }, compact: true }));
    if (s.alertPct && pct >= s.alertPct) row.classList.add('stat-disk-row--alert');
    return row;
  }

  function paintInto(el, data, s) {
    const error = data && data._error;
    const disks = (data && Array.isArray(data.disks)) ? data.disks : [];
    el.replaceChildren();
    const body = util.makeShell(el, {
      title: 'Storage',
      subtitle: disks.length ? `${disks.length} mounts` : '',
      error,
    });
    if (!disks.length) {
      const empty = document.createElement('div');
      empty.className = 'stat-empty';
      empty.textContent = 'No disks reported.';
      body.appendChild(empty);
      return;
    }
    const visible = disks.filter(d => !(s.hiddenMounts || []).includes(d.mount));
    if (!visible.length) {
      const empty = document.createElement('div');
      empty.className = 'stat-empty';
      empty.textContent = 'All disks hidden in settings.';
      body.appendChild(empty);
      return;
    }
    for (const d of visible) body.appendChild(diskRow(d, s));
  }

  function render(el, ctx) {
    el.classList.add('block-content-stats-disk');
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
      const el = block ? block.querySelector('.block-content-stats-disk') : null;
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

    const alert = util.numberInput(s.alertPct, { min: 0, max: 100, step: 1 });
    alert.addEventListener('change', () => { s.alertPct = Number(alert.value); save(); bind(); });
    wrap.appendChild(util.settingRow('Alert if > % (0 = off)', alert));

    const hide = document.createElement('input');
    hide.type = 'text';
    hide.className = 'stat-setting-input';
    hide.placeholder = 'e.g. /boot, /tmp';
    hide.value = (s.hiddenMounts || []).join(', ');
    hide.addEventListener('change', () => {
      s.hiddenMounts = hide.value.split(',').map(x => x.trim()).filter(Boolean);
      save(); bind();
    });
    wrap.appendChild(util.settingRow('Hide mounts (paths)', hide));

    host.appendChild(wrap);
  }

  (window.familiarStatsBlocks ||= {}).disk = {
    id: 'stats-disk',
    name: 'storage',
    defaultRect: { col: 0, row: 12, w: 6, h: 5 },
    defaultSettings: DEFAULTS,
    render,
    renderSettings,
  };
})();
