/**
 * /api/familiar/admin/slots — slot binding GET + PATCH.
 *
 * GET returns the snapshot (registry + slots + computed GPU usage) so the
 * picker can render. PATCH /api/familiar/admin/slots/:slot is the mutation
 * surface — the body is `{variant_id: string | null}`, and the handler
 * runs the full flow:
 *
 *   validate → VRAM preflight → stop old units → start new → poll /health
 *   → atomic-write slots.json
 *
 * On any health-check failure the previously-bound unit is restarted and
 * slots.json is NOT written; the client sees 503 with a structured reason.
 *
 * A module-level promise chain serializes concurrent PATCHes so two
 * admins (or a bouncing UI) don't race the systemd state machine.
 */

import type { Config, SlotName, SlotsConfig, Variant } from "../types.ts";
import { SLOT_NAMES } from "../types.ts";
import type { SlotResolver } from "../slots/resolver.ts";
import type { Slotctl } from "../slots/slotctl.ts";
import { applyChange, computeUsage, validateChange } from "../slots/vram.ts";

const HEALTH_POLL_INTERVAL_MS = 500;
const HEALTH_POLL_TIMEOUT_MS = 30_000;

export interface AdminSlotsDeps {
  cfg: Config;
  resolver: SlotResolver;
  slotctl: Slotctl;
  /** Test seam — override fetch. Defaults to globalThis.fetch. */
  fetchFn?: typeof fetch;
}

/** Module-level mutex: every PATCH chains onto this promise. */
let mutationChain: Promise<unknown> = Promise.resolve();

function jsonErr(message: string, status: number, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ error: message, ...extra }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isSlotName(s: string): s is SlotName {
  return (SLOT_NAMES as readonly string[]).includes(s);
}

/**
 * Probe a variant's URL until /health (or /v1/models as fallback) returns 200.
 * llama-server exposes /health; Ollama doesn't but does serve /v1/models.
 * We try /health first and fall back. Returns true on success, false on
 * timeout.
 */
