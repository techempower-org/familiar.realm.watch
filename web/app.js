// Vanilla chat UI. Streams /v1/chat/completions SSE into the transcript.
// v0.3.1 — multi-session sidebar, reflect pill, finer status.
const log = document.getElementById("log");
const form = document.getElementById("form");
const input = document.getElementById("input");
const submit = form.querySelector('button[type="submit"]');
const status = document.getElementById("status");
const word = document.getElementById("word");
const sigilBtn = document.getElementById("sigil");
const sessionsList = document.getElementById("sessions-list");
const sessionsNew = document.getElementById("sessions-new");
const hdrMenu = document.getElementById("hdr-menu");
const sidebarScrim = document.getElementById("sidebar-scrim");
const memoriesList = document.getElementById("memories-list");
const memoriesRefresh = document.getElementById("memories-refresh");
const voiceEnabled = document.getElementById("voice-enabled");
const voicePicker = document.getElementById("voice-picker");

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

// ------------------------ Minimal markdown ------------------------
// Vanilla parser — no dependencies. Handles the patterns Qwen 2.5 actually
// produces in chat: paragraphs, bold/italic, inline + fenced code, headings,
// bullet & numbered lists, autolinks, [text](url) links. Skip tables,
// footnotes, blockquotes — model doesn't use them. All output uses textContent
// so HTML in model responses can never escape into innerHTML.

function parseMarkdown(text) {
  const root = document.createElement("div");
  root.className = "md";
  // Block-level split: blank line(s) separate blocks. Keep code fences intact
  // by walking lines and grouping fenced regions before the blank-line split.
  const blocks = splitBlocks(text);
  for (const block of blocks) parseBlock(root, block);
  return root;
}

function splitBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  let buf = [];
  let inFence = false;
  let fenceTag = "";

  const flush = () => {
    if (buf.length) { blocks.push(buf.join("\n")); buf = []; }
  };

  for (const line of lines) {
    const fence = line.match(/^(\s*)(```+)(.*)$/);
    if (fence) {
      const tag = fence[2];
      if (!inFence) {
        // Force a block boundary so a fence touching the line above (e.g. a
        // heading or paragraph with no blank line between) doesn't get
        // glued into a single block that no parser branch matches.
        flush();
        inFence = true;
        fenceTag = tag;
        buf.push(line);
        continue;
      }
      // Close fence iff equal-or-greater backtick count.
      if (line.trim().startsWith(fenceTag)) {
        inFence = false;
        buf.push(line);
        flush();
        continue;
      }
      buf.push(line);
      continue;
    }
    if (inFence) { buf.push(line); continue; }

    // Headings stand alone — split above and below so `parseBlock`'s
    // heading matcher (which rejects multi-line input) actually fires.
    if (/^#{1,6}\s+\S/.test(line)) {
      flush();
      blocks.push(line);
      continue;
    }

    // Horizontal rule on its own line — flush above + below.
    if (/^\s*[-*_]{3,}\s*$/.test(line)) {
      flush();
      blocks.push(line);
      continue;
    }

    if (line.trim() === "") {
      flush();
    } else {
      buf.push(line);
    }
  }
  flush();
  return blocks;
}

function parseBlock(parent, block) {
  block = block.replace(/^\n+|\n+$/g, "");
  if (!block) return;

  // Fenced code block.
  const fence = block.match(/^```([\w-]*)\n([\s\S]*?)\n?```$/);
  if (fence) {
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    if (fence[1]) code.className = `language-${fence[1]}`;
    code.textContent = fence[2];
    pre.appendChild(code);
    parent.appendChild(pre);
    return;
  }

  // Horizontal rule: --- *** ___ alone on a line.
  if (/^[-*_]{3,}\s*$/.test(block)) {
    parent.appendChild(document.createElement("hr"));
    return;
  }

  // Heading (single-line block).
  const heading = block.match(/^(#{1,6})\s+(.*)$/);
  if (heading && !block.includes("\n")) {
    const h = document.createElement(`h${heading[1].length}`);
    parseInline(h, heading[2]);
    parent.appendChild(h);
    return;
  }

  // Blockquote: every non-empty line starts with `> `.
  const quoteLines = block.split("\n");
  if (quoteLines.every((l) => /^>\s?/.test(l))) {
    const bq = document.createElement("blockquote");
    const inner = quoteLines.map((l) => l.replace(/^>\s?/, "")).join("\n");
    // Recursively parse the unwrapped content so quoted lists/paragraphs work.
    parseBlock(bq, inner);
    parent.appendChild(bq);
    return;
  }

  // Table: line 1 has | separators, line 2 is | --- | --- | divider.
  const tableMatch = parseTable(block);
  if (tableMatch) {
    parent.appendChild(tableMatch);
    return;
  }

  // Lists: every line matches a list-item shape.
  const lines = block.split("\n");
  const ulRe = /^\s*[-*+]\s+(.*)$/;
  const olRe = /^\s*(\d+)\.\s+(.*)$/;
  if (lines.every((l) => ulRe.test(l) || olRe.test(l))) {
    const isOrdered = olRe.test(lines[0]);
    const list = document.createElement(isOrdered ? "ol" : "ul");
    for (const line of lines) {
      const m = isOrdered ? line.match(olRe) : line.match(ulRe);
      const itemText = m ? (isOrdered ? m[2] : m[1]) : line;
      const li = document.createElement("li");
      parseInline(li, itemText);
      list.appendChild(li);
    }
    parent.appendChild(list);
    return;
  }

  // Default: paragraph. "  \n" forces hard break; otherwise newlines become <br>.
  const p = document.createElement("p");
  const segments = block.split(/\n/);
  segments.forEach((seg, i) => {
    parseInline(p, seg.replace(/\s{2,}$/, ""));
    if (i < segments.length - 1) p.appendChild(document.createElement("br"));
  });
  parent.appendChild(p);
}

function parseTable(block) {
  const lines = block.split("\n");
  if (lines.length < 2) return null;
  const headerRow = lines[0];
  const dividerRow = lines[1];
  // header must contain a pipe; divider must be a row of |---|---| (with optional :)
  if (!headerRow.includes("|")) return null;
  if (!/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(dividerRow)) return null;

  function splitRow(row) {
    let r = row.trim();
    if (r.startsWith("|")) r = r.slice(1);
    if (r.endsWith("|")) r = r.slice(0, -1);
    return r.split("|").map((c) => c.trim());
  }

  const headers = splitRow(headerRow);
  const aligns = splitRow(dividerRow).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
  const rows = lines.slice(2).map(splitRow);

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headTr = document.createElement("tr");
  headers.forEach((h, i) => {
    const th = document.createElement("th");
    if (aligns[i]) th.style.textAlign = aligns[i];
    parseInline(th, h);
    headTr.appendChild(th);
  });
  thead.appendChild(headTr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    row.forEach((cell, i) => {
      const td = document.createElement("td");
      if (aligns[i]) td.style.textAlign = aligns[i];
      parseInline(td, cell);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

// Inline parser — single-pass alternation regex. Order matters: longer
// patterns before shorter ones (e.g. **bold** before *italic*).
//
// NOTE: We deliberately omit `_italic_` and `__bold__`. Underscores are
// load-bearing in identifiers (snake_case Python, mempalace_search,
// url_for) — letting the parser eat them turns prose like
// "mempalace_search calls" into "mempalace<em>search</em> calls" and
// strips the underscores from the visible text. CommonMark guards
// against this with word-boundary rules, but the cost of getting that
// right is more than the value of supporting underscore-emphasis here.
// Stick with asterisk forms only; the model uses them more anyway.
const INLINE_RE = new RegExp([
  "(\\*\\*[^*\\n]+\\*\\*)",            // **bold**
  "(`[^`\\n]+`)",                       // `code`
  "(~~[^~\\n]+~~)",                     // ~~strikethrough~~
  "(\\*[^*\\n]+\\*)",                   // *italic*
  "(!?\\[[^\\]\\n]+\\]\\([^)\\s]+\\))", // [text](url) or ![alt](url)
  "(https?://[^\\s<>]+)",               // bare URL
].join("|"), "g");

function parseInline(parent, text) {
  // Capture group order matches INLINE_RE alternation:
  //   1: **bold**   2: `code`   3: ~~strike~~   4: *italic*
  //   5: [text](url) or ![alt](url)   6: bare URL
  let lastIdx = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index;
    if (idx > lastIdx) parent.appendChild(document.createTextNode(text.slice(lastIdx, idx)));
    if (m[1]) {
      const s = document.createElement("strong");
      s.textContent = m[1].slice(2, -2);
      parent.appendChild(s);
    } else if (m[2]) {
      const c = document.createElement("code");
      c.textContent = m[2].slice(1, -1);
      parent.appendChild(c);
    } else if (m[3]) {
      const s = document.createElement("s");
      s.textContent = m[3].slice(2, -2);
      parent.appendChild(s);
    } else if (m[4]) {
      const e = document.createElement("em");
      e.textContent = m[4].slice(1, -1);
      parent.appendChild(e);
    } else if (m[5]) {
      const linkMatch = m[5].match(/^!?\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch) parent.appendChild(buildLink(linkMatch[1], linkMatch[2]));
      else parent.appendChild(document.createTextNode(m[5]));
    } else if (m[6]) {
      parent.appendChild(buildLink(m[6], m[6]));
    }
    lastIdx = idx + m[0].length;
  }
  if (lastIdx < text.length) parent.appendChild(document.createTextNode(text.slice(lastIdx)));
}

