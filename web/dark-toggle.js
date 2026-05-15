// dark.realm.watch — <dark-toggle> custom element.
// Variants: "icon" (default, click cycles) | "pills" (three-button: Light/Dark/System).
// Inherits currentColor and font-size for reskinning.
// Drives Dark.set() / Dark.cycle() and listens for dark:change.
// Shadow DOM is constructed with createElement; no string-templated markup.

(function () {
  if (typeof customElements === 'undefined') return;

  var ICON_STYLE =
    ':host { display: inline-block; }' +
    'button {' +
      'font: inherit; color: inherit; background: transparent;' +
      'border: 1px solid currentColor; border-radius: 50%;' +
      'width: 2em; height: 2em; padding: 0; line-height: 1;' +
      'cursor: pointer; opacity: 0.7;' +
      'display: inline-flex; align-items: center; justify-content: center;' +
      'transition: opacity 0.15s;' +
    '}' +
    'button:hover { opacity: 1; }' +
    'button:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }';

  var PILLS_STYLE =
    ':host { display: inline-block; }' +
    '.group {' +
      'display: inline-flex; gap: 0;' +
      'border: 1px solid currentColor; border-radius: 999px;' +
      'padding: 2px; opacity: 0.85;' +
    '}' +
    'button {' +
      'font: inherit; color: inherit; background: transparent;' +
      'border: 0; border-radius: 999px;' +
      'padding: 0.25em 0.75em; line-height: 1;' +
      'cursor: pointer; opacity: 0.7;' +
      'transition: opacity 0.15s, background 0.15s;' +
    '}' +
    'button:hover { opacity: 1; }' +
    'button[aria-pressed="true"] {' +
      'background: currentColor;' +
      'color: var(--dark-toggle-active-fg, Canvas);' +
      'opacity: 1;' +
    '}' +
    'button:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }';

  function attachStyle(root, css) {
    if (typeof CSSStyleSheet !== 'undefined' &&
        'replaceSync' in CSSStyleSheet.prototype &&
        'adoptedStyleSheets' in root) {
      var sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      root.adoptedStyleSheets = [sheet];
      return;
    }
    var style = document.createElement('style');
    style.appendChild(document.createTextNode(css));
    root.appendChild(style);
  }

  function clearChildren(root) {
    while (root.firstChild) root.removeChild(root.firstChild);
    if ('adoptedStyleSheets' in root) root.adoptedStyleSheets = [];
  }

  class DarkToggle extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
    }
    connectedCallback() {
      this._render();
      this._sync();
      this._onChange = this._sync.bind(this);
      document.addEventListener('dark:change', this._onChange);
    }
    disconnectedCallback() {
      document.removeEventListener('dark:change', this._onChange);
    }
    _variant() {
      var v = this.getAttribute('variant');
      return v === 'pills' ? 'pills' : 'icon';
    }
    _render() {
      if (this._variant() === 'pills') this._renderPills();
      else this._renderIcon();
    }
    _renderIcon() {
      clearChildren(this.shadowRoot);
      attachStyle(this.shadowRoot, ICON_STYLE);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('part', 'button');
      btn.setAttribute('aria-label', 'Toggle theme');
      btn.addEventListener('click', function () {
        if (window.Dark) window.Dark.cycle();
      });
      this.shadowRoot.appendChild(btn);
    }
    _renderPills() {
      clearChildren(this.shadowRoot);
      attachStyle(this.shadowRoot, PILLS_STYLE);
      var group = document.createElement('div');
      group.className = 'group';
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', 'Theme');
      var values = ['light', 'dark', 'system'];
      values.forEach(function (value) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.value = value;
        btn.setAttribute('part', 'button');
        btn.textContent = value.charAt(0).toUpperCase() + value.slice(1);
        btn.addEventListener('click', function () {
          if (window.Dark) window.Dark.set(value);
        });
        group.appendChild(btn);
      });
      this.shadowRoot.appendChild(group);
    }
    _sync() {
      if (!window.Dark) return;
      var theme = window.Dark.current();
      var eff = window.Dark.effective();
      if (this._variant() === 'pills') {
        var btns = this.shadowRoot.querySelectorAll('button');
        btns.forEach(function (btn) {
          btn.setAttribute('aria-pressed', String(btn.dataset.value === theme));
        });
      } else {
        var btn = this.shadowRoot.querySelector('button');
        if (!btn) return;
        btn.textContent = theme === 'system' ? '◐' : eff === 'dark' ? '☾' : '☀';
        btn.title = 'Theme: ' + theme + (theme === 'system' ? ' (effective: ' + eff + ')' : '');
      }
    }
  }

  customElements.define('dark-toggle', DarkToggle);
})();