async function waitHealthy(
  url: string,
  fetchFn: typeof fetch,
): Promise<{ ok: boolean; last_error: string | null }> {
  const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;
  let last_error: string | null = null;
  const base = url.replace(/\/$/, "");
  while (Date.now() < deadline) {
    for (const probe of [`${base}/health`, `${base}/v1/models`]) {
      try {
        const r = await fetchFn(probe, { method: "GET" });
        if (r.ok) return { ok: true, last_error: null };
        last_error = `${probe}: ${r.status}`;
      } catch (err) {
        last_error = `${probe}: ${(err as Error).message}`;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
  }
  return { ok: false, last_error };
}

/**
 * Determine which units to stop and start for a slots transition.
 * A unit is stopped if it was bound to a slot before the change AND
 * isn't referenced by any slot after. A unit is started if it's
 * referenced after but wasn't before.
 */
function diffUnits(
  before: SlotsConfig,
  after: SlotsConfig,
  registry: { variants: Variant[] },
): { stop: string[]; start: string[] } {
  const unitOf = (variantId: string | null): string | null => {
    if (!variantId) return null;
    return registry.variants.find((v) => v.id === variantId)?.unit ?? null;
  };
  const unitsBefore = new Set<string>();
  const unitsAfter = new Set<string>();
  for (const name of SLOT_NAMES) {
    const u1 = unitOf(before.slots[name].variant_id);
    if (u1) unitsBefore.add(u1);
    const u2 = unitOf(after.slots[name].variant_id);
    if (u2) unitsAfter.add(u2);
  }
  return {
    stop: [...unitsBefore].filter((u) => !unitsAfter.has(u)),
    start: [...unitsAfter].filter((u) => !unitsBefore.has(u)),
  };
}

/**
 * GET /api/familiar/admin/slots — snapshot for the picker.
 * (Also mounted at /api/familiar/slots for unauthed reads — see api.ts.)
 */
export async function handleSlotsGet(_req: Request, deps: AdminSlotsDeps): Promise<Response> {
  try {
    const snap = await deps.resolver.snapshot();
    const gpu_usage = computeUsage(snap.slots, snap.registry);
    return new Response(
      JSON.stringify({ registry: snap.registry, slots: snap.slots, gpu_usage }, null, 2),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch (err) {
    return jsonErr(`failed to load slots: ${(err as Error).message}`, 500);
  }
}

/**
 * PATCH /api/familiar/admin/slots/:slot — change the binding.
 * Body: { variant_id: string | null }
 */
export async function handleSlotPatch(
  req: Request,
  slot: string,
  deps: AdminSlotsDeps,
): Promise<Response> {
  if (!deps.cfg.slots.adminEnabled) {
    return jsonErr("slots admin disabled (FAMILIAR_SLOTS_ADMIN != true)", 403);
  }
  if (!isSlotName(slot)) {
    return jsonErr(`invalid slot name: ${slot}`, 400, { valid_slots: SLOT_NAMES });
  }
  let body: { variant_id: string | null };
  try {
    body = (await req.json()) as { variant_id: string | null };
  } catch {
    return jsonErr("invalid JSON body", 400);
  }
  if (body.variant_id !== null && typeof body.variant_id !== "string") {
    return jsonErr("variant_id must be a string or null", 400);
  }

  // Serialize all PATCHes onto the module-level chain.
  const work = mutationChain.then(() => executePatch(slot, body.variant_id, deps));
  mutationChain = work.catch(() => undefined); // chain even on failure
  return work;
}

async function executePatch(
  slot: SlotName,
  variantId: string | null,
  deps: AdminSlotsDeps,
): Promise<Response> {
  const fetchFn = deps.fetchFn ?? globalThis.fetch;

  // 1. Slot-level validation.
  const slotError = await deps.resolver.validateAssignment(slot, variantId);
  if (slotError) return jsonErr(slotError, 400);

  const registry = await deps.resolver.getRegistry().read();
  const before = await deps.resolver.readSlots();
  const after = applyChange(before, slot, variantId);

  // 2. VRAM preflight.
  const overflow = validateChange(after, registry);
  if (overflow) {
    return jsonErr(
      `VRAM budget exceeded on GPU ${overflow.gpu}`,
      409,
      {
        gpu: overflow.gpu,
        would_use_mb: overflow.would_use_mb,
        budget_mb: overflow.budget_mb,
        total_mb: overflow.total_mb,
      },
    );
  }

  // 3. Unit diff.
  const { stop, start } = diffUnits(before, after, registry);

  // 4. Stop outgoing units (best-effort — log but don't roll back on stop failure).
  const stopResults: Array<{ unit: string; ok: boolean; stderr: string }> = [];
  for (const unit of stop) {
    const r = deps.slotctl.run("stop", unit);
    stopResults.push({ unit, ok: r.ok, stderr: r.stderr });
  }

  // 5. Start incoming units (one for a single-slot PATCH; could be more in
  // larger flows but v1 PATCH only touches one slot at a time).
  const startedUnits: string[] = [];
  for (const unit of start) {
    const r = deps.slotctl.run("start", unit);
    if (!r.ok) {
      // Revert: stop anything we started, restart anything we stopped.
      for (const u of startedUnits) deps.slotctl.run("stop", u);
      for (const u of stop) deps.slotctl.run("start", u);
      return jsonErr(
        `failed to start unit "${unit}"`,
        503,
        {
          unit,
          exit_code: r.exit_code,
          stderr: r.stderr.trim().slice(0, 500),
          reverted: true,
        },
      );
    }
    startedUnits.push(unit);
  }

  // 6. Health-check the started units. For PATCH-of-one-slot we expect
  // exactly the new variant's URL to come up.
  const newVariant = variantId ? registry.variants.find((v) => v.id === variantId) : null;
  if (newVariant && startedUnits.includes(newVariant.unit)) {
    const health = await waitHealthy(newVariant.url, fetchFn);
    if (!health.ok) {
      for (const u of startedUnits) deps.slotctl.run("stop", u);
      for (const u of stop) deps.slotctl.run("start", u);
      return jsonErr(
        `health check timed out for variant "${variantId}"`,
        503,
        {
          variant_id: variantId,
          unit: newVariant.unit,
          url: newVariant.url,
          last_error: health.last_error,
          reverted: true,
        },
      );
    }
  }

  // 7. Persist.
  try {
    await deps.resolver.writeSlots(after);
  } catch (err) {
    // Disk failed *after* systemd state already changed. Don't try to
    // revert systemd — the runtime now matches `after` but disk doesn't.
    // Next request will re-read disk and rebuild providers from the old
    // binding, but the new unit is running. Log + surface the disk error.
    return jsonErr(
      `runtime updated but failed to persist slots.json: ${(err as Error).message}`,
      500,
      { warning: "disk_state_drift", stopped: stop, started: startedUnits },
    );
  }

  return new Response(
    JSON.stringify(
      {
        ok: true,
        slot,
        variant_id: variantId,
        stopped_units: stop,
        started_units: startedUnits,
        stop_warnings: stopResults.filter((r) => !r.ok),
      },
      null,
      2,
    ),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
