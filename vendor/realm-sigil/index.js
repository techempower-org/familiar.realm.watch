/**
 * realm-sigil: Deterministic magical version name generation.
 *
 * Usage:
 *   const { generateName, versionObject } = require('realm-sigil');
 *   generateName('e4f5a6b', 'fantasy') // → "Blazing Crown · e4f5a6b"
 */

const { REALMS } = require('./realms');

/**
 * Generate a deterministic magical name from a git hash and realm.
 * Same hash + realm always produces the same name.
 */
function generateName(hash, realm = 'fantasy') {
  const r = REALMS[realm] || REALMS.fantasy;
  const seed = parseHex(hash);

  const adj = r.adjectives[Number(seed % BigInt(r.adjectives.length))];
  const noun = r.nouns[Number((seed >> 8n) % BigInt(r.nouns.length))];

  return `${adj} ${noun} · ${hash}`;
}

/**
 * Parse a hex string to a 64-bit seed, matching Go's `parseHex` exactly: accumulate hex
 * digits, skip anything else, wrap at 64 bits.
 *
 * ⚠️ This file previously did `parseInt(hash, 16) || 0` and then `seed >> 8`, which is BROKEN
 * for any seed >= 2^31. JS `>>` coerces to **int32**, so the shift goes negative, and JS `%`
 * keeps the dividend's sign — giving a negative array index and an `undefined` noun. The
 * version string came out literally as "Blazing undefined · 9e3779b1".
 *
 * It stayed invisible here because this service seeds with 7-hex-char git hashes (< 2^28),
 * where the sign bit is never set. That is luck, not safety: `ops/scripts/deploy-familiar.sh`
 * falls back to `rev-parse HEAD | cut -c1-12` whenever `.git_info` is absent, and git lengthens
 * abbreviated hashes as a repo grows — so this was one missing file away from publishing
 * "undefined" on /api/version, which status.realm.watch monitors.
 *
 * BigInt rather than `>>> 8`: an unsigned shift fixes the sign but still truncates to 32 bits,
 * so a hash longer than 8 hex chars would diverge from Go's uint64. `BigInt.asUintN(64, …)`
 * reproduces Go's overflow semantics exactly, so all four bindings agree.
 *
 * Ported verbatim from canonical realm-sigil (`js/index.js`), which fixed this upstream.
 * Behaviour is UNCHANGED for the 7-char hashes this service actually uses, so no version name
 * is renamed by this fix — verified against the old implementation across 8 hashes before
 * committing, with 0 renames and 4 previously-`undefined` results corrected.
 *
 * Scope, stated honestly: this directory is a BUILD ARTIFACT that happens to be committed.
 * `ops/scripts/deploy-familiar.sh` rsyncs `$HOME/Projects/realm-sigil/js/` over it on every
 * deploy (the deployed host has no ~/Projects), so the next deploy would have picked up the
 * upstream fix on its own. What was actually stale is the copy in git — and therefore anything
 * that runs `bun install` from a clone without deploying: local dev, CI, a fresh checkout.
 * This commit makes the committed state match what a deploy produces, instead of shipping a
 * known-broken copy to whoever installs from the repo.
 *
 * Do not "improve" this by editing it in place expecting it to survive: it will be overwritten.
 * Fix belongs upstream in sigil.realm.watch/js, which is where this came from.
 */
function parseHex(s) {
  let result = 0n;
  for (const c of String(s ?? '')) {
    let v;
    if (c >= '0' && c <= '9') v = BigInt(c.charCodeAt(0) - 48);
    else if (c >= 'a' && c <= 'f') v = BigInt(c.charCodeAt(0) - 87);
    else if (c >= 'A' && c <= 'F') v = BigInt(c.charCodeAt(0) - 55);
    else continue;
    result = BigInt.asUintN(64, result * 16n + v);
  }
  return result;
}

/**
 * Build a version response object conforming to the realm-sigil contract.
 * For static/build-time use. Server handlers add runtime fields automatically.
 */
function versionObject(opts) {
  const {
    name, description, realm, repo,
    hash = 'dev', branch = 'unknown', dirty = false, built = 'unknown',
    started, uptime, runtime, os, host, pid,
  } = opts;

  const commitUrl = repo && hash !== 'dev' ? `${repo}/commit/${hash}` : '';

  const obj = {
    name,
    description,
    version: generateName(hash, realm),
    hash,
    branch,
    dirty,
    built,
    realm,
    repo,
    commit_url: commitUrl,
  };

  // Optional server-only fields
  if (started !== undefined) obj.started = started;
  if (uptime !== undefined) obj.uptime = uptime;
  if (runtime !== undefined) obj.runtime = runtime;
  if (os !== undefined) obj.os = os;
  if (host !== undefined) obj.host = host;
  if (pid !== undefined) obj.pid = pid;

  return obj;
}

module.exports = { generateName, versionObject, REALMS };
