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
  const seed = parseInt(hash, 16) || 0;

  const adj = r.adjectives[seed % r.adjectives.length];
  const noun = r.nouns[(seed >> 8) % r.nouns.length];

  return `${adj} ${noun} · ${hash}`;
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
