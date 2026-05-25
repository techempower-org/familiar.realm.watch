#!/usr/bin/env python3
"""Collect system metrics from the local host as JSON.

Designed to run on familiar via SSH, output consumed by wave-block custom mode.
No external deps — stdlib only.
"""
import json
import os
import subprocess


def _read(path: str) -> str:
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return ""


def _run(cmd: list[str], timeout: int = 5) -> str:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.stdout.strip()
    except Exception:
        return ""


def collect() -> dict:
    m = {}

    # Load average
    loadavg = _read("/proc/loadavg").split()
    if loadavg:
        m["load_1m"] = float(loadavg[0])
        m["load_5m"] = float(loadavg[1])
        m["load_15m"] = float(loadavg[2])

    # Memory
    meminfo = {}
    for line in _read("/proc/meminfo").splitlines():
        parts = line.split()
        if len(parts) >= 2:
            meminfo[parts[0].rstrip(":")] = int(parts[1])
    total = meminfo.get("MemTotal", 1)
    avail = meminfo.get("MemAvailable", 0)
    swap_total = meminfo.get("SwapTotal", 0)
    swap_free = meminfo.get("SwapFree", 0)
    m["ram_total_gb"] = round(total / 1048576, 1)
    m["ram_used_gb"] = round((total - avail) / 1048576, 1)
    m["ram_avail_gb"] = round(avail / 1048576, 1)
    m["ram_pct"] = round((total - avail) / total * 100, 1)
    if swap_total > 0:
        m["swap_used_gb"] = round((swap_total - swap_free) / 1048576, 1)
        m["swap_pct"] = round((swap_total - swap_free) / swap_total * 100, 1)

    # Disk
    st = os.statvfs("/")
    total_gb = st.f_frsize * st.f_blocks / 1073741824
    free_gb = st.f_frsize * st.f_bfree / 1073741824
    m["disk_total_gb"] = round(total_gb, 1)
    m["disk_used_gb"] = round(total_gb - free_gb, 1)
    m["disk_pct"] = round((total_gb - free_gb) / total_gb * 100, 1)

    # CPU temp
    for zone in sorted(os.listdir("/sys/class/thermal/") if os.path.isdir("/sys/class/thermal") else []):
        temp = _read(f"/sys/class/thermal/{zone}/temp")
        if temp and temp.isdigit():
            m["cpu_temp_c"] = int(temp) // 1000
            break

    # GPU temps via nvidia-smi
    gpu_out = _run(["nvidia-smi", "--query-gpu=temperature.gpu", "--format=csv,noheader,nounits"])
    if gpu_out:
        temps = [int(t.strip()) for t in gpu_out.splitlines() if t.strip().isdigit()]
        for i, t in enumerate(temps):
            m[f"gpu{i}_temp_c"] = t

    # Postgres connections
    pg_out = _run([
        "docker", "exec", "mempalace-db",
        "psql", "-U", "palace", "-d", "mempalace_2026_05_13",
        "-t", "-c", "SELECT count(*) FROM pg_stat_activity WHERE state != 'idle'"
    ])
    if pg_out.strip().isdigit():
        m["pg_active_conns"] = int(pg_out.strip())

    # Uptime
    uptime_s = _read("/proc/uptime").split()
    if uptime_s:
        m["uptime_hours"] = round(float(uptime_s[0]) / 3600, 1)

    return m


if __name__ == "__main__":
    print(json.dumps(collect()))
