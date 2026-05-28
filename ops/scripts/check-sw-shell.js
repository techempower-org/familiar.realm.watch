#!/usr/bin/env node
//
// Verifies that every static asset referenced from index.html appears in
// sw.js's SHELL array. Closes the deploy-time half of issue #63.
//
// Why this matters: the SW caches whatever's in SHELL; anything missing
// gets fetched-and-not-cached on first visit. Worse, when SHELL is *too
// small* and the cache bumps, returning visitors are served a partial
// new shell (a new index.html but old widget JS that the SW doesn't
// know to refresh until next bump). The 2026-05-28 stat-widget #64
// incident was exactly this class of bug.
//
// Tolerated mismatches:
//   - URLs starting with /v1/ or /api/   (intentionally network-only)
//   - external CDN URLs (https://, http://)
//   - inline-script + inline-style tags
//
// Exits 0 if shell is complete; exits 1 with a useful diff if anything
// is missing. Called from ops/scripts/deploy-familiar.sh before rsync.

import fs from "node:fs";

if (process.argv.length < 4) {
  console.error("usage: check-sw-shell.js <index.html> <sw.js>");
  process.exit(2);
}

const indexPath = process.argv[2];
const swPath = process.argv[3];

const indexHtml = fs.readFileSync(indexPath, "utf8");
const swSource = fs.readFileSync(swPath, "utf8");

// Pull every URL out of <link href="..."> and <script src="...">.
const REF_RE = /(?:href|src)\s*=\s*["']([^"']+)["']/gi;
const refs = new Set();
let m;
while ((m = REF_RE.exec(indexHtml)) !== null) {
  const url = m[1];
  // Skip network-only and external URLs.
  if (url.startsWith("/v1/") || url.startsWith("/api/")) continue;
  if (url.startsWith("http://") || url.startsWith("https://")) continue;
  if (url.startsWith("data:") || url.startsWith("mailto:")) continue;
  // Anchors (#foo) and inline schemes — skip.
  if (url.startsWith("#")) continue;
  // Normalise to leading slash.
  refs.add(url.startsWith("/") ? url : `/${url}`);
}

// Pull the SHELL array literal out of sw.js. Tolerant of extra entries.
const SHELL_RE = /const\s+SHELL\s*=\s*\[([\s\S]*?)\]/;
const shellMatch = SHELL_RE.exec(swSource);
if (!shellMatch) {
  console.error("sw.js: could not locate SHELL array");
  process.exit(1);
}
const shellEntries = new Set();
const ENTRY_RE = /["']([^"']+)["']/g;
let e;
while ((e = ENTRY_RE.exec(shellMatch[1])) !== null) {
  shellEntries.add(e[1]);
}

const missing = [];
for (const ref of refs) {
  if (!shellEntries.has(ref)) missing.push(ref);
}

if (missing.length === 0) {
  console.log(`✓ SW shell covers all ${refs.size} static refs in index.html`);
  process.exit(0);
}

console.error(`✗ ${missing.length} static refs from index.html are NOT in sw.js's SHELL:`);
for (const m of missing) console.error(`  - ${m}`);
console.error("");
console.error("Fix: append each missing URL to the SHELL array in web/sw.js.");
console.error("(Bumping CACHE alone won't help; the SW will still skip these on cache install.)");
process.exit(1);
