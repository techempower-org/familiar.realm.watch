// Vanilla chat UI. Streams /v1/chat/completions SSE into the transcript.
// v0.3.1 — multi-session sidebar, reflect pill, finer status.
const log = document.getElementById("log");
const form = document.getElementById("form");
const input = document.getElementById("input");
const submit = form.querySelector("button");
const status = document.getElementById("status");
const word = document.getElementById("word");
const sigilBtn = document.getElementById("sigil");
const sessionsPanel = document.getElementById("sessions");
const sessionsList = document.getElementById("sessions-list");
const sessionsNew = document.getElementById("sessions-new");

// Citation rendering — converts [drawer_xxx] markers in assistant responses
// into hover-popover buttons. DOM-only, no innerHTML. The link target uses
// <body data-viz-base-url="..."> for one-config swap to mempalace-viz when
// the deployed origin exists; empty/absent → /api/familiar/memory/<id>.
const CITATION_PATTERN = /\[(drawer_[a-z0-9]+)\]/g;

function vizBaseUrl() {
  return document.body.getAttribute("data-viz-base-url") || "";
}

function buildPopover(drawerId, meta) {
  const popover = document.createElement("span");
  popover.className = "citation-popover";
  popover.setAttribute("role", "tooltip");

  const title = document.createElement("strong");
  title.textContent = meta && meta.wing && meta.room
    ? `${meta.wing} · ${meta.room}`
    : drawerId;
  popover.appendChild(title);

  if (meta && meta.created_at) {
    const date = document.createElement("span");
    date.className = "citation-date";
    date.textContent = new Date(meta.created_at).toLocaleDateString();
    popover.appendChild(date);
  }

  if (meta && meta.text) {
    const snippet = document.createElement("p");
    snippet.className = "citation-snippet";
    snippet.textContent = meta.text.length > 280 ? meta.text.slice(0, 280) + "…" : meta.text;
    popover.appendChild(snippet);
  }

  const link = document.createElement("a");
  link.className = "citation-link";
  const base = vizBaseUrl();
  link.href = base ? `${base}/drawer/${drawerId}` : `/api/familiar/memory/${drawerId}`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = base ? "view in palace ↗" : "view in palace →";
  popover.appendChild(link);

  return popover;
}

function buildCitationSpan(rawId, meta) {
  const drawerId = `drawer_${rawId}`;
  const wrapper = document.createElement("span");
  wrapper.className = "citation";
  wrapper.setAttribute("data-drawer-id", drawerId);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "citation-trigger";
  btn.setAttribute("aria-label", `Palace source: ${drawerId}`);
  btn.textContent = `[${rawId.slice(0, 6)}]`;

  const popover = buildPopover(drawerId, meta);
  wrapper.appendChild(btn);
  wrapper.appendChild(popover);

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    wrapper.classList.toggle("citation--open");
  });

  return wrapper;
}

/**
 * Replace the assistant element's content with a sequence of text nodes
 * and citation spans. Called once after streaming completes. Uses matchAll
 * so we never touch regex .lastIndex state.
 */
