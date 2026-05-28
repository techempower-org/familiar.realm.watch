/**
 * GET /api/familiar/stats
 *
 * Host snapshot: CPU, memory, disk, network, and GPU. Designed for polling at
 * roughly 1–5s intervals by dashboard widgets (Luna's grid). Response is cached
 * for ~2 seconds in-process to cap load when many widgets poll concurrently.
 *
 * Implementation notes:
 *   - CPU `per_core_pct` and Net `*_mbps` are deltas — we keep the previous
 *     /proc snapshot in module-scope state. The first request after process
 *     start returns 0 for the deltas (one sample is not enough). Subsequent
 *     polls compute the diff against the cached prior sample. The 2s cache
 *     window means widgets that poll faster than that get the same answer
 *     but still see meaningful deltas because we snapshot at cache-refresh
 *     time, not per-request.
 *   - GPU info comes from `nvidia-smi --query-gpu=...`. Spawned with argv
 *     array (no shell). If nvidia-smi is missing or fails, `gpu` is `[]`.
 *   - Disk uses `df -B1 --output=...` filtering pseudo-fs (tmpfs, devtmpfs,
 *     squashfs, efivarfs, overlay). Same argv-array discipline.
 */

export interface StatsResponse {
  ts: string;
  uptime_seconds: number;
  cpu: {
    cores: number;
    load_1m: number;
    load_5m: number;
    load_15m: number;
    /** Per-core busy percentage (0–100), computed as a delta vs. the prior sample. Empty array if no prior sample exists yet. */
    per_core_pct: number[];
  };
  mem: {
    total_mb: number;
    used_mb: number;
    available_mb: number;
    swap_total_mb: number;
    swap_used_mb: number;
  };
  disk: Array<{
    mount: string;
    fs: string;
    total_gb: number;
    used_gb: number;
    used_pct: number;
  }>;
  net: Array<{
    iface: string;
    rx_mbps: number;
    tx_mbps: number;
    rx_bytes_total: number;
    tx_bytes_total: number;
  }>;
  gpu: Array<{
    index: number;
    name: string;
    vram_total_mb: number;
    vram_used_mb: number;
    util_pct: number;
    temp_c: number;
  }>;
}

interface CpuSample {
  // [user, nice, system, idle, iowait, irq, softirq, steal, ...]
  perCpu: Array<number[]>;
  takenAt: number;
}

interface NetSample {
  // iface -> { rxBytes, txBytes }
  ifaces: Map<string, { rx: number; tx: number }>;
  takenAt: number;
}

// Module-scope state. These two samples plus the cached response are the only
// global state in this module.
let priorCpu: CpuSample | null = null;
let priorNet: NetSample | null = null;

interface Cached {
  body: StatsResponse;
  expiresAt: number;
}
let cache: Cached | null = null;
const CACHE_TTL_MS = 2000;

// Injection seam so tests can mock subprocess and file reads without
// monkey-patching the global Bun namespace.
export interface StatsDeps {
  readFile?: (path: string) => string;
  spawnSync?: (cmd: string[]) => { stdout: string; exitCode: number };
  now?: () => number;
}

function defaultReadFile(path: string): string {
  // Bun.file is async; for tiny /proc files the sync `readFileSync` shim via
  // node:fs is fine and lets the collector stay synchronous (cheap, predictable).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("node:fs") as typeof import("node:fs");
  return fs.readFileSync(path, "utf8");
}

function defaultSpawnSync(cmd: string[]): { stdout: string; exitCode: number } {
  const result = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe" });
  return {
    stdout: new TextDecoder().decode(result.stdout ?? new Uint8Array()),
    exitCode: result.exitCode ?? -1,
  };
}

function parseProcStat(text: string, takenAt: number): CpuSample {
  const perCpu: Array<number[]> = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("cpu")) continue;
    // First line is the aggregate "cpu  ..." (two spaces) — skip; we want per-core.
    if (line.startsWith("cpu ")) continue;
    const parts = line.trim().split(/\s+/);
    // parts[0] = "cpuN", rest are integer counters.
    const values = parts.slice(1).map((p) => Number(p) || 0);
    if (values.length >= 4) perCpu.push(values);
  }
  return { perCpu, takenAt };
}

