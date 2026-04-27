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
  assistantEl.classList.add("streaming");

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
    assistantEl.classList.remove("streaming");
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
