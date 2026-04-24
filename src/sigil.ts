/**
 * realm-sigil version endpoint. Uses Bun.spawnSync with an argv array
 * (never a shell string) so there's no shell-injection surface. Embeds a
 * trimmed fantasy word list inline; replace with a proper realm-sigil
 * import once the lib publishes TS types.
 *
 * Word is deterministic from the git hash — same commit → same word.
 * Status.realm.watch consumes this to detect version drift.
 */

const FANTASY_WORDS = [
  "lantern", "oakheart", "embertide", "glimmer", "whisper", "tarn", "hollow", "spindle",
  "cinder", "moth", "sigil", "talon", "quillhearth", "greengage", "fernstep", "moss",
  "thistle", "woolgather", "hedgerow", "moonwort", "smaragd", "willowshade",
];

function hashToIndex(hash: string, listLen: number): number {
  let s = 0;
  for (const c of hash) s = (s + c.charCodeAt(0)) % 100003;
  return s % listLen;
}

export interface SigilInfo {
  name: string;
  description: string;
  version: string;
  realm: string;
  word: string;
  hash: string;
  branch: string;
  dirty: boolean;
  built: string;
  repo: string | null;
}

function safeGit(args: string[]): string {
  // Bun.spawnSync takes argv array — no shell, no injection.
  const proc = Bun.spawnSync({
    cmd: ["git", ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!proc.success) return "";
  return new TextDecoder().decode(proc.stdout).trim();
}

export function readSigil(realm: string): SigilInfo {
  const hash = safeGit(["rev-parse", "HEAD"]).slice(0, 12);
  const branch = safeGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  const dirty = safeGit(["status", "--porcelain"]).length > 0;
  const word = hash
    ? FANTASY_WORDS[hashToIndex(hash, FANTASY_WORDS.length)]
    : "wildwood"; // fallback when outside a git repo
  return {
    name: "familiar-realm-watch",
    description: "Local-first AI companion — reads mempalace before speaking, writes it after.",
    version: "0.1.0",
    realm,
    word,
    hash,
    branch,
    dirty,
    built: new Date().toISOString(),
    repo: null,
  };
}
