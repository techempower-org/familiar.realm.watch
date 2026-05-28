import { test, expect, describe, beforeEach } from "bun:test";
import { handleStats, collectStats, _resetStatsState } from "../src/routes/stats.ts";
import type { StatsDeps } from "../src/routes/stats.ts";

// Captured /proc snapshots. Two CPU samples differ by 100 ticks of "user" on
// cpu0 with no idle change → delta should report ~100% busy on cpu0.
const PROC_STAT_T0 = `cpu  1000 0 0 1000 0 0 0 0 0 0
cpu0 100 0 0 100 0 0 0 0 0 0
cpu1 100 0 0 100 0 0 0 0 0 0
intr 12345 0 0 0
`;
const PROC_STAT_T1 = `cpu  1100 0 0 1000 0 0 0 0 0 0
cpu0 200 0 0 100 0 0 0 0 0 0
cpu1 150 0 0 150 0 0 0 0 0 0
intr 12500 0 0 0
`;

const MEMINFO = `MemTotal:       32775692 kB
MemFree:         2215824 kB
MemAvailable:   19872900 kB
SwapTotal:       8388604 kB
SwapFree:        8000000 kB
`;

const LOADAVG = `0.42 0.55 0.61 1/100 1234\n`;
const UPTIME = `106509.71 492328.36\n`;

const NETDEV_T0 = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0
enp5s0: 1000000 100 0 0 0 0 0 0 500000 50 0 0 0 0 0 0
`;
const NETDEV_T1 = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0
enp5s0: 2000000 200 0 0 0 0 0 0 1500000 100 0 0 0 0 0 0
`;

function fakeReadFiles(stat: string, net: string): (path: string) => string {
  return (path: string) => {
    if (path === "/proc/stat") return stat;
    if (path === "/proc/meminfo") return MEMINFO;
    if (path === "/proc/loadavg") return LOADAVG;
    if (path === "/proc/uptime") return UPTIME;
    if (path === "/proc/net/dev") return net;
    throw new Error(`unexpected read: ${path}`);
  };
}

function fakeSpawn(): (cmd: string[]) => { stdout: string; exitCode: number } {
  return (cmd: string[]) => {
    if (cmd[0] === "nvidia-smi") {
      // Two GPUs — what familiar actually has (P102 + P102 in prod, here we
      // pretend). Format: index, name, total_mb, used_mb, util_pct, temp_c.
      return {
        stdout: "0, NVIDIA P102-100, 10240, 4096, 75, 65\n1, NVIDIA P102-100, 10240, 2048, 25, 55\n",
        exitCode: 0,
      };
    }
    if (cmd[0] === "df") {
      // Matches stats.ts's `df -B1 --output=source,fstype,target,size,used,avail`.
      // stats.ts skips the header line, so any first row works — kept here so a
      // reader can map columns to the --output= fields at a glance.
      return {
        stdout: [
          "source         fstype   target       size          used         avail",
          "/dev/nvme0n1p2 ext4     /            1000000000000 500000000000 500000000000",
          "/dev/nvme1n1   btrfs    /mnt/games   250000000000  125000000000 125000000000",
        ].join("\n") + "\n",
        exitCode: 0,
      };
    }
    return { stdout: "", exitCode: 127 };
  };
}

