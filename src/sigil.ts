/**
 * realm-sigil version stamp for familiar.
 *
 * Built on top of `realm-sigil`'s canonical JS package — same hash → name
 * mapping every other realm.watch service uses, so status.realm.watch
 * sees a consistent contract across the ecosystem.
 *
 * The deploy script bakes `.git_info` (via realm-sigil's
 * `realm_sigil_git_info` shell helper) before rsync because the deploy
 * excludes `.git`. realm-sigil's `gitInfo()` reads that file when present
 * and falls back to live `git` in dev.
 *
 * `word` is a derived property — the noun half of the realm-sigil name,
 * preserved as a top-level convenience for the PWA's sidebar word display
 * which existed before the canonical schema landed in v0.3.4.
 */

import { generateName, REALMS } from "realm-sigil";
import { gitInfo, makeVersionResponse } from "realm-sigil/handler";

export interface SigilInfo {
  name: string;
  description: string;
  /** Canonical realm-sigil "version" — the magical name, e.g. "Blazing Crown · e4f5a6b". */
  version: string;
  /** package.json version (semver), exposed as a separate field. */
  pkg_version: string;
  realm: string;
  /** Convenience: the noun-half of the magical name. PWA renders this. */
  word: string;
  hash: string;
  branch: string;
  dirty: boolean;
  built: string;
  repo: string | null;
  commit_url: string;
}

function readPackageMetadata(): { name: string; version: string; description: string } {
  const FALLBACK = {
    name: "familiar-realm-watch",
    version: "0.0.0",
    description: "Local-first AI companion — reads mempalace before speaking, writes it after.",
  };
  try {
    const proc = Bun.spawnSync({ cmd: ["cat", "package.json"], stdout: "pipe" });
    if (!proc.success) return FALLBACK;
    const pkg = JSON.parse(new TextDecoder().decode(proc.stdout)) as {
      name?: string; version?: string; description?: string;
    };
    return {
      name: pkg.name ?? FALLBACK.name,
      version: pkg.version ?? FALLBACK.version,
      description: pkg.description ?? FALLBACK.description,
    };
  } catch {
    return FALLBACK;
  }
}

const PKG = readPackageMetadata();

/**
 * Extract the magical-name half of a realm-sigil version string —
 * everything before the " · hash" suffix. realm-sigil names have the
 * shape "Adjective Noun · hash" (e.g. "Noble Ember · 491e206"); the
 * sidebar shows the two-word phrase, the hash lives separately.
 */
function extractWord(name: string, realm: string): string {
  const beforeBullet = name.split(" · ")[0]?.trim();
  if (beforeBullet) return beforeBullet;
  // Defensive fallback — pick a stable name from the realm's word lists.
  const r = REALMS[realm] ?? REALMS["fantasy"];
  return `${r.adjectives?.[0] ?? "Wild"} ${r.nouns?.[0] ?? "Wood"}`;
}

export function readSigil(realm: string): SigilInfo {
  const git = gitInfo();
  const repo = "https://github.com/techempower-org/familiar.realm.watch";
  // makeVersionResponse handles all the fiddly fields; we tag the package
  // version on top + the convenience `word` derivation.
  const v = makeVersionResponse(PKG.name, PKG.description, realm, repo);
  const word = extractWord(v.version, realm);
  return {
    name: v.name,
    description: v.description,
    version: v.version,
    pkg_version: PKG.version,
    realm: v.realm,
    word,
    hash: v.hash,
    branch: v.branch,
    dirty: v.dirty,
    built: v.built,
    repo: v.repo ?? null,
    commit_url: v.commit_url,
  };
}