function buildLink(label, href) {
  const a = document.createElement("a");
  // Only allow safe protocols; fall back to text if anything weird.
  if (!/^(https?:|\/|#|mailto:)/.test(href)) {
    const span = document.createElement("span");
    span.textContent = label;
    return span;
  }
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = label;
  return a;
}

// ------------- Citation overlay on markdown DOM -------------
// After markdown parsing produces a tree of element nodes, walk text nodes
// and replace [drawer_xxx] / [wing=...] markers with their styled spans.

function applyCitationsInPlace(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) {
    // Skip text inside <code>/<pre> — those are literal.
    let p = node.parentNode;
    let inCode = false;
    while (p && p !== root) {
      if (p.tagName === "CODE" || p.tagName === "PRE") { inCode = true; break; }
      p = p.parentNode;
    }
    if (!inCode) textNodes.push(node);
  }
  for (const tn of textNodes) {
    const text = tn.nodeValue;
    if (!text.includes("[")) continue;
    const fragment = document.createDocumentFragment();
    let lastIdx = 0;
    let any = false;
    for (const match of text.matchAll(CITATION_PATTERN)) {
      any = true;
      const idx = match.index ?? 0;
      if (idx > lastIdx) fragment.appendChild(document.createTextNode(text.slice(lastIdx, idx)));
      if (match[1]) {
        const drawerId = match[1];
        const rawId = drawerId.slice(7);
        const meta = traceLookup.get(drawerId) || null;
        fragment.appendChild(buildCitationSpan(rawId, meta));
      } else {
        fragment.appendChild(buildSourceChip(match[2], match[3], match[4], match[5], match[6]));
      }
      lastIdx = idx + match[0].length;
    }
    if (!any) continue;
    if (lastIdx < text.length) fragment.appendChild(document.createTextNode(text.slice(lastIdx)));
    tn.parentNode.replaceChild(fragment, tn);
  }
}

// ---- Code-block enhancers: syntax highlight + copy-to-clipboard ----
//
// hljs (highlight.js) is loaded as a global via /highlight.min.js. We call
// it after markdown parsing so each <code> inside a <pre> picks up
// language detection and class-based coloring. Copy buttons are pure DOM.

