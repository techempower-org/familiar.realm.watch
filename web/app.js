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

// Citation rendering — converts [drawer_xxx] markers AND verbatim source-
// header markers (echoed from the system prompt) into styled chips. DOM-
// only, no innerHTML. Two variants share one combined regex to avoid the
// two-pass walk-replace dance.
//
//  variant A:  [drawer_xxx]                                  → popover button
//  variant B:  [wing=X · room=Y · date=Z · similarity=N
//                  · matched_via=M]                          → source chip
const CITATION_PATTERN =
  /\[(?:(drawer_[a-z0-9]+)|wing=([^\s·\]]+)\s*·\s*room=([^\s·\]]+)\s*·\s*date=([\d-]+)\s*·\s*similarity=([\d.]+)\s*·\s*matched_via=([^\]]+))\]/g;

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

function buildSourceChip(wing, room, date, similarity, via) {
  const chip = document.createElement("span");
  chip.className = "src-chip";
  chip.setAttribute("title", `${date} · sim ${similarity} · ${via}`);

  const glyph = document.createElement("span");
  glyph.className = "src-chip-glyph";
  glyph.textContent = "❖";
  chip.appendChild(glyph);

  const label = document.createElement("span");
  label.className = "src-chip-label";
  // Strip any "wing_" prefix the fork uses internally for cleaner display.
  const prettyWing = wing.replace(/^wing_/, "");
  label.textContent = ` ${prettyWing} · ${room}`;
  chip.appendChild(label);

  return chip;
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
    if (match[1]) {
      // Variant A: [drawer_xxx]
      const drawerId = match[1];
      const rawId = drawerId.slice(7); // strip "drawer_"
      const meta = traceLookup.get(drawerId) || null;
      container.appendChild(buildCitationSpan(rawId, meta));
    } else {
      // Variant B: [wing=X · room=Y · date=Z · similarity=N · matched_via=M]
      container.appendChild(buildSourceChip(match[2], match[3], match[4], match[5], match[6]));
    }
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

// Single footer for an assistant turn — shows BOTH context (drawers retrieved
// to ground this turn) AND reflect (facts written back to palace). Always
// renders even when one or both are empty/skipped, so the user can see the
// pipeline.

function buildTurnFooter(traceData, reflectData) {
  const footer = document.createElement("div");
  footer.className = "turn-footer";

  // ----- Context pill -----
  if (traceData) {
    const retrieved = Array.isArray(traceData.retrieved) ? traceData.retrieved : [];
    const wrap = document.createElement("div");
    wrap.className = "footer-row";

    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "ctx-pill";
    pill.appendChild(makeGlyph("✦"));
    const txt = document.createElement("span");
    txt.textContent = retrieved.length === 0
      ? "no palace context"
      : `${retrieved.length} drawer${retrieved.length === 1 ? "" : "s"} grounded this turn`;
    pill.appendChild(txt);
    if (retrieved.length === 0) pill.classList.add("ctx-pill-empty");
    wrap.appendChild(pill);

    const detail = document.createElement("div");
    detail.className = "ctx-detail";
    if (retrieved.length > 0) {
      for (const e of retrieved) {
        const item = document.createElement("div");
        item.className = "ctx-item";
        const wing = (e.wing || "?").replace(/^wing_/, "");
        const room = e.room || "?";
        const sim = typeof e.cosine === "number" ? e.cosine.toFixed(3) : (typeof e.bm25 === "number" ? `bm25 ${e.bm25.toFixed(3)}` : "?");

        const head = document.createElement("div");
        head.className = "ctx-item-head";
        const chip = document.createElement("span");
        chip.className = "src-chip";
        chip.appendChild(makeGlyph("❖", "src-chip-glyph"));
        const lbl = document.createElement("span");
        lbl.className = "src-chip-label";
        lbl.textContent = ` ${wing} · ${room}`;
        chip.appendChild(lbl);
        head.appendChild(chip);
        const sc = document.createElement("span");
        sc.className = "ctx-score";
        sc.textContent = sim;
        head.appendChild(sc);
        item.appendChild(head);

        if (e.content_snippet) {
          const sn = document.createElement("p");
          sn.className = "ctx-snippet";
          sn.textContent = e.content_snippet.length > 220
            ? e.content_snippet.slice(0, 220) + "…"
            : e.content_snippet;
          item.appendChild(sn);
        }
        detail.appendChild(item);
      }
    }
    pill.addEventListener("click", () => {
      detail.dataset.open = detail.dataset.open === "true" ? "false" : "true";
    });
    wrap.appendChild(detail);
    footer.appendChild(wrap);
  }

  // ----- Reflect pill -----
  if (reflectData) {
    const summary = reflectData.summary || { written: 0, gated: 0, duplicate: 0, total: 0 };
    const decisions = Array.isArray(reflectData.decisions) ? reflectData.decisions : [];
    const skipped = reflectData.skipped;
    const wrap = document.createElement("div");
    wrap.className = "footer-row";

    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "reflect-pill";
    pill.appendChild(makeGlyph("✦", "reflect-glyph"));

    const txt = document.createElement("span");
    if (skipped === "too_short") txt.textContent = "reflect skipped (turn brief)";
    else if (skipped === "timeout") txt.textContent = "reflect still working…";
    else if (skipped === "error") txt.textContent = "reflect errored";
    else if (skipped === "no_writer") txt.textContent = "reflect disabled";
    else if (summary.written === 0 && summary.duplicate === 0) txt.textContent = "no new memories";
    else {
      const parts = [];
      if (summary.written) parts.push(`${summary.written} remembered`);
      if (summary.duplicate) parts.push(`${summary.duplicate} already known`);
      txt.textContent = parts.join(" · ");
    }
    pill.appendChild(txt);
    wrap.appendChild(pill);

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
    } else if (skipped) {
      const hint = document.createElement("p");
      hint.className = "reflect-hint";
      if (skipped === "too_short") hint.textContent = `reflect runs only on assistant turns of 80+ characters; this one was shorter.`;
      else if (skipped === "timeout") hint.textContent = `reflect didn't return within the chat budget. drawers may still be writing in the background.`;
      else if (skipped === "error") hint.textContent = `the extractor or palace failed; nothing written this turn.`;
      else hint.textContent = `reflect is disabled on this server.`;
      detail.appendChild(hint);
    } else {
      const hint = document.createElement("p");
      hint.className = "reflect-hint";
      hint.textContent = "(no candidates extracted)";
      detail.appendChild(hint);
    }
    pill.addEventListener("click", () => {
      detail.dataset.open = detail.dataset.open === "true" ? "false" : "true";
    });
    wrap.appendChild(detail);
    footer.appendChild(wrap);
  }

  return footer;
}

function makeGlyph(text, cls) {
  const g = document.createElement("span");
  if (cls) g.className = cls;
  g.textContent = text;
  return g;
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
    let tracePayload = null;
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
          try {
            tracePayload = JSON.parse(payload);
            ingestTrace(tracePayload);
          } catch { /* skip */ }
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
    // Always render the footer so the user can see the pipeline (memories
    // grounded, reflect outcome) even when reflect was skipped/timed-out.
    assistantEl.appendChild(buildTurnFooter(tracePayload, reflectPayload));
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
