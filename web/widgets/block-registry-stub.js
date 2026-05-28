// Stub registry for preview.html only — emulates the bare minimum of
// Reverie's dashboard.registerBlockType + mount lifecycle so widgets render
// in isolation. In production this file is not loaded; stats-init.js
// registers directly with dashboard.js.
//
// Consumes window.familiarStatsBlocks (populated by each stats-*.js) and
// mounts one block per type into #stat-widgets-harness.

(function () {
  if (window.familiarStatsStub) return;

  const SETTINGS_KEY = (id) => 'familiar-widget-' + id + '-settings';

  function loadSettings(id) {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY(id));
      return raw ? JSON.parse(raw) : {};
    } catch (_) { return {}; }
  }
  function saveSettings(id, value) {
    try { localStorage.setItem(SETTINGS_KEY(id), JSON.stringify(value)); } catch (_) {}
  }

  function mount(def) {
    const harness = document.getElementById('stat-widgets-harness');
    if (!harness) return;

    const card = document.createElement('section');
    card.className = 'stat-widget-card block';
    card.setAttribute('data-block-type', def.id);

    const titlebar = document.createElement('div');
    titlebar.className = 'stat-widget-titlebar';
    const name = document.createElement('div');
    name.className = 'stat-widget-name';
    name.textContent = def.name || def.id;
    const settingsBtn = document.createElement('button');
    settingsBtn.type = 'button';
    settingsBtn.className = 'stat-widget-settings-btn';
    settingsBtn.title = 'Settings';
    settingsBtn.textContent = '⚙';
    titlebar.appendChild(name);
    titlebar.appendChild(settingsBtn);
    card.appendChild(titlebar);

    const content = document.createElement('div');
    content.className = 'block-content';
    card.appendChild(content);

    const drawer = document.createElement('div');
    drawer.className = 'stat-widget-drawer';
    drawer.hidden = true;
    card.appendChild(drawer);

    harness.appendChild(card);

    const settings = { ...(def.defaultSettings || {}), ...loadSettings(def.id) };
    const state = { rect: def.defaultRect || {}, visible: true, settings };

    const ctx = { getSettings: () => state.settings };
    def.render(content, ctx);

    settingsBtn.addEventListener('click', () => {
      drawer.hidden = !drawer.hidden;
      if (!drawer.hidden && def.renderSettings) {
        drawer.replaceChildren();
        def.renderSettings(drawer, state, () => saveSettings(def.id, state.settings));
      }
    });
  }

  function start() {
    const blocks = window.familiarStatsBlocks || {};
    for (const key of ['gpu', 'cpu', 'mem', 'disk', 'net']) {
      const def = blocks[key];
      if (def) mount(def);
    }
  }

  window.familiarStatsStub = { start };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else { start(); }
})();