function enhanceCodeBlocks(root) {
  const pres = root.querySelectorAll("pre");
  for (const pre of pres) {
    const code = pre.querySelector("code");
    if (!code) continue;

    // Highlight (best-effort — never throw).
    if (typeof hljs !== "undefined" && hljs.highlightElement) {
      try { hljs.highlightElement(code); } catch { /* skip */ }
    }

    // Wrap pre so the copy button can position absolutely above it.
    if (pre.parentNode && !pre.parentNode.classList?.contains("code-wrap")) {
      const wrap = document.createElement("div");
      wrap.className = "code-wrap";
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "code-copy";
      copyBtn.title = "copy code";
      copyBtn.setAttribute("aria-label", "copy code");
      copyBtn.textContent = "copy";
      copyBtn.addEventListener("click", async () => {
        const text = code.textContent || "";
        try {
          await navigator.clipboard.writeText(text);
          copyBtn.textContent = "copied";
          copyBtn.classList.add("copied");
          setTimeout(() => {
            copyBtn.textContent = "copy";
            copyBtn.classList.remove("copied");
          }, 1500);
        } catch {
          copyBtn.textContent = "failed";
          setTimeout(() => { copyBtn.textContent = "copy"; }, 1500);
        }
      });
      wrap.appendChild(copyBtn);
    }
  }
}

/**
 * Replace the assistant element's content with markdown-parsed DOM, then
 * apply citation/chip overlays. Called once after streaming completes.
 */
function renderWithCitations(container, text) {
  while (container.firstChild) container.removeChild(container.firstChild);
  const md = parseMarkdown(text);
  applyCitationsInPlace(md);
  enhanceCodeBlocks(md);
  // Hoist md children into container — avoid extra wrapper element.
  while (md.firstChild) container.appendChild(md.firstChild);
}

/**
 * Streaming-aware partial markdown render.
 *
 * During an SSE stream we get chunks like "**bold tex" then "t** more".
 * Naïvely parsing every chunk would flicker as ** open/close states
 * resolve. Instead, find the last "stable" boundary — a paragraph break
 * `\n\n` outside any open code fence — render markdown for everything
 * before it, and append the trailing "still in flight" remainder as a
 * plain-text node. The plain-text remainder gets the streaming class
 * so it preserves whitespace.
 *
 * Citations / source chips / code highlighting / copy buttons are
 * *not* applied during streaming — they need the final text to be
 * stable. They're added by the post-stream renderWithCitations call.
 */
function streamingMarkdownRender(container, text) {
  // Find the last safe boundary: a `\n\n` that's outside any open code fence.
  let inFence = false;
  let lastSafe = 0;
  const lines = text.split("\n");
  let charPos = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Treat any line of just ``` as toggling fence.
    if (/^\s*```/.test(line)) inFence = !inFence;
    // Blank line outside a fence is a safe block boundary.
    if (!inFence && i > 0 && line.trim() === "" && lines[i - 1].trim() !== "") {
      // charPos points at the start of THIS blank line; the safe boundary
      // is that point, which means everything BEFORE it is renderable.
      lastSafe = charPos;
    }
    charPos += line.length + 1; // +1 for the \n
  }

  const stable = lastSafe > 0 ? text.slice(0, lastSafe) : "";
  const trailing = lastSafe > 0 ? text.slice(lastSafe) : text;

  while (container.firstChild) container.removeChild(container.firstChild);

  if (stable) {
    const md = parseMarkdown(stable);
    while (md.firstChild) container.appendChild(md.firstChild);
  }
  if (trailing) {
    const tail = document.createElement("span");
    tail.className = "stream-tail";
    tail.textContent = trailing;
    container.appendChild(tail);
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
  closeSidebar();
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
    if (t.role === "assistant") {
      renderWithCitations(el, t.content);
      // Reloaded turns also get a speak button so you can replay them.
      el.appendChild(buildSpeakButton(() => t.content));
    }
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

    li.addEventListener("click", () => { setActiveSession(sess.id); closeSidebar(); });
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

// Sidebar drawer toggle (mobile only — desktop has sidebar always visible).
function toggleSidebar() { document.body.classList.toggle("sidebar-open"); }
function closeSidebar() { document.body.classList.remove("sidebar-open"); }

sigilBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleSidebar(); });
hdrMenu.addEventListener("click", (e) => { e.stopPropagation(); toggleSidebar(); });
sidebarScrim.addEventListener("click", () => closeSidebar());
sessionsNew.addEventListener("click", (e) => { e.stopPropagation(); createSession(); });

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
    if (reflectData.timing) {
      const t = reflectData.timing;
      const timing = document.createElement("span");
      timing.className = "reflect-timing";
      timing.textContent = `extract ${t.extract_ms}ms · dedup ${t.dedup_ms}ms · write ${t.write_ms}ms · total ${t.total_ms}ms`;
      pill.appendChild(timing);
    }
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

