// dark.realm.watch — render-blocking FOUC preventer.
// Inline this in <head> before any stylesheet link, OR <script src="..."></script>
// before stylesheets. Reads localStorage 'drw-theme' synchronously and sets
// the data-theme attribute on <html> before paint.
(function () {
  try {
    var s = localStorage.getItem('drw-theme');
    if (s === 'dark' || s === 'light') {
      document.documentElement.setAttribute('data-theme', s);
    }
  } catch (_) {}
})();
