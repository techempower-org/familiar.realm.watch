/**
 * Pure VRAM accounting for the slot picker's preflight check.
 *
 * Inputs are intentionally narrow (slots state + registry) so this module
 * is trivially testable without filesystem or network.
 *
 * Budget rule: a proposed slot configuration is invalid if any GPU's sum
 * of `vram_mb` across all variants currently bound to a slot exceeds
 * `0.92 × gpu_total_mb`. The 0.92 leaves headroom for KV cache growth +
 * llama-server's prompt cache + nvidia driver overhead. Ops can override
 * by editing `gpu_total_mb` in registry.json (the source of truth).
 */

import type {
  RegistryConfig,
  SlotName,
  SlotState,
  SlotsConfig,
  Variant,
} from "../types.ts";

/** Per-GPU VRAM headroom multiplier — leave 8% for KV cache + driver. */
export const VRAM_BUDGET_FRACTION = 0.92;

export interface GpuUsage {
  /** GPU index as a string ("0", "1") or "cpu" for CPU variants. */
  gpu: string;
  /** Sum of variant.vram_mb across slots currently bound to this GPU. */
  used_mb: number;
  /** Capacity from registry.gpu_total_mb (or 0 for cpu). */
  total_mb: number;
  /** total_mb × VRAM_BUDGET_FRACTION. Comparison ceiling. */
  budget_mb: number;
}

export interface VramOverflow {
  gpu: string;
  would_use_mb: number;
  budget_mb: number;
  total_mb: number;
}

/**
 * Resolve a slot binding to its variant, or null when the slot is disabled
 * or the variant_id is unknown to the registry (which is a corruption
 * signal we surface but don't crash on).
 */
function variantOf(state: SlotState, registry: RegistryConfig): Variant | null {
  if (state.variant_id === null) return null;
  return registry.variants.find((v) => v.id === state.variant_id) ?? null;
}

/**
 * Walk every slot, look up its bound variant, group by GPU. Disabled slots
 * (variant_id === null) and unknown variant ids contribute zero. CPU variants
 * (variant.gpu === null) tally under the "cpu" bucket so callers can show
 * them without special-casing.
 */
export function computeUsage(
  slots: SlotsConfig,
  registry: RegistryConfig,
): GpuUsage[] {
  const usage = new Map<string, number>();

  for (const slot of Object.values(slots.slots)) {
    const variant = variantOf(slot, registry);
    if (!variant) continue;
    const key = variant.gpu === null ? "cpu" : String(variant.gpu);
    usage.set(key, (usage.get(key) ?? 0) + variant.vram_mb);
  }

  // Always report every GPU in the registry, even with 0 usage, so the UI
  // can render an empty bar instead of a missing one. Plus "cpu" if any
  // bound variant is CPU.
  const seen = new Set<string>([...usage.keys(), ...Object.keys(registry.gpu_total_mb)]);

  const result: GpuUsage[] = [];
  for (const gpu of [...seen].sort()) {
    const total = registry.gpu_total_mb[gpu] ?? 0;
    result.push({
      gpu,
      used_mb: usage.get(gpu) ?? 0,
      total_mb: total,
      budget_mb: Math.floor(total * VRAM_BUDGET_FRACTION),
    });
  }
  return result;
}

/**
 * Check whether `proposed` would push any GPU past its budget. Returns
 * the first overflow encountered (predictable ordering by GPU index).
 * CPU bucket is always permitted — there's no analogue to VRAM exhaustion
 * for CPU variants at the slot level; if RAM runs out, systemd's MemoryMax
 * on the unit itself will catch it.
 */
export function validateChange(
  proposed: SlotsConfig,
  registry: RegistryConfig,
): VramOverflow | null {
  const usage = computeUsage(proposed, registry);
  for (const u of usage) {
    if (u.gpu === "cpu") continue;
    if (u.used_mb > u.budget_mb) {
      return {
        gpu: u.gpu,
        would_use_mb: u.used_mb,
        budget_mb: u.budget_mb,
        total_mb: u.total_mb,
      };
    }
  }
  return null;
}

/**
 * Compose a slots config representing what `state` would look like after
 * binding `variantId` (or null) to `slot`. Pure — does not mutate input.
 * Used by the PATCH handler to preflight without committing to disk.
 */
export function applyChange(
  current: SlotsConfig,
  slot: SlotName,
  variantId: string | null,
): SlotsConfig {
  return {
    ...current,
    slots: {
      ...current.slots,
      [slot]: { variant_id: variantId },
    },
  };
}