// Textarea auto-resize: grow with content, capped by CSS max-height.
// Reset to 1 row on send so the field collapses back after submit.
const autoResize = () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 192)}px`;
};
input.addEventListener("input", autoResize);

// Keyboard: Enter submits, Shift+Enter inserts a newline.
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    form.requestSubmit();
  }
});

// Typing indicator (pulsing dots) shown between submit and first token,
// then until the stream completes. Lives just above the form.
const typingIndicator = document.getElementById("typing-indicator");
const showTyping = () => { if (typingIndicator) typingIndicator.hidden = false; };
const hideTyping = () => { if (typingIndicator) typingIndicator.hidden = true; };

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  // Stop any ongoing TTS so the familiar doesn't talk over the next exchange.
  if (currentUtterance) cancelSpeech();
  input.value = "";
  autoResize();
  submit.disabled = true;
  showTyping();
  setStatus("streaming", "thinking");

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
    // Coalesce stream-render to one rAF tick — many chunks per frame
    // collapse to one parse. Markdown parse is sub-millisecond on
    // typical assistant turns; this keeps the UI smooth without
    // re-parsing per token.
    let renderScheduled = false;
    const scheduleRender = () => {
      if (renderScheduled) return;
      renderScheduled = true;
      requestAnimationFrame(() => {
        renderScheduled = false;
        streamingMarkdownRender(assistantEl, full);
        log.scrollTop = log.scrollHeight;
      });
    };
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
            scheduleRender();
          }
        } catch { /* skip malformed */ }
      }
    }
    appendTurnToSession("assistant", full);
    // Final pass: full markdown + citation chips + code highlighting.
    // The streaming render skipped overlays for stability; now apply them.
    renderWithCitations(assistantEl, full);
    // Speak button — always added; visible on hover or on touch.
    const speakBtn = buildSpeakButton(() => full);
    assistantEl.appendChild(speakBtn);
    // Always render the footer so the user can see the pipeline (memories
    // grounded, reflect outcome) even when reflect was skipped/timed-out.
    assistantEl.appendChild(buildTurnFooter(tracePayload, reflectPayload));
    // Refresh memories sidebar if reflect wrote anything this turn.
    if (reflectPayload?.summary?.written > 0) refreshMemories();
    // Auto-speak when the voice toggle is on.
    if (voiceState.enabled && speechSupported()) speakText(full, speakBtn);
  } catch (err) {
    assistantEl.textContent = `(the familiar did not respond: ${err.message})`;
    setStatus("error", "error");
  } finally {
    submit.disabled = false;
    hideTyping();
    setStatus("connected", "connected");
    input.focus();
  }
});

// ---- Palace view (treemap of wings + rooms + tunnels) ----
const tabChat = document.getElementById("tab-chat");
const tabPalace = document.getElementById("tab-palace");
const palaceView = document.getElementById("palace-view");
const palaceStats = document.getElementById("palace-stats");
const palaceTreemap = document.getElementById("palace-treemap");
const palaceTunnels = document.getElementById("palace-tunnels");
const palaceRefresh = document.getElementById("palace-refresh");

let palaceCache = null;

async function fetchPalaceGraph(force = false) {
  if (palaceCache && !force) return palaceCache;
  const r = await fetch("/api/familiar/graph");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  palaceCache = await r.json();
  return palaceCache;
}

// Memory browser state — drill-down through wings → rooms → drawers.
let browserState = { wing: null, room: null, drawer: null };
let roomsByWingCache = {};

function renderPalace(graph) {
  const wings = graph.wings || {};
  const roomsByWing = Object.fromEntries((graph.rooms || []).map((r) => [r.wing, r.rooms || {}]));
  roomsByWingCache = roomsByWing;
  const wingEntries = Object.entries(wings).sort(([, a], [, b]) => b - a);
  const total = wingEntries.reduce((s, [, n]) => s + n, 0);
  const maxWing = wingEntries[0]?.[1] ?? 1;

  if (palaceStats) {
    const triples = graph.kg_stats?.triples ?? graph.kg_triples?.length ?? 0;
    palaceStats.textContent = `${total.toLocaleString()} drawers · ${wingEntries.length} wings · ${graph.tunnels?.length ?? 0} tunnels · ${triples} kg triples`;
  }

  // Wings column — each is a clickable browser-item with a sparkline.
  while (palaceTreemap.firstChild) palaceTreemap.removeChild(palaceTreemap.firstChild);
  for (const [wing, count] of wingEntries) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "browser-item";
    item.dataset.wing = wing;
    if (browserState.wing === wing) item.classList.add("active");

    const label = document.createElement("span");
    label.className = "browser-item-label";
    label.textContent = wing.replace(/^wing_/, "") || "(unnamed)";
    item.appendChild(label);

    const cnt = document.createElement("span");
    cnt.className = "browser-item-count";
    cnt.textContent = count.toLocaleString();
    item.appendChild(cnt);

    item.addEventListener("click", () => selectWing(wing));
    palaceTreemap.appendChild(item);
  }
  // Suppress the unused-var warning; maxWing is still useful if we ever
  // re-introduce the sparkline bar.
  void maxWing;

  // Tunnels
  while (palaceTunnels.firstChild) palaceTunnels.removeChild(palaceTunnels.firstChild);
  const tunnels = (graph.tunnels || []).sort((a, b) => (b.wings?.length ?? 0) - (a.wings?.length ?? 0));
  if (tunnels.length > 0) {
    const h3 = document.createElement("h3");
    h3.textContent = `tunnels — rooms shared across multiple wings`;
    palaceTunnels.appendChild(h3);
    for (const t of tunnels) {
      const row = document.createElement("div");
      row.className = "tunnel-row";
      const room = document.createElement("span");
      room.className = "tunnel-room";
      room.textContent = t.room;
      row.appendChild(room);
      const wingsBox = document.createElement("div");
      wingsBox.className = "tunnel-wings";
      for (const w of (t.wings || [])) {
        const ws = document.createElement("span");
        ws.className = "tunnel-wing";
        ws.textContent = w.replace(/^wing_/, "");
        wingsBox.appendChild(ws);
      }
      row.appendChild(wingsBox);
      palaceTunnels.appendChild(row);
    }
  }
}

async function showPalace(force = false) {
  if (palaceStats) palaceStats.textContent = "loading…";
  try {
    const graph = await fetchPalaceGraph(force);
    renderPalace(graph);
  } catch (err) {
    if (palaceStats) palaceStats.textContent = `error: ${err.message}`;
  }
}

// ---- Memory browser: wings → rooms → drawers → detail ----
const palaceRoomsCol = document.querySelector(".browser-col-rooms");
const palaceRooms = document.getElementById("palace-rooms");
const palaceRoomsTitle = document.getElementById("palace-rooms-title");
const palaceRoomsBack = document.getElementById("palace-rooms-back");
const palaceDrawersCol = document.querySelector(".browser-col-drawers");
const palaceDrawersEl = document.getElementById("palace-drawers");
const palaceDrawersTitle = document.getElementById("palace-drawers-title");
const palaceDrawersBack = document.getElementById("palace-drawers-back");
const palaceDetail = document.getElementById("palace-detail");
const palaceDetailChain = document.getElementById("palace-detail-chain");
const palaceDetailBody = document.getElementById("palace-detail-body");
const palaceDetailClose = document.getElementById("palace-detail-close");

function clearChildren(el) { while (el.firstChild) el.removeChild(el.firstChild); }

// Canonical 7 rooms (post Phase 1D FK migration). Always show these
// as clickable destinations so the user can browse empty rooms too —
// the cached graph endpoint sometimes lags on which rooms have data.
const CANONICAL_ROOMS = [
  "architecture", "decisions", "discoveries", "planning",
  "problems", "references", "sessions",
];

async function selectWing(wing) {
  browserState = { wing, room: null, drawer: null };
  // Mark active in wings column
  palaceTreemap.querySelectorAll(".browser-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.wing === wing);
  });
  if (!palaceRoomsCol) return;
  palaceRoomsCol.hidden = false;
  palaceRoomsTitle.textContent = (wing.replace(/^wing_/, "") || "(unnamed)") + " · rooms";
  clearChildren(palaceRooms);

  // Optimistic render from the cached graph + canonical 7 (instant).
  const cachedRooms = roomsByWingCache[wing] || {};
  const seen = new Set();
  const renderRoom = (room, count) => {
    if (seen.has(room)) return;
    seen.add(room);
    const item = document.createElement("button");
    item.type = "button";
    item.className = "browser-item";
    item.dataset.room = room;
    const label = document.createElement("span");
    label.className = "browser-item-label";
    label.textContent = room.replace(/_/g, " ");
    item.appendChild(label);
    const cnt = document.createElement("span");
    cnt.className = "browser-item-count";
    cnt.dataset.kind = "room-count";
    cnt.textContent = count == null ? "…" : count.toLocaleString();
    item.appendChild(cnt);
    item.addEventListener("click", () => selectRoom(wing, room));
    palaceRooms.appendChild(item);
  };
  // Cached graph rooms first (most-populated)
  for (const [room, count] of Object.entries(cachedRooms).sort(([, a], [, b]) => b - a)) {
    renderRoom(room, count);
  }
  // Canonical 7 — fill any not in cache, with placeholder counts
  for (const room of CANONICAL_ROOMS) renderRoom(room, null);

  // Reset drawers + detail
  if (palaceDrawersCol) palaceDrawersCol.hidden = true;
  if (palaceDetail) palaceDetail.hidden = true;

  // Live refresh: probe each canonical room's actual count so users see
  // truth even when /api/familiar/graph is stale.
  //
  // Throttled to CONCURRENCY=2 because firing all 7 in parallel was
  // enough to push palace-daemon's recall-probe (which familiar-api
  // fires for /health) past its 5s timeout, briefly tripping the
  // "degraded" health flag. The user-visible latency cost is small
  // (each probe is ~30-80ms on a warm daemon → ~4 round-trips = ~300ms
  // total). Surfaces room counts within the typical UI-tap-to-glance
  // window without producing a thundering herd on the daemon.
  try {
    const CONCURRENCY = 2;
    const results = [];
    for (let i = 0; i < CANONICAL_ROOMS.length; i += CONCURRENCY) {
      const batch = CANONICAL_ROOMS.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(batch.map(async (room) => {
        const r = await fetch(`/api/familiar/memories?wing=${encodeURIComponent(wing)}&room=${encodeURIComponent(room)}&limit=1`);
        if (!r.ok) return [room, null];
        const data = await r.json();
        // Prefer daemon-side `total` (real row count); fall back to limited
        // `count` if older familiar-api version doesn't surface total.
        return [room, data.total ?? data.count];
      }));
      results.push(...batchResults);
      // Bail out of mid-flight batches if user navigated away from this wing.
      if (browserState.wing !== wing) return;
    }
    // Stop if user navigated away
    if (browserState.wing !== wing) return;
    for (const [room, count] of results) {
      if (count == null) continue;
      const item = palaceRooms.querySelector(`.browser-item[data-room="${room}"]`);
      if (!item) continue;
      const cnt = item.querySelector('[data-kind="room-count"]');
      if (cnt) cnt.textContent = count.toLocaleString();
    }
  } catch { /* non-fatal — placeholder counts stay */ }
}

async function selectRoom(wing, room) {
  browserState = { wing, room, drawer: null };
  // Mark active in rooms column
  palaceRooms.querySelectorAll(".browser-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.room === room);
  });
  // Show drawers column with loading state
  if (!palaceDrawersCol) return;
  palaceDrawersCol.hidden = false;
  palaceDrawersTitle.textContent = `${wing.replace(/^wing_/, "")} · ${room} · drawers`;
  clearChildren(palaceDrawersEl);
  const loading = document.createElement("div");
  loading.className = "browser-empty";
  loading.textContent = "loading…";
  palaceDrawersEl.appendChild(loading);
  // Reset detail
  if (palaceDetail) palaceDetail.hidden = true;

  try {
    const params = new URLSearchParams({ wing, room, limit: "50" });
    const r = await fetch(`/api/familiar/memories?${params}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    clearChildren(palaceDrawersEl);
    const drawers = data.drawers || [];
    if (drawers.length === 0) {
      const empty = document.createElement("div");
      empty.className = "browser-empty";
      empty.textContent = "no drawers in this room";
      palaceDrawersEl.appendChild(empty);
      return;
    }
    for (const d of drawers) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "browser-item browser-drawer-item";
      item.dataset.drawerId = d.id;

      const meta = document.createElement("div");
      meta.className = "browser-drawer-meta";
      const idShort = document.createElement("span");
      idShort.textContent = d.id.replace(/^drawer_/, "").slice(-16);
      meta.appendChild(idShort);
      const created = document.createElement("span");
      if (d.created_at) {
        const dt = new Date(d.created_at);
        created.textContent = isNaN(dt) ? d.created_at.slice(0, 10) : dt.toISOString().slice(0, 10);
      }
      meta.appendChild(created);
      item.appendChild(meta);

      const snippet = document.createElement("div");
      snippet.className = "browser-drawer-snippet";
      snippet.textContent = (d.text || "").slice(0, 240);
      item.appendChild(snippet);

      item.addEventListener("click", () => selectDrawer(d));
      palaceDrawersEl.appendChild(item);
    }
  } catch (err) {
    clearChildren(palaceDrawersEl);
    const e = document.createElement("div");
    e.className = "browser-empty";
    e.textContent = `error: ${err.message}`;
    palaceDrawersEl.appendChild(e);
  }
}