function renderWithCitations(container, text) {
  while (container.firstChild) container.removeChild(container.firstChild);
  let lastIndex = 0;
  for (const match of text.matchAll(CITATION_PATTERN)) {
    const idx = match.index ?? 0;
    if (idx > lastIndex) {
      container.appendChild(document.createTextNode(text.slice(lastIndex, idx)));
    }
    const drawerId = `drawer_${match[1]}`;
    const meta = traceLookup.get(drawerId) || null;
    container.appendChild(buildCitationSpan(match[1], meta));
    lastIndex = idx + match[0].length;
  }
  if (lastIndex < text.length) {
    container.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}

// Close any open popover when clicking outside.
document.addEventListener("click", () => {
  document.querySelectorAll(".citation--open").forEach((el) => el.classList.remove("citation--open"));
});

// Per-session map of drawer_id → entity metadata, populated from the trace
// SSE event the chat route emits when ?trace=1 is set.
const traceLookup = new Map();

function ingestTrace(trace) {
  if (!trace || !Array.isArray(trace.retrieved)) return;
  for (const e of trace.retrieved) {
    if (!e || !e.id) continue;
    traceLookup.set(e.id, {
      wing: e.wing,
      room: e.room,
      text: e.content_snippet,
    });
  }
}

// ---------- Sessions (client-side state) ----------
//
// localStorage shape:
//   familiar_sessions: { active: string, list: [{ id, label, createdAt, lastSeenAt, turns: [...] }] }
// Migrated from the v0.3.0 single-key form (familiar_session_id).

const SESSIONS_KEY = "familiar_sessions";
const LEGACY_KEY = "familiar_session_id";

function loadSessions() {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.list) && parsed.active) return parsed;
    }
  } catch { /* fall through to migration */ }
  // Migrate legacy single-session form, or create fresh.
  const legacy = localStorage.getItem(LEGACY_KEY);
  const id = legacy || newSessionId();
  const sess = { id, label: defaultLabel(new Date()), createdAt: Date.now(), lastSeenAt: Date.now(), turns: [] };
  return { active: id, list: [sess] };
}
function saveSessions() {
  try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(state)); } catch { /* quota */ }
}
function newSessionId() {
  return (crypto.randomUUID && crypto.randomUUID()) || (Math.random().toString(36).slice(2) + Date.now());
}
function defaultLabel(d) {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${hh}:${mm}`;
}

const state = loadSessions();
let activeSession = state.list.find((s) => s.id === state.active) || state.list[0];

function setActiveSession(id) {
  const found = state.list.find((s) => s.id === id);
  if (!found) return;
  activeSession = found;
  state.active = id;
  saveSessions();
  renderTranscript();
  renderSessionsList();
}

function createSession() {
  const sess = { id: newSessionId(), label: defaultLabel(new Date()), createdAt: Date.now(), lastSeenAt: Date.now(), turns: [] };
  state.list.unshift(sess);
  setActiveSession(sess.id);
  closeSessionsPanel();
  input.focus();
}

function deleteSession(id) {
  const idx = state.list.findIndex((s) => s.id === id);
  if (idx < 0) return;
  state.list.splice(idx, 1);
  if (state.list.length === 0) {
    createSession();
    return;
  }
  if (state.active === id) setActiveSession(state.list[0].id);
  else { saveSessions(); renderSessionsList(); }
}

function renameSession(id) {
  const sess = state.list.find((s) => s.id === id);
  if (!sess) return;
  const next = window.prompt("rename session:", sess.label);
  if (next === null) return;
  sess.label = next.trim().slice(0, 60) || sess.label;
  saveSessions();
  renderSessionsList();
}

function appendTurnToSession(role, content) {
  if (!activeSession) return;
  activeSession.turns.push({ role, content });
  activeSession.lastSeenAt = Date.now();
  // Use the user's first message as the auto-label if still default.
  if (role === "user" && /^[A-Z][a-z]+ \d+ \d{2}:\d{2}$/.test(activeSession.label)) {
    activeSession.label = content.slice(0, 60);
  }
  saveSessions();
  renderSessionsList();
}

function renderTranscript() {
  while (log.firstChild) log.removeChild(log.firstChild);
  if (!activeSession || activeSession.turns.length === 0) return;
  for (const t of activeSession.turns) {
    const el = appendMessage(t.role, t.content);
    if (t.role === "assistant") renderWithCitations(el, t.content);
  }
}

function renderSessionsList() {
  while (sessionsList.firstChild) sessionsList.removeChild(sessionsList.firstChild);
  const sorted = [...state.list].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  if (sorted.length === 0) {
    const empty = document.createElement("li");
    empty.className = "sessions-empty";
    empty.textContent = "no sessions yet — they'll appear here";
    sessionsList.appendChild(empty);
    return;
  }
  for (const sess of sorted) {
    const li = document.createElement("li");
    if (sess.id === state.active) li.classList.add("active");

    const marker = document.createElement("span");
    marker.className = "session-marker";
    marker.textContent = sess.id === state.active ? "✦" : "·";
    li.appendChild(marker);

    const label = document.createElement("span");
    label.className = "session-label";
    label.textContent = sess.label;
    li.appendChild(label);

    const date = document.createElement("span");
    date.className = "session-date";
    date.textContent = relTime(sess.lastSeenAt);
    li.appendChild(date);

    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "session-rename";
    renameBtn.title = "rename";
    renameBtn.setAttribute("aria-label", "rename");
    renameBtn.textContent = "✎";
    renameBtn.addEventListener("click", (e) => { e.stopPropagation(); renameSession(sess.id); });
    li.appendChild(renameBtn);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "session-delete";
    delBtn.title = "delete";
    delBtn.setAttribute("aria-label", "delete");
    delBtn.textContent = "✕";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (confirm(`delete session "${sess.label}"? this cannot be undone.`)) deleteSession(sess.id);
    });
    li.appendChild(delBtn);

    li.addEventListener("click", () => { setActiveSession(sess.id); closeSessionsPanel(); });
    sessionsList.appendChild(li);
  }
}

function relTime(ts) {
  const ms = Date.now() - ts;
  if (ms < 60_000) return "just now";
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86400_000) return `${Math.floor(ms / 3600_000)}h`;
  return `${Math.floor(ms / 86400_000)}d`;
}

function toggleSessionsPanel() { sessionsPanel.hidden ? openSessionsPanel() : closeSessionsPanel(); }
function openSessionsPanel() { renderSessionsList(); sessionsPanel.hidden = false; }
function closeSessionsPanel() { sessionsPanel.hidden = true; }

sigilBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleSessionsPanel(); });
sessionsNew.addEventListener("click", (e) => { e.stopPropagation(); createSession(); });
// Click outside closes panel.
document.addEventListener("click", (e) => {
  if (sessionsPanel.hidden) return;
  if (sessionsPanel.contains(e.target)) return;
  closeSessionsPanel();
});

// ---------- Reflect pill ----------

function buildReflectPill(decisions, summary) {
  const pill = document.createElement("button");
  pill.type = "button";
  pill.className = "reflect-pill";
  if (summary.total === 0) pill.dataset.empty = "true";

  const glyph = document.createElement("span");
  glyph.className = "reflect-glyph";
  glyph.textContent = "✦";
  pill.appendChild(glyph);

  const text = document.createElement("span");
  if (summary.written === 0 && summary.duplicate === 0) {
    text.textContent = `nothing new`;
  } else {
    const parts = [];
    if (summary.written) parts.push(`${summary.written} remembered`);
    if (summary.duplicate) parts.push(`${summary.duplicate} already known`);
    text.textContent = parts.join(" · ");
  }
  pill.appendChild(text);

  const detail = document.createElement("div");
  detail.className = "reflect-detail";
  if (decisions.length > 0) {
    const list = document.createElement("ul");
    for (const d of decisions) {
      const li = document.createElement("li");
      const fact = document.createElement("span");
      fact.className = "reflect-fact";
      fact.textContent = d.candidate?.fact ?? "?";
      const status = document.createElement("span");
      status.className = "reflect-status";
      status.textContent = `(${d.status}${d.reason ? ` — ${d.reason}` : ""})`;
      li.appendChild(fact);
      li.appendChild(status);
      list.appendChild(li);
    }
    detail.appendChild(list);
  } else {
    detail.textContent = "(no candidates extracted)";
  }

  pill.addEventListener("click", () => {
    const open = detail.dataset.open === "true";
    detail.dataset.open = open ? "false" : "true";
  });

  const wrapper = document.createElement("div");
  wrapper.appendChild(pill);
  wrapper.appendChild(detail);
  return wrapper;
}

// ---------- Chat IO ----------

function appendMessage(role, initialContent = "") {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.textContent = initialContent;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

function setStatus(state, text) {
  status.className = `status ${state}`;
  status.textContent = text;
}

async function checkHealth() {
  try {
    const r = await fetch("/api/familiar/health");
    if (!r.ok) { setStatus("error", "degraded"); return; }
    const d = await r.json();
    const palace = d.dependencies?.palace_daemon;
    const recall = palace?.recall_quality;
    if (palace?.status !== "ok") {
      setStatus("error", "palace busy");
    } else if (recall === "empty_hnsw") {
      setStatus("warn", "palace rebuilding");
    } else if (recall === "probe_error") {
      setStatus("warn", "palace slow");
    } else {
      setStatus("connected", "connected");
    }
    if (d.version?.word && word.textContent !== d.version.word) word.textContent = d.version.word;
  } catch {
    setStatus("error", "offline");
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  submit.disabled = true;

  appendMessage("user", text);
  appendTurnToSession("user", text);

  const assistantEl = appendMessage("assistant", "");

  // Build the full history payload from the active session's turns.
  const history = activeSession.turns.map((t) => ({ role: t.role, content: t.content }));

  try {
    const res = await fetch("/v1/chat/completions?trace=1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: history,
        user: activeSession.id,
        stream: true,
      }),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let full = "";
    let reflectPayload = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const eventBlock = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const lines = eventBlock.split("\n");
        const eventType = lines.find((l) => l.startsWith("event: "))?.slice(7).trim();
        const dataLine = lines.find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        const payload = dataLine.slice(6).trim();
        if (payload === "[DONE]") continue;

        if (eventType === "trace") {
          try { ingestTrace(JSON.parse(payload)); } catch { /* skip */ }
          continue;
        }
        if (eventType === "reflect") {
          try { reflectPayload = JSON.parse(payload); } catch { /* skip */ }
          continue;
        }

        try {
          const obj = JSON.parse(payload);
          const delta = obj.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            assistantEl.textContent = full;
            log.scrollTop = log.scrollHeight;
          }
        } catch { /* skip malformed */ }
      }
    }
    appendTurnToSession("assistant", full);
    renderWithCitations(assistantEl, full);
    if (reflectPayload && reflectPayload.summary) {
      assistantEl.appendChild(buildReflectPill(reflectPayload.decisions || [], reflectPayload.summary));
    }
  } catch (err) {
    assistantEl.textContent = `(the familiar did not respond: ${err.message})`;
  } finally {
    submit.disabled = false;
    input.focus();
  }
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

// Boot: render the active session's transcript so reload doesn't lose state.
renderTranscript();
checkHealth();
setInterval(checkHealth, 60_000);
