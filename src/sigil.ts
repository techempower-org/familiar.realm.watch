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

/**
 * Read package.json once at module load. Bun.serve is long-lived; reading
 * once means version is stable for the process lifetime even if package.json
 * changes on disk. Falls back to safe defaults if the file is missing or
 * malformed.
 */
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
      name?: string;
      version?: string;
      description?: string;
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
 * Try a baked deploy artifact first (sigil.json), then fall back to live git.
 * The deploy script writes sigil.json with the source-tree's git state at
 * deploy time, because the deploy excludes .git from the rsync — running
 * `git rev-parse` in /srv/familiar/ otherwise returns nothing and the word
 * falls back to a literal placeholder.
 */
function readBakedSigil(): { hash: string; branch: string; dirty: boolean } | null {
  try {
    const proc = Bun.spawnSync({ cmd: ["cat", "sigil.json"], stdout: "pipe" });
    if (!proc.success) return null;
    const parsed = JSON.parse(new TextDecoder().decode(proc.stdout)) as {
      hash?: string; branch?: string; dirty?: boolean;
    };
    if (typeof parsed.hash !== "string") return null;
    return {
      hash: parsed.hash,
      branch: typeof parsed.branch === "string" ? parsed.branch : "",
      dirty: parsed.dirty === true,
    };
  } catch {
    return null;
  }
}

export function readSigil(realm: string): SigilInfo {
  const baked = readBakedSigil();
  const hash = baked?.hash ?? safeGit(["rev-parse", "HEAD"]).slice(0, 12);
  const branch = baked?.branch ?? safeGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  const dirty = baked?.dirty ?? safeGit(["status", "--porcelain"]).length > 0;
  const word = hash
    ? FANTASY_WORDS[hashToIndex(hash, FANTASY_WORDS.length)]
    : "wildwood"; // fallback when neither baked sigil nor git is available
  return {
    name: PKG.name,
    description: PKG.description,
    version: PKG.version,
    realm,
    word,
    hash,
    branch,
    dirty,
    built: new Date().toISOString(),
    repo: null,
  };
}