function selectDrawer(drawer) {
  browserState.drawer = drawer.id;
  // Mark active
  palaceDrawersEl.querySelectorAll(".browser-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.drawerId === drawer.id);
  });
  if (!palaceDetail) return;
  palaceDetail.hidden = false;
  const chain = `palace → wing:${(drawer.wing || browserState.wing || "?").replace(/^wing_/, "")} → room:${drawer.room || browserState.room || "?"} → ${drawer.id.replace(/^drawer_/, "").slice(-20)}`;
  palaceDetailChain.textContent = chain;
  palaceDetailBody.textContent = drawer.text || "(empty drawer)";
}

if (palaceRoomsBack) {
  palaceRoomsBack.addEventListener("click", () => {
    if (palaceRoomsCol) palaceRoomsCol.hidden = true;
    if (palaceDrawersCol) palaceDrawersCol.hidden = true;
    if (palaceDetail) palaceDetail.hidden = true;
    browserState = { wing: null, room: null, drawer: null };
    palaceTreemap.querySelectorAll(".browser-item.active").forEach((el) => el.classList.remove("active"));
  });
}
if (palaceDrawersBack) {
  palaceDrawersBack.addEventListener("click", () => {
    if (palaceDrawersCol) palaceDrawersCol.hidden = true;
    if (palaceDetail) palaceDetail.hidden = true;
    browserState.room = null;
    browserState.drawer = null;
    palaceRooms.querySelectorAll(".browser-item.active").forEach((el) => el.classList.remove("active"));
  });
}
if (palaceDetailClose) {
  palaceDetailClose.addEventListener("click", () => {
    if (palaceDetail) palaceDetail.hidden = true;
    palaceDrawersEl.querySelectorAll(".browser-item.active").forEach((el) => el.classList.remove("active"));
    browserState.drawer = null;
  });
}

