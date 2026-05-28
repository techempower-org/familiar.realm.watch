/**
 * SlotResolver — the runtime layer between routes and providers.
 *
 * The chat/embed/eval/hyde/reflect call sites ask the resolver "what
 * provider serves the chat slot right now?" and get back an
 * InferenceChatProvider (or null for disabled hyde/reflect). Behind
 * that:
 *
 *   - Mtime-cached read of slots.json (1s window) so disk edits propagate
 *     without restart. fs.watch is racy on atomic rename; one stat() per
 *     request is negligible next to a GPU inference call.
 *   - Registry held by composition (registry.ts) — registry edits propagate
 *     on a longer mtime window because they're ops-driven and rare.
 *   - Atomic write via tmpfile + rename for slots.json so a torn write
 *     can't leave a half-JSON file.
 *
 * The actual mutation flow (start/stop/health-check) lives in the
 * admin-slots route — this module just exposes the building blocks
 * (read, write, build a provider).
 */

import { readFile, rename, stat, unlink, writeFile, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { OllamaClient } from "../ollama-client.ts";
import { LlamaCppClient } from "../llama-client.ts";
import type {
  Config,
  InferenceChatProvider,
  RegistryConfig,
  SlotName,
  SlotState,
  SlotsConfig,
  Variant,
} from "../types.ts";
import { REQUIRED_SLOTS, SLOT_NAMES } from "../types.ts";
import { Registry, RegistryLoadError } from "./registry.ts";

const SLOTS_MTIME_CACHE_MS = 1_000;

export class SlotsLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlotsLoadError";
  }
}

interface SlotsCache {
  mtime_ms: number;
  cached_at_ms: number;
  data: SlotsConfig;
}

function emptySlots(): SlotsConfig {
  return {
    schema_version: 1,
    updated_at: new Date(0).toISOString(),
    slots: {
      chat: { variant_id: null },
      embed: { variant_id: null },
      extract: { variant_id: null },
      hyde: { variant_id: null },
      reflect: { variant_id: null },
    },
  };
}

