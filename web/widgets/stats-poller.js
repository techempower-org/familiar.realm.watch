// Shared stats poller. One fetch per cycle, multiple subscribers.
//
// Design:
//   - Singleton attached to window.statsPoller.
//   - subscribe(fn) -> unsubscribe() ; fn is called with the latest payload on
//     every successful poll, and once immediately if a payload is cached.
//   - Starts on first subscribe, stops when subscribers drop to zero.
//   - Polling interval defaults to 2000ms, configurable via setInterval(ms).
//   - On fetch failure, the previous payload is preserved and a `_error` field
//     is added to the next payload delivered. Widgets render a stale-state cue.
//   - Network history (per-iface RX/TX samples) is maintained for sparklines
//     under window.statsPoller.history; capped at 60 samples per iface.
//
// Endpoint resolution: prefers GET /api/familiar/stats (Echo's endpoint).
// During dev, set window.STATS_MOCK_URL = '/widgets/stats-mock.json' to use
// the mock JSON instead.

(function () {
  if (window.statsPoller) return;

  const STATS_URL = () => window.STATS_MOCK_URL || '/api/familiar/stats';
  const HISTORY_CAP = 60;

  const subscribers = new Set();
  const history = { net: {} }; // { net: { ifaceName: [{t, rx, tx}, ...] } }

  let timer = null;
  let intervalMs = 2000;
  let latest = null;
  let inFlight = false;
  let consecutiveErrors = 0;

  async function fetchOnce() {
    if (inFlight) return;
    inFlight = true;
    try {
      const res = await fetch(STATS_URL(), { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      data._fetchedAt = Date.now();
      data._error = null;
      latest = data;
      consecutiveErrors = 0;
      recordNetHistory(data);
      notifyAll();
    } catch (err) {
      consecutiveErrors++;
      if (latest) {
        latest = { ...latest, _error: String(err && err.message || err), _staleSince: latest._staleSince || Date.now() };
        notifyAll();
      } else {
        notifyAll({ _error: String(err && err.message || err), _fetchedAt: Date.now() });
      }
    } finally {
      inFlight = false;
    }
  }

  function recordNetHistory(data) {
    if (!Array.isArray(data.network)) return;
    const t = data._fetchedAt;
    for (const nic of data.network) {
      const arr = (history.net[nic.iface] ||= []);
      arr.push({ t, rx: nic.rx_bps, tx: nic.tx_bps });
      if (arr.length > HISTORY_CAP) arr.splice(0, arr.length - HISTORY_CAP);
    }
  }

  function notifyAll(payload) {
    const data = payload || latest;
    if (!data) return;
    for (const fn of subscribers) {
      try { fn(data); } catch (e) { console.error('[stats-poller] subscriber threw', e); }
    }
  }

  function start() {
    if (timer) return;
    fetchOnce();
    timer = setInterval(fetchOnce, intervalMs);
  }
  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  window.statsPoller = {
    subscribe(fn) {
      if (typeof fn !== 'function') throw new TypeError('subscribe expects a function');
      subscribers.add(fn);
      if (latest) { try { fn(latest); } catch (e) { console.error(e); } }
      if (subscribers.size === 1) start();
      return () => {
        subscribers.delete(fn);
        if (subscribers.size === 0) stop();
      };
    },
    setInterval(ms) {
      intervalMs = Math.max(500, ms | 0);
      if (timer) { stop(); start(); }
    },
    refresh() { return fetchOnce(); },
    history,
    get latest() { return latest; },
  };
})();