// ---- Sidebar palace search ----
const palaceSearch = document.getElementById("palace-search");
const palaceSearchResults = document.getElementById("palace-search-results");
let searchAbort = null;
let searchDebounce = null;

async function runPalaceSearch(query) {
  if (searchAbort) searchAbort.abort();
  searchAbort = new AbortController();
  clearChildren(palaceSearchResults);
  const loading = document.createElement("li");
  loading.className = "search-results-empty";
  loading.textContent = "searching…";
  palaceSearchResults.appendChild(loading);
  palaceSearchResults.hidden = false;

  try {
    // The /api/familiar/eval route runs the full grounding pipeline
    // (vector + BM25 + graph hybrid retrieval) and returns SmeEntity
    // shapes with content_snippet — exactly what we want for an
    // inline search bar.
    const r = await fetch("/api/familiar/eval", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, mock: true, limit: 8 }),
      signal: searchAbort.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const entities = (data.retrieved_entities || []).slice(0, 8);
    clearChildren(palaceSearchResults);
    if (entities.length === 0) {
      const empty = document.createElement("li");
      empty.className = "search-results-empty";
      empty.textContent = "no matches";
      palaceSearchResults.appendChild(empty);
      return;
    }
    for (const e of entities) {
      const item = document.createElement("li");
      item.className = "search-result-item";
      const meta = document.createElement("div");
      meta.className = "search-result-meta";
      const wingTxt = (e.wing || "?").replace(/^wing_/, "");
      const roomTxt = e.room || "?";
      meta.textContent = `${wingTxt} · ${roomTxt}${e.cosine ? ` · ${e.cosine.toFixed(2)}` : ""}`;
      item.appendChild(meta);
      const snippet = document.createElement("div");
      snippet.className = "search-result-snippet";
      snippet.textContent = e.content_snippet || "";
      item.appendChild(snippet);
      item.addEventListener("click", () => {
        // Open in palace view: switch tab, drill to wing/room, surface drawer
        setTab("palace");
        if (e.wing) {
          selectWing(e.wing);
          if (e.room) {
            // Wait a tick for selectWing to render, then drill
            setTimeout(() => {
              selectRoom(e.wing, e.room).then(() => {
                // Find this drawer in the list + open it
                setTimeout(() => {
                  const btn = palaceDrawersEl.querySelector(`[data-drawer-id="${e.id}"]`);
                  if (btn) btn.click();
                }, 50);
              });
            }, 50);
          }
        }
      });
      palaceSearchResults.appendChild(item);
    }
  } catch (err) {
    if (err.name === "AbortError") return;
    clearChildren(palaceSearchResults);
    const e = document.createElement("li");
    e.className = "search-results-empty";
    e.textContent = `error: ${err.message}`;
    palaceSearchResults.appendChild(e);
  }
}

if (palaceSearch) {
  palaceSearch.addEventListener("input", () => {
    const q = palaceSearch.value.trim();
    if (searchDebounce) clearTimeout(searchDebounce);
    if (!q) {
      palaceSearchResults.hidden = true;
      clearChildren(palaceSearchResults);
      return;
    }
    searchDebounce = setTimeout(() => runPalaceSearch(q), 320);
  });
  // Escape clears results
  palaceSearch.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      palaceSearch.value = "";
      palaceSearchResults.hidden = true;
      clearChildren(palaceSearchResults);
    }
  });
}

function setTab(name) {
  const isChat = name === "chat";
  tabChat.classList.toggle("active", isChat);
  tabChat.setAttribute("aria-selected", String(isChat));
  tabPalace.classList.toggle("active", !isChat);
  tabPalace.setAttribute("aria-selected", String(!isChat));
  log.hidden = !isChat;
  log.style.display = isChat ? "" : "none";
  form.hidden = !isChat;
  form.style.display = isChat ? "" : "none";
  palaceView.hidden = isChat;
  if (!isChat) showPalace(false);
}
tabChat.addEventListener("click", () => setTab("chat"));
tabPalace.addEventListener("click", () => setTab("palace"));
if (palaceRefresh) palaceRefresh.addEventListener("click", () => showPalace(true));

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

