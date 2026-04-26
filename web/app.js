// Vanilla chat UI. Streams /v1/chat/completions SSE into the transcript.
const log = document.getElementById("log");
const form = document.getElementById("form");
const input = document.getElementById("input");
const submit = form.querySelector("button");
const status = document.getElementById("status");

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

function getOrCreateSessionId() {
  const key = "familiar_session_id";
  let sid = localStorage.getItem(key);
  if (!sid) {
    sid = (crypto.randomUUID && crypto.randomUUID()) || (Math.random().toString(36).slice(2) + Date.now());
    localStorage.setItem(key, sid);
  }
  return sid;
}

const sessionId = getOrCreateSessionId();
const history = [];

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
    if (r.ok) setStatus("connected", "connected");
    else setStatus("error", "degraded");
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
  history.push({ role: "user", content: text });

  const assistantEl = appendMessage("assistant", "");

  try {
    const res = await fetch("/v1/chat/completions?trace=1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: history,
        user: sessionId,
        stream: true,
      }),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let full = "";
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

        // Trace event arrives just before [DONE] when ?trace=1 is set.
        if (eventType === "trace") {
          try { ingestTrace(JSON.parse(payload)); } catch { /* skip */ }
          continue;
        }

        // Otherwise it's a regular OpenAI-compat chat chunk.
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
    history.push({ role: "assistant", content: full });
    // After streaming completes, replace the plain text with citation-aware DOM.
    renderWithCitations(assistantEl, full);
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

checkHealth();
setInterval(checkHealth, 60_000);
