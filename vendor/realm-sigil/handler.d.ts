// realm-sigil — handler.js TypeScript declarations.
// Includes the new bunHandler + .git_info fallback added 2026-04-26.

import type { Realm, VersionResponse } from "./index";

export interface GitInfo {
  hash: string;
  branch: string;
  dirty: boolean;
}

/**
 * Read git state at `cwd`. Tries `.git_info` JSON first (baked at deploy
 * time when the deploy excludes `.git` from rsync), then falls back to
 * a live `git` shell-out, then to `{hash:"dev", branch:"unknown",
 * dirty:false}`.
 */
export function gitInfo(cwd?: string): GitInfo;

/**
 * Build a complete version response with live system info. Same shape
 * the framework handlers use internally.
 */
export function makeVersionResponse(
  name: string,
  description: string,
  realm: Realm,
  repo: string,
  cwd?: string,
): VersionResponse;

type FrameworkHandler = (req: unknown, res: unknown) => void;

export function nextHandler(name: string, description: string, realm: Realm, repo: string, cwd?: string): FrameworkHandler;
export function vercelHandler(name: string, description: string, realm: Realm, repo: string, cwd?: string): FrameworkHandler;
export function expressHandler(name: string, description: string, realm: Realm, repo: string, cwd?: string): FrameworkHandler;

/**
 * Bun.serve-shaped handler. Returns a `Response` directly — drop into
 * a route branch:
 *
 *   if (url.pathname === "/api/version") return bunHandler(...)(req);
 */
export function bunHandler(
  name: string,
  description: string,
  realm: Realm,
  repo: string,
  cwd?: string,
): (req: Request) => Response;