// ---- Voice (Web Speech API) ----
//
// Browser-native TTS. Toggle in sidebar; choice + on/off persist in
// localStorage. Speaks assistant turns either automatically (toggle on)
// or per-message via the speak button. Markdown markers + citation
// chips are stripped before TTS so we don't read "asterisk asterisk
// bold asterisk asterisk" or "drawer underscore xyz".

const VOICE_KEY = "familiar_voice_state"; // {enabled: bool, voiceURI: string}
const voiceState = (() => {
  try {
    const raw = localStorage.getItem(VOICE_KEY);
    if (raw) return { enabled: false, voiceURI: "", ...JSON.parse(raw) };
  } catch { /* fall through */ }
  return { enabled: false, voiceURI: "" };
})();

function persistVoiceState() {
  try { localStorage.setItem(VOICE_KEY, JSON.stringify(voiceState)); } catch { /* quota */ }
}

function speechSupported() {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof window.SpeechSynthesisUtterance === "function";
}

let availableVoices = [];
function loadVoices() {
  if (!speechSupported()) return;
  availableVoices = window.speechSynthesis.getVoices();
  // Populate picker — sort by lang then name. Prefer en-* voices first.
  if (!voicePicker) return;
  const cur = voicePicker.value;
  while (voicePicker.firstChild) voicePicker.removeChild(voicePicker.firstChild);
  const sorted = availableVoices.slice().sort((a, b) => {
    const aEn = a.lang?.startsWith("en") ? 0 : 1;
    const bEn = b.lang?.startsWith("en") ? 0 : 1;
    if (aEn !== bEn) return aEn - bEn;
    return (a.name || "").localeCompare(b.name || "");
  });
  for (const v of sorted) {
    const opt = document.createElement("option");
    opt.value = v.voiceURI;
    opt.textContent = `${v.name} · ${v.lang}${v.default ? " (default)" : ""}`;
    voicePicker.appendChild(opt);
  }
  if (voiceState.voiceURI && sorted.find((v) => v.voiceURI === voiceState.voiceURI)) {
    voicePicker.value = voiceState.voiceURI;
  } else if (cur && sorted.find((v) => v.voiceURI === cur)) {
    voicePicker.value = cur;
  }
}

if (speechSupported()) {
  loadVoices();
  // Voices load async on Chrome; fires onvoiceschanged once available.
  if (typeof window.speechSynthesis.onvoiceschanged !== "undefined") {
    window.speechSynthesis.onvoiceschanged = loadVoices;
  }
} else if (voicePicker) {
  voicePicker.disabled = true;
  voicePicker.appendChild(Object.assign(document.createElement("option"), {
    textContent: "speech not supported in this browser",
  }));
  if (voiceEnabled) voiceEnabled.disabled = true;
}

if (voiceEnabled) {
  voiceEnabled.checked = !!voiceState.enabled;
  voiceEnabled.addEventListener("change", () => {
    voiceState.enabled = voiceEnabled.checked;
    persistVoiceState();
    if (!voiceState.enabled) cancelSpeech();
  });
}
if (voicePicker) {
  voicePicker.addEventListener("change", () => {
    voiceState.voiceURI = voicePicker.value;
    persistVoiceState();
  });
}

/**
 * Strip markdown + citation markers from text so TTS reads natural prose.
 * Runs the same markers our renderer handles, in inverse: code fences,
 * inline code, emphasis, citation chips, source chips, headings, hr.
 */
