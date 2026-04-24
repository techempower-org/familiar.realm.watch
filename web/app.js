// Vanilla chat UI. Streams /v1/chat/completions SSE into the transcript.
const log = document.getElementById("log");
const form = document.getElementById("form");
const input = document.getElementById("input");
const submit = form.querySelector("button");
const status = document.getElementById("status");

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
    const res = await fetch("/v1/chat/completions", {
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
        const event = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = event.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;
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
