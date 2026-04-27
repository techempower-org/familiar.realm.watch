// realm-sigil — TypeScript declarations.
// Mirrors index.js + handler.js. Hand-written; if the JS API changes,
// update this file. Tested against TypeScript 5.x.

export type Realm = "fantasy" | "tarot" | "oracle" | "void" | "forge" | "signal" | "stellar" | string;

export interface RealmDefinition {
  adjectives: string[];
  nouns: string[];
}

export const REALMS: Record<string, RealmDefinition>;

/**
 * Generate a deterministic magical name from a git hash and realm.
 * Same hash + realm always produces the same name.
 *
 * Example: generateName("e4f5a6b", "fantasy") → "Blazing Crown · e4f5a6b"
 */
export function generateName(hash: string, realm?: Realm): string;

export interface VersionObjectOptions {
  name: string;
  description: string;
  realm: Realm;
  repo?: string | null;
  hash?: string;
  branch?: string;
  dirty?: boolean;
  built?: string;
  started?: string;
  uptime?: number;
  runtime?: string;
  os?: string;
  host?: string;
  pid?: number;
}

export interface VersionResponse {
  name: string;
  description: string;
  /** The generated magical name, e.g. "Blazing Crown · e4f5a6b" */
  version: string;
  hash: string;
  branch: string;
  dirty: boolean;
  built: string;
  realm: Realm;
  repo?: string | null;
  commit_url: string;
  started?: string;
  uptime?: number;
  runtime?: string;
  os?: string;
  host?: string;
  pid?: number;
}

/**
 * Build a version response object conforming to the realm-sigil contract.
 * For static/build-time use. Server handlers add runtime fields automatically.
 */
export function versionObject(opts: VersionObjectOptions): VersionResponse;
