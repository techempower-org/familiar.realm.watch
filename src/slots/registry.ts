/**
 * Load + validate the variant registry from disk.
 *
 * The registry is ops-owned, edited by hand alongside systemd unit files
 * and the slotctl allow-list. We re-read it on mtime change so an ops
 * edit takes effect without restarting familiar-api — same pattern as
 * slots.json but with a longer mtime-cache window (registry edits are
 * rare; slots edits happen per-click).
 */

import { readFile, stat } from "node:fs/promises";
import type {
  RegistryConfig,
  SlotName,
  Variant,
} from "../types.ts";
import { SLOT_NAMES } from "../types.ts";

const REGISTRY_MTIME_CACHE_MS = 30_000;

export class RegistryLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryLoadError";
  }
}

interface CacheEntry {
  mtime_ms: number;
  cached_at_ms: number;
  data: RegistryConfig;
}

const VALID_RUNTIMES = new Set<Variant["runtime"]>(["ollama", "llama-cpp"]);

function validate(raw: unknown, path: string): RegistryConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new RegistryLoadError(`${path}: top-level must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schema_version !== 1) {
    throw new RegistryLoadError(`${path}: schema_version must be 1, got ${obj.schema_version}`);
  }
  if (typeof obj.gpu_total_mb !== "object" || obj.gpu_total_mb === null) {
    throw new RegistryLoadError(`${path}: gpu_total_mb must be an object`);
  }
  const gpu_total_mb: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj.gpu_total_mb)) {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new RegistryLoadError(`${path}: gpu_total_mb["${k}"] must be a positive number`);
    }
    gpu_total_mb[k] = v;
  }
  if (!Array.isArray(obj.variants)) {
    throw new RegistryLoadError(`${path}: variants must be an array`);
  }
  const variants: Variant[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < obj.variants.length; i++) {
    const v = obj.variants[i] as Record<string, unknown>;
    const where = `variants[${i}]`;
    if (typeof v.id !== "string" || v.id.length === 0) {
      throw new RegistryLoadError(`${path}: ${where}.id must be a non-empty string`);
    }
    if (seenIds.has(v.id)) {
      throw new RegistryLoadError(`${path}: ${where}.id "${v.id}" is duplicated`);
    }
    seenIds.add(v.id);
    if (typeof v.label !== "string") {
      throw new RegistryLoadError(`${path}: ${where}.label must be a string`);
    }
    if (typeof v.model !== "string") {
      throw new RegistryLoadError(`${path}: ${where}.model must be a string`);
    }
    if (typeof v.runtime !== "string" || !VALID_RUNTIMES.has(v.runtime as Variant["runtime"])) {
      throw new RegistryLoadError(`${path}: ${where}.runtime must be "ollama" or "llama-cpp"`);
    }
    if (typeof v.unit !== "string" || !/^[a-z0-9-]+\.service$/.test(v.unit)) {
      throw new RegistryLoadError(`${path}: ${where}.unit "${String(v.unit)}" must match ^[a-z0-9-]+\\.service$`);
    }
    if (typeof v.url !== "string") {
      throw new RegistryLoadError(`${path}: ${where}.url must be a string`);
    }
    if (v.gpu !== null && (typeof v.gpu !== "number" || !Number.isInteger(v.gpu) || v.gpu < 0)) {
      throw new RegistryLoadError(`${path}: ${where}.gpu must be a non-negative integer or null`);
    }
    if (typeof v.vram_mb !== "number" || !Number.isFinite(v.vram_mb) || v.vram_mb < 0) {
      throw new RegistryLoadError(`${path}: ${where}.vram_mb must be a non-negative number`);
    }
    if (!Array.isArray(v.capabilities) || v.capabilities.length === 0) {
      throw new RegistryLoadError(`${path}: ${where}.capabilities must be a non-empty array`);
    }
    for (const cap of v.capabilities) {
      if (!SLOT_NAMES.includes(cap as SlotName)) {
        throw new RegistryLoadError(`${path}: ${where}.capabilities contains invalid slot "${String(cap)}"`);
      }
    }
    if (v.context !== undefined && (typeof v.context !== "number" || v.context <= 0)) {
      throw new RegistryLoadError(`${path}: ${where}.context must be a positive number when present`);
    }
    variants.push({
      id: v.id,
      label: v.label,
      model: v.model,
      runtime: v.runtime as Variant["runtime"],
      unit: v.unit,
      url: v.url,
      gpu: v.gpu as number | null,
      vram_mb: v.vram_mb,
      capabilities: v.capabilities as SlotName[],
      ...(typeof v.context === "number" ? { context: v.context } : {}),
    });
  }
  return { schema_version: 1, gpu_total_mb, variants };
}

export class Registry {
  private cache: CacheEntry | null = null;

  constructor(private readonly path: string) {}

  /**
   * Read the registry, returning a cached copy if it hasn't changed on disk.
   * Throws RegistryLoadError on missing file or schema violation — callers
   * should treat the registry as a startup precondition, not best-effort.
   */
  async read(): Promise<RegistryConfig> {
    const now = Date.now();
    if (this.cache && now - this.cache.cached_at_ms < REGISTRY_MTIME_CACHE_MS) {
      return this.cache.data;
    }
    let mtime_ms: number;
    try {
      const st = await stat(this.path);
      mtime_ms = st.mtimeMs;
    } catch (err) {
      throw new RegistryLoadError(`${this.path}: stat failed: ${(err as Error).message}`);
    }
    if (this.cache && this.cache.mtime_ms === mtime_ms) {
      this.cache.cached_at_ms = now;
      return this.cache.data;
    }
    let raw: unknown;
    try {
      const text = await readFile(this.path, "utf8");
      raw = JSON.parse(text);
    } catch (err) {
      throw new RegistryLoadError(`${this.path}: read/parse failed: ${(err as Error).message}`);
    }
    const data = validate(raw, this.path);
    this.cache = { mtime_ms, cached_at_ms: now, data };
    return data;
  }

  /** Look up a variant by id, or null if not in the registry. */
  async getVariant(id: string): Promise<Variant | null> {
    const reg = await this.read();
    return reg.variants.find((v) => v.id === id) ?? null;
  }

  /** Variants whose capabilities include the given slot, in registry order. */
  async listVariants(slot: SlotName): Promise<Variant[]> {
    const reg = await this.read();
    return reg.variants.filter((v) => v.capabilities.includes(slot));
  }
}