function cpuDelta(prev: CpuSample, curr: CpuSample): number[] {
  const pcts: number[] = [];
  const n = Math.min(prev.perCpu.length, curr.perCpu.length);
  for (let i = 0; i < n; i++) {
    const a = prev.perCpu[i];
    const b = curr.perCpu[i];
    // total = sum of all fields; idle = field index 3 (idle) + 4 (iowait).
    const totalA = a.reduce((s, v) => s + v, 0);
    const totalB = b.reduce((s, v) => s + v, 0);
    const idleA = (a[3] ?? 0) + (a[4] ?? 0);
    const idleB = (b[3] ?? 0) + (b[4] ?? 0);
    const totalD = totalB - totalA;
    const idleD = idleB - idleA;
    if (totalD <= 0) { pcts.push(0); continue; }
    const busyPct = ((totalD - idleD) / totalD) * 100;
    pcts.push(Math.max(0, Math.min(100, Math.round(busyPct * 10) / 10)));
  }
  return pcts;
}

function parseMeminfo(text: string): StatsResponse["mem"] {
  const map = new Map<string, number>();
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Za-z()]+):\s+(\d+)\s*kB/);
    if (m) map.set(m[1], Number(m[2]));
  }
  const totalKb = map.get("MemTotal") ?? 0;
  const availKb = map.get("MemAvailable") ?? 0;
  const swapTotalKb = map.get("SwapTotal") ?? 0;
  const swapFreeKb = map.get("SwapFree") ?? 0;
  return {
    total_mb: Math.round(totalKb / 1024),
    used_mb: Math.round((totalKb - availKb) / 1024),
    available_mb: Math.round(availKb / 1024),
    swap_total_mb: Math.round(swapTotalKb / 1024),
    swap_used_mb: Math.round((swapTotalKb - swapFreeKb) / 1024),
  };
}

function parseLoadavg(text: string): { load_1m: number; load_5m: number; load_15m: number } {
  const parts = text.trim().split(/\s+/);
  return {
    load_1m: Number(parts[0]) || 0,
    load_5m: Number(parts[1]) || 0,
    load_15m: Number(parts[2]) || 0,
  };
}

function parseUptime(text: string): number {
  const parts = text.trim().split(/\s+/);
  return Math.round(Number(parts[0]) || 0);
}

function parseProcNetDev(text: string, takenAt: number): NetSample {
  const ifaces = new Map<string, { rx: number; tx: number }>();
  const lines = text.split("\n");
  // Skip the two header lines.
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^\s*([^:]+):\s*(.+)$/);
    if (!m) continue;
    const iface = m[1].trim();
    const cols = m[2].trim().split(/\s+/).map((v) => Number(v) || 0);
    // cols[0] = rx bytes, cols[8] = tx bytes.
    ifaces.set(iface, { rx: cols[0] ?? 0, tx: cols[8] ?? 0 });
  }
  return { ifaces, takenAt };
}

function netDelta(prev: NetSample, curr: NetSample): StatsResponse["net"] {
  const dtSec = Math.max(0.001, (curr.takenAt - prev.takenAt) / 1000);
  const result: StatsResponse["net"] = [];
  for (const [iface, cur] of curr.ifaces) {
    // Skip loopback — it dominates totals on a busy host and is never the
    // metric a dashboard cares about. Widgets can filter further if they want.
    if (iface === "lo") continue;
    const prv = prev.ifaces.get(iface);
    const rxBytes = prv ? Math.max(0, cur.rx - prv.rx) : 0;
    const txBytes = prv ? Math.max(0, cur.tx - prv.tx) : 0;
    const rxMbps = (rxBytes * 8) / (dtSec * 1_000_000);
    const txMbps = (txBytes * 8) / (dtSec * 1_000_000);
    result.push({
      iface,
      rx_mbps: Math.round(rxMbps * 100) / 100,
      tx_mbps: Math.round(txMbps * 100) / 100,
      rx_bytes_total: cur.rx,
      tx_bytes_total: cur.tx,
    });
  }
  return result;
}