describe("collectStats", () => {
  beforeEach(() => { _resetStatsState(); });

  test("first call returns shape with empty per_core deltas and 0 net rates", () => {
    const deps: StatsDeps = {
      readFile: fakeReadFiles(PROC_STAT_T0, NETDEV_T0),
      spawnSync: fakeSpawn(),
      now: () => Date.parse("2026-05-28T12:00:00Z"),
    };
    const stats = collectStats(deps);
    expect(stats.ts).toBe("2026-05-28T12:00:00.000Z");
    expect(stats.uptime_seconds).toBe(106510);
    expect(stats.cpu.cores).toBe(2);
    expect(stats.cpu.load_1m).toBe(0.42);
    expect(stats.cpu.load_5m).toBe(0.55);
    expect(stats.cpu.load_15m).toBe(0.61);
    // First sample → no delta yet.
    expect(stats.cpu.per_core_pct).toEqual([]);
    // mem: total 32775692/1024 ≈ 32008 MB; used = (total - available)/1024.
    expect(stats.mem.total_mb).toBe(Math.round(32775692 / 1024));
    expect(stats.mem.available_mb).toBe(Math.round(19872900 / 1024));
    expect(stats.mem.used_mb).toBe(Math.round((32775692 - 19872900) / 1024));
    expect(stats.mem.swap_total_mb).toBe(Math.round(8388604 / 1024));
    expect(stats.mem.swap_used_mb).toBe(Math.round((8388604 - 8000000) / 1024));
    // First net sample: rx_mbps/tx_mbps == 0, totals carried through. lo filtered.
    expect(stats.net).toHaveLength(1);
    expect(stats.net[0].iface).toBe("enp5s0");
    expect(stats.net[0].rx_mbps).toBe(0);
    expect(stats.net[0].tx_mbps).toBe(0);
    expect(stats.net[0].rx_bytes_total).toBe(1000000);
    // GPU: two cards from the mocked nvidia-smi.
    expect(stats.gpu).toHaveLength(2);
    expect(stats.gpu[0]).toEqual({
      index: 0,
      name: "NVIDIA P102-100",
      vram_total_mb: 10240,
      vram_used_mb: 4096,
      util_pct: 75,
      temp_c: 65,
    });
    // Disk: ext4 + btrfs, both present, in GB.
    expect(stats.disk).toHaveLength(2);
    expect(stats.disk[0].mount).toBe("/");
    expect(stats.disk[0].fs).toBe("ext4");
    expect(stats.disk[0].total_gb).toBeCloseTo(1000, 0);
    expect(stats.disk[0].used_gb).toBeCloseTo(500, 0);
    expect(stats.disk[0].used_pct).toBe(50);
  });

  test("second call computes per-core deltas and net throughput", () => {
    const t0 = Date.parse("2026-05-28T12:00:00Z");
    const t1 = Date.parse("2026-05-28T12:00:01Z"); // +1s

    // Prime with sample 0.
    collectStats({
      readFile: fakeReadFiles(PROC_STAT_T0, NETDEV_T0),
      spawnSync: fakeSpawn(),
      now: () => t0,
    });
    // Sample 1.
    const s1 = collectStats({
      readFile: fakeReadFiles(PROC_STAT_T1, NETDEV_T1),
      spawnSync: fakeSpawn(),
      now: () => t1,
    });
    // cpu0: total delta = (200+100) - (100+100) = 100; idle delta = 0 → 100%.
    expect(s1.cpu.per_core_pct[0]).toBeCloseTo(100, 0);
    // cpu1: total delta = (150+150) - (100+100) = 100; idle delta = 50 → 50%.
    expect(s1.cpu.per_core_pct[1]).toBeCloseTo(50, 0);
    // Net: rx bytes 1M → 2M over 1s = 1MB/s = 8 Mbps.
    expect(s1.net[0].rx_mbps).toBeCloseTo(8, 0);
    expect(s1.net[0].tx_mbps).toBeCloseTo(8, 0); // 500K → 1.5M = 1MB/s = 8Mbps.
  });
});

describe("handleStats", () => {
  beforeEach(() => { _resetStatsState(); });

  test("returns 200 + JSON content-type", async () => {
    const deps: StatsDeps = {
      readFile: fakeReadFiles(PROC_STAT_T0, NETDEV_T0),
      spawnSync: fakeSpawn(),
      now: () => 1_700_000_000_000,
    };
    const res = await handleStats(new Request("http://localhost/api/familiar/stats"), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json() as { gpu: unknown[]; cpu: { cores: number } };
    expect(body.gpu).toHaveLength(2);
    expect(body.cpu.cores).toBe(2);
  });

  test("caches response for ~2s — second call within TTL skips collection", async () => {
    let readCalls = 0;
    const counting: StatsDeps = {
      readFile: (path: string) => {
        readCalls++;
        return fakeReadFiles(PROC_STAT_T0, NETDEV_T0)(path);
      },
      spawnSync: fakeSpawn(),
      now: () => 1_700_000_000_000,
    };
    await handleStats(new Request("http://localhost/api/familiar/stats"), counting);
    const callsAfterFirst = readCalls;
    // Immediate second request: same `now` → cache hit.
    await handleStats(new Request("http://localhost/api/familiar/stats"), counting);
    expect(readCalls).toBe(callsAfterFirst);

    // Advance time past TTL → cache miss, collection runs again.
    const advanced: StatsDeps = { ...counting, now: () => 1_700_000_000_000 + 3000 };
    await handleStats(new Request("http://localhost/api/familiar/stats"), advanced);
    expect(readCalls).toBeGreaterThan(callsAfterFirst);
  });

  test("nvidia-smi missing → gpu is empty array, response still 200", async () => {
    const noGpu: StatsDeps = {
      readFile: fakeReadFiles(PROC_STAT_T0, NETDEV_T0),
      spawnSync: (cmd: string[]) => {
        if (cmd[0] === "nvidia-smi") return { stdout: "", exitCode: 127 };
        return fakeSpawn()(cmd);
      },
      now: () => 1_700_000_000_000,
    };
    const res = await handleStats(new Request("http://localhost/api/familiar/stats"), noGpu);
    expect(res.status).toBe(200);
    const body = await res.json() as { gpu: unknown[] };
    expect(body.gpu).toEqual([]);
  });
});