function validateSlots(raw: unknown, path: string): SlotsConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new SlotsLoadError(`${path}: top-level must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schema_version !== 1) {
    throw new SlotsLoadError(`${path}: schema_version must be 1`);
  }
  if (typeof obj.updated_at !== "string") {
    throw new SlotsLoadError(`${path}: updated_at must be a string`);
  }
  if (typeof obj.slots !== "object" || obj.slots === null) {
    throw new SlotsLoadError(`${path}: slots must be an object`);
  }
  const slotsIn = obj.slots as Record<string, unknown>;
  const slots: Record<SlotName, SlotState> = emptySlots().slots;
  for (const name of SLOT_NAMES) {
    const entry = slotsIn[name];
    if (entry === undefined) continue; // missing = default to null
    if (typeof entry !== "object" || entry === null) {
      throw new SlotsLoadError(`${path}: slots.${name} must be an object`);
    }
    const e = entry as Record<string, unknown>;
    if (e.variant_id !== null && typeof e.variant_id !== "string") {
      throw new SlotsLoadError(`${path}: slots.${name}.variant_id must be string or null`);
    }
    slots[name] = { variant_id: e.variant_id as string | null };
  }
  return { schema_version: 1, updated_at: obj.updated_at, slots };
}

/**
 * Build a typed provider for a variant. Constructed fresh per call —
 * clients hold no state worth caching across requests.
 */
function buildProvider(variant: Variant): InferenceChatProvider {
  if (variant.runtime === "ollama") {
    return new OllamaClient({ baseUrl: variant.url, defaultModel: variant.model });
  }
  return new LlamaCppClient({ baseUrl: variant.url, model: variant.model });
}

export interface ResolvedSlot {
  slot: SlotName;
  variant: Variant | null;
  /** Provider when bound + variant resolves; null if slot is disabled. */
  provider: InferenceChatProvider | null;
  /** True when a session override took precedence over the system default. */
  from_override: boolean;
}

export class SlotResolver {
  private slotsCache: SlotsCache | null = null;
  private readonly registry: Registry;

  constructor(private readonly cfg: Config) {
    this.registry = new Registry(cfg.slots.registryPath);
  }

  /** Expose the registry for routes that need it directly. */
  getRegistry(): Registry {
    return this.registry;
  }

  /**
   * Read the live slots binding. Mtime-cached 1s. Returns a fresh
   * empty-slots config if the file doesn't exist — this is the
   * legitimate first-boot state.
   */
  async readSlots(): Promise<SlotsConfig> {
    const now = Date.now();
    if (this.slotsCache && now - this.slotsCache.cached_at_ms < SLOTS_MTIME_CACHE_MS) {
      return this.slotsCache.data;
    }
    let mtime_ms: number;
    try {
      const st = await stat(this.cfg.slots.configPath);
      mtime_ms = st.mtimeMs;
    } catch (err) {
      // Missing file = legitimate cold-start state; cache the empty default
      // briefly so the next dozen requests don't re-stat.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        const empty = emptySlots();
        this.slotsCache = { mtime_ms: 0, cached_at_ms: now, data: empty };
        return empty;
      }
      throw new SlotsLoadError(
        `${this.cfg.slots.configPath}: stat failed: ${(err as Error).message}`,
      );
    }
    if (this.slotsCache && this.slotsCache.mtime_ms === mtime_ms) {
      this.slotsCache.cached_at_ms = now;
      return this.slotsCache.data;
    }
    let raw: unknown;
    try {
      const text = await readFile(this.cfg.slots.configPath, "utf8");
      raw = JSON.parse(text);
    } catch (err) {
      throw new SlotsLoadError(
        `${this.cfg.slots.configPath}: read/parse failed: ${(err as Error).message}`,
      );
    }
    const data = validateSlots(raw, this.cfg.slots.configPath);
    this.slotsCache = { mtime_ms, cached_at_ms: now, data };
    return data;
  }

  /**
   * Persist slots config atomically. Writes to a temp file in the same
   * directory and renames into place, so a torn write can't leave a
   * partial JSON file. Invalidates the mtime cache.
   */
  async writeSlots(next: SlotsConfig): Promise<void> {
    const dir = dirname(this.cfg.slots.configPath);
    await mkdir(dir, { recursive: true });
    const tmpName = `${this.cfg.slots.configPath}.tmp.${randomBytes(6).toString("hex")}`;
    const text = JSON.stringify({ ...next, updated_at: new Date().toISOString() }, null, 2) + "\n";
    let renamed = false;
    try {
      await writeFile(tmpName, text, { encoding: "utf8", mode: 0o644 });
      await rename(tmpName, this.cfg.slots.configPath);
      renamed = true;
    } finally {
      // If the rename succeeded, the tmpfile is gone (consumed by rename).
      // If anything between writeFile and rename threw, the tmpfile is
      // orphaned on disk — clean it up. unlink errors are swallowed
      // because (a) the rename may have raced, (b) the tmpfile may not
      // exist if writeFile itself threw. Either way, the caller already
      // sees the original error.
      if (!renamed) {
        try { await unlink(tmpName); } catch { /* best-effort cleanup */ }
      }
    }
    this.slotsCache = null; // force re-read on next call
  }

  /**
   * Resolve a slot to its variant + provider. Per-session override (when
   * provided) wins over the system default. Returns nulls when the slot
   * is disabled, the variant id is unknown, or the variant lacks the
   * capability (registry corruption — surfaced but not crashing).
   */
  async resolve(slot: SlotName, override?: string | null): Promise<ResolvedSlot> {
    const slots = await this.readSlots();
    const systemVariantId = slots.slots[slot].variant_id;
    const chosenId = override ?? systemVariantId;
    if (chosenId === null) {
      return { slot, variant: null, provider: null, from_override: !!override };
    }
    const variant = await this.registry.getVariant(chosenId);
    if (!variant || !variant.capabilities.includes(slot)) {
      return { slot, variant: null, provider: null, from_override: !!override };
    }
    return {
      slot,
      variant,
      provider: buildProvider(variant),
      from_override: override !== undefined && override !== null && override !== systemVariantId,
    };
  }

  /**
   * Convenience accessors for each slot — sugar over resolve(). The
   * chat/embed/eval routes can write `await resolver.chat()` and get
   * the resolved binding.
   */
  chat(override?: string | null): Promise<ResolvedSlot> { return this.resolve("chat", override); }
  embed(override?: string | null): Promise<ResolvedSlot> { return this.resolve("embed", override); }
  extract(override?: string | null): Promise<ResolvedSlot> { return this.resolve("extract", override); }
  hyde(override?: string | null): Promise<ResolvedSlot> { return this.resolve("hyde", override); }
  reflect(override?: string | null): Promise<ResolvedSlot> { return this.resolve("reflect", override); }

  /**
   * Embed-specific resolver — returns an OllamaClient configured to the
   * variant bound to the embed slot, or null if the slot is disabled,
   * the variant is unknown, or the variant's runtime isn't "ollama"
   * (llama-cpp doesn't implement the embed contract today).
   *
   * Wave 2c: embeddings.ts calls this before falling back to the
   * legacy `deps.ollamaEmbed`.
   */
  async embedClient(override?: string | null): Promise<OllamaClient | null> {
    const slots = await this.readSlots();
    const id = override ?? slots.slots.embed.variant_id;
    if (id === null) return null;
    const variant = await this.registry.getVariant(id);
    if (!variant || !variant.capabilities.includes("embed")) return null;
    if (variant.runtime !== "ollama") return null;
    return new OllamaClient({ baseUrl: variant.url, defaultModel: variant.model });
  }

  /**
   * Snapshot for the GET /api/familiar/slots endpoint: registry + live
   * slots + computed GPU usage. The picker uses this verbatim.
   */
  async snapshot(): Promise<{
    registry: RegistryConfig;
    slots: SlotsConfig;
  }> {
    const [registry, slots] = await Promise.all([this.registry.read(), this.readSlots()]);
    return { registry, slots };
  }

  /**
   * Validate that a proposed change is well-formed at the SLOT level
   * (variant exists, capability matches, required slot not nulled).
   * VRAM preflight is separate (vram.validateChange).
   */
  async validateAssignment(slot: SlotName, variantId: string | null): Promise<string | null> {
    if (variantId === null && REQUIRED_SLOTS.includes(slot)) {
      return `slot "${slot}" cannot be disabled (variant_id=null is only allowed for hyde/reflect)`;
    }
    if (variantId === null) return null;
    const variant = await this.registry.getVariant(variantId);
    if (!variant) {
      return `variant_id "${variantId}" is not in the registry`;
    }
    if (!variant.capabilities.includes(slot)) {
      return `variant "${variantId}" does not advertise capability "${slot}" (has: ${variant.capabilities.join(", ")})`;
    }
    return null;
  }
}

export { RegistryLoadError };