function stripForSpeech(text) {
  let s = text;
  // Drop fenced code blocks entirely — reading them aloud is noise.
  s = s.replace(/```[\s\S]*?```/g, " (code block omitted) ");
  // Inline code → unwrap.
  s = s.replace(/`([^`\n]+)`/g, "$1");
  // Bold/italic/strikethrough markers (asterisks only — we don't render underscores).
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "$1");
  s = s.replace(/\*([^*\n]+)\*/g, "$1");
  s = s.replace(/~~([^~\n]+)~~/g, "$1");
  // Markdown links [text](url) → just the text.
  s = s.replace(/!?\[([^\]\n]+)\]\([^)\s]+\)/g, "$1");
  // Citation drawer markers [drawer_xxx] → drop entirely.
  s = s.replace(/\[drawer_[a-z0-9]+\]/gi, "");
  // Source-header markers [wing=… · room=… · …] → drop.
  s = s.replace(/\[wing=[^\]]+\]/g, "");
  // Headings (# / ## / etc) → drop the marker, keep text.
  s = s.replace(/^#{1,6}\s+/gm, "");
  // Horizontal rules → silence.
  s = s.replace(/^[-*_]{3,}\s*$/gm, "");
  // Collapse runs of whitespace.
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

let currentUtterance = null;

function cancelSpeech() {
  if (!speechSupported()) return;
  window.speechSynthesis.cancel();
  currentUtterance = null;
  document.querySelectorAll(".speak-btn.speaking").forEach((b) => b.classList.remove("speaking"));
}

function speakText(text, btn) {
  if (!speechSupported()) return;
  cancelSpeech();
  const clean = stripForSpeech(text);
  if (!clean) return;
  // No system voices = the SpeechSynthesis API is available but the
  // platform has no TTS engine configured (common on Linux Chrome
  // without speech-dispatcher + espeak-ng installed). Calling .speak()
  // here would silently no-op — the user clicks ♪ and gets no audio
  // and no signal that anything went wrong. Surface it via a one-shot
  // banner on the button + log so they know to install a TTS engine.
  if (!availableVoices || availableVoices.length === 0) {
    if (btn) {
      btn.title = "no system TTS voices — install speech-dispatcher + espeak-ng";
      btn.classList.add("speak-btn-disabled");
      const orig = btn.textContent;
      btn.textContent = "no voice";
      setTimeout(() => {
        btn.textContent = orig;
        btn.classList.remove("speak-btn-disabled");
      }, 2200);
    }
    console.warn("[familiar] speechSynthesis has zero voices — install speech-dispatcher + espeak-ng on this host for browser TTS to work, or use the speech-to-cli MCP server for system-level audio");
    return;
  }
  const utt = new SpeechSynthesisUtterance(clean);
  if (voiceState.voiceURI) {
    const v = availableVoices.find((x) => x.voiceURI === voiceState.voiceURI);
    if (v) utt.voice = v;
  }
  utt.rate = 1.0;
  utt.pitch = 1.0;
  utt.onstart = () => { if (btn) btn.classList.add("speaking"); };
  utt.onend = () => { if (btn) btn.classList.remove("speaking"); currentUtterance = null; };
  utt.onerror = (e) => {
    if (btn) btn.classList.remove("speaking");
    currentUtterance = null;
    console.warn("[familiar] speechSynthesis utterance error:", e.error || e);
  };
  currentUtterance = utt;
  window.speechSynthesis.speak(utt);
}

function buildSpeakButton(getText) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "speak-btn";
  btn.title = "speak this turn aloud";
  btn.setAttribute("aria-label", "speak");
  btn.textContent = "♪";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (btn.classList.contains("speaking")) {
      cancelSpeech();
      return;
    }
    speakText(getText(), btn);
  });
  return btn;
}

// ---- Memories: list reflect-written drawers in the sidebar ----
async function fetchMemories(limit = 30) {
  try {
    const r = await fetch(`/api/familiar/memories?limit=${limit}`);
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d.drawers) ? d.drawers : [];
  } catch {
    return [];
  }
}

async function deleteMemory(drawerId, li) {
  if (!confirm("delete this memory? it will be removed from palace.")) return;
  try {
    const r = await fetch(`/api/familiar/memories/${encodeURIComponent(drawerId)}`, { method: "DELETE" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (li) li.remove();
  } catch (err) {
    alert(`delete failed: ${err.message}`);
  }
}

async function patchMemory(drawerId, content) {
  const r = await fetch(`/api/familiar/memories/${encodeURIComponent(drawerId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

function renderMemories(drawers) {
  if (!memoriesList) return;
  while (memoriesList.firstChild) memoriesList.removeChild(memoriesList.firstChild);
  if (drawers.length === 0) {
    const empty = document.createElement("li");
    empty.className = "sessions-empty";
    empty.textContent = "no reflect drawers yet — chat to fill them";
    memoriesList.appendChild(empty);
    return;
  }
  for (const d of drawers) {
    const li = document.createElement("li");

    const fact = document.createElement("span");
    fact.className = "memory-fact";
    fact.textContent = d.text || "(empty)";
    li.appendChild(fact);

    const meta = document.createElement("div");
    meta.className = "memory-meta";
    if (d.created_at) {
      const date = document.createElement("span");
      date.className = "memory-date";
      date.textContent = relTime(new Date(d.created_at).getTime());
      meta.appendChild(date);
    }
    if (d.room) {
      const room = document.createElement("span");
      room.textContent = d.room.length > 12 ? d.room.slice(0, 12) + "…" : d.room;
      meta.appendChild(room);
    }
    li.appendChild(meta);

    if (d.id) {
      const actions = document.createElement("div");
      actions.className = "memory-actions";

      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "memory-edit";
      editBtn.title = "edit";
      editBtn.setAttribute("aria-label", "edit");
      editBtn.textContent = "✎";
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const editing = fact.getAttribute("contenteditable") === "true";
        if (editing) {
          // Save path
          const newText = fact.textContent || "";
          if (newText !== d.text && newText.trim().length > 0) {
            patchMemory(d.id, newText).then(() => { d.text = newText; }).catch((err) => {
              alert(`save failed: ${err.message}`);
              fact.textContent = d.text || "";
            });
          }
          fact.removeAttribute("contenteditable");
          editBtn.textContent = "✎";
        } else {
          fact.setAttribute("contenteditable", "true");
          fact.focus();
          editBtn.textContent = "✓";
          // Place cursor at end
          const range = document.createRange();
          range.selectNodeContents(fact);
          range.collapse(false);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      });
      actions.appendChild(editBtn);

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "memory-delete";
      delBtn.title = "delete";
      delBtn.setAttribute("aria-label", "delete");
      delBtn.textContent = "✕";
      delBtn.addEventListener("click", (e) => { e.stopPropagation(); deleteMemory(d.id, li); });
      actions.appendChild(delBtn);

      li.appendChild(actions);
    }

    li.title = (d.id || "") + "\n" + (d.text || "");
    memoriesList.appendChild(li);
  }
}

async function refreshMemories() {
  const drawers = await fetchMemories(30);
  renderMemories(drawers);
}
if (memoriesRefresh) {
  memoriesRefresh.addEventListener("click", (e) => { e.stopPropagation(); refreshMemories(); });
}

// Boot: render the active session's transcript so reload doesn't lose state.
renderTranscript();
checkHealth();
setInterval(checkHealth, 60_000);
refreshMemories();
// Refresh memories when the page regains focus (catches reflect writes
// that happened while the tab was backgrounded).
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshMemories();
});

// ---- Clock (adapted from clock.realm.watch — same h:mm:ss + weekday-
// date + tz format the model sees in its "── Now ──" system-prompt
// anchor, so the sidebar mirrors the server-side grounding.)
const clockHm = document.getElementById("clock-hm");
const clockSec = document.getElementById("clock-sec");
const clockDate = document.getElementById("clock-date");
const clockTz = document.getElementById("clock-tz");
function updateClock() {
  if (!clockHm) return;
  const now = new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  clockHm.textContent = `${h}:${m}`;
  clockSec.textContent = s;
  clockDate.textContent = now.toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric",
  });
  let tz = "";
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(now);
    tz = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch { /* fall through */ }
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  clockTz.textContent = tz ? `${tz} · ${zone}` : zone;
}
updateClock();
setInterval(updateClock, 1000);
