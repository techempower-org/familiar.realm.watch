import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHECK = new URL("../ops/familiar/familiar-autosuspend-check.sh", import.meta.url).pathname;
const NOW = 1_000_000_000;

let baseDir: string;
let dirs: { state: string; run: string; ci: string };

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "fa-"));
  dirs = { state: join(baseDir, "state"), run: join(baseDir, "run"), ci: join(baseDir, "ci") };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
});
afterEach(() => {
  try { rmSync(baseDir, { recursive: true, force: true }); } catch {}
});

function base(): Record<string, string> {
  return {
    FA_STATE_DIR: dirs.state, FA_RUN_DIR: dirs.run, FA_CI_HOOKS_DIR: dirs.ci,
    FA_NOW: String(NOW), FA_UPTIME_S: "100000",
    FA_IDLE_THRESHOLD_S: "900", FA_PALACE_GRACE_S: "600", FA_SSH_ACTIVE_GRACE_S: "600",
    FA_FORCE_COMPANION_ACTIVE: "0", FA_FORCE_CODER_ACTIVE: "0",
    FA_FORCE_SSH_MIN_IDLE_S: "999999", FA_FORCE_PALACE_AGE_S: "STALE",
    FA_FORCE_WOL: "g",
    FA_SUSPEND_CMD: `touch ${join(dirs.run, "SUSPENDED")}`,
    FA_REARM_CMD: "true",
  };
}
function run(env: Record<string, string>, args: string[] = []) {
  const p = Bun.spawnSync({ cmd: ["bash", CHECK, ...args], env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  return { out: p.stdout.toString().trim(), err: p.stderr.toString().trim(), code: p.exitCode };
}
const enable = () => writeFileSync(join(dirs.state, "enabled"), "");
const setClock = (epoch: number) => writeFileSync(join(dirs.run, "last-busy"), String(epoch));
const clock = () => readFileSync(join(dirs.run, "last-busy"), "utf8").trim();
const suspended = () => existsSync(join(dirs.run, "SUSPENDED"));

describe("familiar-autosuspend-check", () => {
  test("disabled when no master sentinel", () => {
    const r = run(base());
    expect(r.out).toContain("disabled");
    expect(suspended()).toBe(false);
  });

  test("hold window defers", () => {
    enable(); setClock(NOW - 5000);
    writeFileSync(join(dirs.state, "hold-until"), String(NOW + 300));
    const r = run(base());
    expect(r.out).toContain("held");
    expect(suspended()).toBe(false);
  });

  test("companion active blocks + resets clock", () => {
    enable(); setClock(NOW - 5000);
    const r = run({ ...base(), FA_FORCE_COMPANION_ACTIVE: "1" });
    expect(r.out).toContain("busy — companion");
    expect(suspended()).toBe(false);
    expect(clock()).toBe(String(NOW));
  });

  test("coder active blocks", () => {
    enable(); setClock(NOW - 5000);
    const r = run({ ...base(), FA_FORCE_CODER_ACTIVE: "1" });
    expect(r.out).toContain("busy — coder");
    expect(suspended()).toBe(false);
  });

  test("CI sentinel blocks", () => {
    enable(); setClock(NOW - 5000);
    writeFileSync(join(dirs.ci, ".ml-paused-by-ci"), String(NOW));
    const r = run(base());
    expect(r.out).toContain("busy — CI build");
    expect(suspended()).toBe(false);
  });

  test("maintenance sentinel blocks", () => {
    enable(); setClock(NOW - 5000);
    writeFileSync(join(dirs.ci, ".ml-maintenance"), "");
    const r = run(base());
    expect(r.out).toContain("busy — ML maintenance");
    expect(suspended()).toBe(false);
  });

  test("active SSH blocks", () => {
    enable(); setClock(NOW - 5000);
    const r = run({ ...base(), FA_FORCE_SSH_MIN_IDLE_S: "120" });
    expect(r.out).toContain("active SSH");
    expect(suspended()).toBe(false);
  });

  test("missing clock bootstraps to fresh", () => {
    enable(); // no setClock
    const r = run(base());
    expect(r.out).toContain("fresh");
    expect(suspended()).toBe(false);
    expect(existsSync(join(dirs.run, "last-busy"))).toBe(true);
  });

  test("recent palace request defers (soft grace, no clock reset)", () => {
    enable(); setClock(NOW - 5000);
    const r = run({ ...base(), FA_FORCE_PALACE_AGE_S: "120" });
    expect(r.out).toContain("palace grace");
    expect(suspended()).toBe(false);
    expect(clock()).toBe(String(NOW - 5000));
  });

  test("settling guard when uptime below threshold", () => {
    enable(); setClock(NOW - 5000);
    const r = run({ ...base(), FA_UPTIME_S: "100" });
    expect(r.out).toContain("settling");
    expect(suspended()).toBe(false);
  });

  test("idle below threshold waits", () => {
    enable(); setClock(NOW - 100);
    const r = run(base());
    expect(r.out).toContain("idle 100s / need 900s");
    expect(suspended()).toBe(false);
  });

  test("idle past threshold but WOL unarmable refuses", () => {
    enable(); setClock(NOW - 5000);
    const r = run({ ...base(), FA_FORCE_WOL: "d", FA_REARM_CMD: "true" });
    expect(r.out).toContain("REFUSE");
    expect(suspended()).toBe(false);
  });

  test("--explain never suspends even when it would", () => {
    enable(); setClock(NOW - 5000);
    const r = run(base(), ["--explain"]);
    expect(r.out).toContain("WOULD SUSPEND");
    expect(suspended()).toBe(false);
  });

  test("idle past threshold with WOL armed suspends once", () => {
    enable(); setClock(NOW - 5000);
    const r = run(base());
    expect(r.out).toContain("suspending");
    expect(suspended()).toBe(true);
  });

  describe("parse-idle (w IDLE column → seconds)", () => {
    const cases: [string, string][] = [
      ["3:21", "201"], ["08:09", "489"], ["45.00s", "45"], ["0.00s", "0"],
      ["1:30m", "5400"], ["2days", "172800"],
    ];
    for (const [inp, exp] of cases) {
      test(`${inp} → ${exp}`, () => {
        const r = run(base(), ["--parse-idle", inp]);
        expect(r.out).toBe(exp);
      });
    }
  });
});
