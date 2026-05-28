/**
 * Typed wrapper around `sudo /usr/local/sbin/familiar-slotctl <action> <unit>`.
 *
 * Per CLAUDE.md: never use `exec`/`execSync` with a shell string. We use
 * Bun.spawnSync with an argv array so the unit name can never inject
 * shell metacharacters. The wrapper itself re-validates against an
 * allow-list, so this is defense in depth.
 *
 * Returns a structured result rather than throwing on non-zero exit —
 * is-active is "non-zero means inactive", which is information, not a
 * failure.
 */

import type { Config } from "../types.ts";

export type SlotctlAction = "start" | "stop" | "restart" | "is-active" | "status";

export interface SlotctlResult {
  ok: boolean;
  exit_code: number;
  stdout: string;
  stderr: string;
  /** Action that ran, echoed back for trace logging. */
  action: SlotctlAction;
  unit: string;
}

/** Default per-action timeouts. start/restart can take a while as the model loads. */
const TIMEOUT_MS: Record<SlotctlAction, number> = {
  start: 60_000,
  stop: 30_000,
  restart: 60_000,
  "is-active": 5_000,
  status: 10_000,
};

/**
 * Construct a Slotctl bound to a config. Holds no state — every call shells
 * out fresh. Reads cfg.slots.slotctlPath at call time so an env override
 * during tests takes effect.
 */
export class Slotctl {
  constructor(private readonly cfg: Config) {}

  /**
   * Run a single action against a single unit. The wrapper at slotctlPath
   * validates the unit against /var/lib/familiar/allowed-units.txt; we
   * propagate its stderr verbatim so failed allow-list lookups surface
   * clearly in API responses.
   */
  run(action: SlotctlAction, unit: string): SlotctlResult {
    if (!this.cfg.slots.adminEnabled) {
      return {
        ok: false,
        exit_code: -1,
        stdout: "",
        stderr: "slotctl: admin disabled (FAMILIAR_SLOTS_ADMIN != true)",
        action,
        unit,
      };
    }
    const proc = Bun.spawnSync({
      cmd: ["sudo", "-n", this.cfg.slots.slotctlPath, action, unit],
      stdout: "pipe",
      stderr: "pipe",
      timeout: TIMEOUT_MS[action],
    });
    return {
      ok: proc.exitCode === 0,
      exit_code: proc.exitCode ?? -1,
      stdout: typeof proc.stdout === "string" ? proc.stdout : new TextDecoder().decode(proc.stdout ?? new Uint8Array()),
      stderr: typeof proc.stderr === "string" ? proc.stderr : new TextDecoder().decode(proc.stderr ?? new Uint8Array()),
      action,
      unit,
    };
  }

  /** Convenience: parse `is-active` stdout into a boolean. */
  isActive(unit: string): boolean {
    const r = this.run("is-active", unit);
    // systemctl is-active stdout is "active", "inactive", "failed", etc.
    return r.stdout.trim() === "active";
  }
}

/**
 * Inject a fake Slotctl for tests — pass an instance of this class to
 * downstream code instead of constructing a real Slotctl with the
 * production cfg. The fake records every call and lets tests assert the
 * sequence.
 */
export class FakeSlotctl extends Slotctl {
  readonly calls: Array<{ action: SlotctlAction; unit: string }> = [];
  private active = new Set<string>();

  constructor(initialActive: string[] = []) {
    // We never actually use cfg; pass a minimal stub.
    super({ slots: { adminEnabled: true, slotctlPath: "/fake", configPath: "/fake", registryPath: "/fake" } } as unknown as Config);
    for (const u of initialActive) this.active.add(u);
  }

  override run(action: SlotctlAction, unit: string): SlotctlResult {
    this.calls.push({ action, unit });
    let ok = true;
    let stdout = "";
    switch (action) {
      case "start":
        this.active.add(unit);
        break;
      case "stop":
        this.active.delete(unit);
        break;
      case "restart":
        this.active.add(unit);
        break;
      case "is-active":
        stdout = this.active.has(unit) ? "active\n" : "inactive\n";
        ok = this.active.has(unit);
        break;
      case "status":
        stdout = this.active.has(unit) ? "● active" : "○ inactive";
        break;
    }
    return { ok, exit_code: ok ? 0 : 3, stdout, stderr: "", action, unit };
  }

  override isActive(unit: string): boolean {
    this.calls.push({ action: "is-active", unit });
    return this.active.has(unit);
  }
}