function collectDisk(spawnSync: (cmd: string[]) => { stdout: string; exitCode: number }): StatsResponse["disk"] {
  // df -B1 prints byte-exact columns; --output picks fields in a stable order.
  const { stdout, exitCode } = spawnSync([
    "df", "-B1",
    "--output=source,fstype,target,size,used,avail",
    "-x", "tmpfs", "-x", "devtmpfs", "-x", "squashfs", "-x", "efivarfs", "-x", "overlay",
  ]);
  if (exitCode !== 0) return [];
  const lines = stdout.split("\n").slice(1).filter((l) => l.trim());
  const out: StatsResponse["disk"] = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const [, fs, mount, sizeStr, usedStr] = parts;
    const total = Number(sizeStr) || 0;
    const used = Number(usedStr) || 0;
    // df's "size" can be 0 for special mounts that slipped past the filters
    // (e.g. snap-loop devices). Skip them so the widget doesn't render a
    // 0/0 GB pie chart.
    if (total === 0) continue;
    const usedPct = total > 0 ? Math.round((used / total) * 1000) / 10 : 0;
    out.push({
      mount,
      fs,
      total_gb: Math.round((total / 1_000_000_000) * 10) / 10,
      used_gb: Math.round((used / 1_000_000_000) * 10) / 10,
      used_pct: usedPct,
    });
  }
  return out;
}

function collectGpu(spawnSync: (cmd: string[]) => { stdout: string; exitCode: number }): StatsResponse["gpu"] {
  // CSV format, no header, no units (so we don't have to strip "MiB", "%", "C").
  const { stdout, exitCode } = spawnSync([
    "nvidia-smi",
    "--query-gpu=index,name,memory.total,memory.used,utilization.gpu,temperature.gpu",
    "--format=csv,noheader,nounits",
  ]);
  if (exitCode !== 0) return [];
  const out: StatsResponse["gpu"] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.split(",").map((c) => c.trim());
    if (cols.length < 6) continue;
    out.push({
      index: Number(cols[0]) || 0,
      name: cols[1],
      vram_total_mb: Number(cols[2]) || 0,
      vram_used_mb: Number(cols[3]) || 0,
      util_pct: Number(cols[4]) || 0,
      temp_c: Number(cols[5]) || 0,
    });
  }
  return out;
}

export function collectStats(deps: StatsDeps = {}): StatsResponse {
  const readFile = deps.readFile ?? defaultReadFile;
  const spawnSync = deps.spawnSync ?? defaultSpawnSync;
  const now = deps.now ?? (() => Date.now());

  const ts = now();

  // CPU sample: current /proc/stat, compute delta if we have a prior sample.
  const cpuNow = parseProcStat(readFile("/proc/stat"), ts);
  const per_core_pct = priorCpu ? cpuDelta(priorCpu, cpuNow) : [];
  priorCpu = cpuNow;

  // Net sample: same pattern.
  const netNow = parseProcNetDev(readFile("/proc/net/dev"), ts);
  const net = priorNet ? netDelta(priorNet, netNow) : [...netNow.ifaces.entries()]
    .filter(([iface]) => iface !== "lo")
    .map(([iface, v]) => ({
      iface,
      rx_mbps: 0,
      tx_mbps: 0,
      rx_bytes_total: v.rx,
      tx_bytes_total: v.tx,
    }));
  priorNet = netNow;

  const loadavg = parseLoadavg(readFile("/proc/loadavg"));
  const uptime = parseUptime(readFile("/proc/uptime"));
  const mem = parseMeminfo(readFile("/proc/meminfo"));

  return {
    ts: new Date(ts).toISOString(),
    uptime_seconds: uptime,
    cpu: {
      cores: cpuNow.perCpu.length,
      ...loadavg,
      per_core_pct,
    },
    mem,
    disk: collectDisk(spawnSync),
    net,
    gpu: collectGpu(spawnSync),
  };
}

/** Test-only: clear cache + delta history. */
export function _resetStatsState(): void {
  priorCpu = null;
  priorNet = null;
  cache = null;
}

export async function handleStats(_req: Request, deps: StatsDeps = {}): Promise<Response> {
  const now = (deps.now ?? (() => Date.now()))();
  if (cache && cache.expiresAt > now) {
    return new Response(JSON.stringify(cache.body), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "max-age=2" },
    });
  }
  try {
    const body = collectStats(deps);
    cache = { body, expiresAt: now + CACHE_TTL_MS };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "max-age=2" },
    });
  } catch (err) {
    return new Response(JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    }), { status: 500, headers: { "content-type": "application/json" } });
  }
}
