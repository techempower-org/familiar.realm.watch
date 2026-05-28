# familiar host memory tuning — 2026-05-28

Runbook for issue [#58](https://github.com/techempower-org/familiar.realm.watch/issues/58).

Author: Twilight (familiar-realm-dreamteam, 2026-05-28). Diagnosis only — JP applies the changes manually on familiar.

## Symptom

```
              total        used        free      shared  buff/cache   available
Mem:           15Gi        14Gi       176Mi       2.1Gi       3.2Gi       953Mi
Swap:         7.8Gi       6.5Gi       1.3Gi
```

93% memory used, 6.5 GiB swap in active use, available memory at ~950 MiB. This is below the comfort floor for a host that runs postgres, an LLM inference server, the palace HTTP gateway, KG-extract workers, and the production familiar-api.

This issue was opened with 5.5 GiB swap; it has since grown to 6.5 GiB — the host is trending the wrong way.

## Root cause

`llama-server-extractor.service` is swap-thrashing under its own cgroup limit.

```
$ sudo grep -E "(VmPeak|VmHWM|VmRSS|VmSwap)" /proc/$(pidof llama-server)/status
VmPeak: 58463012 kB    # 57 GiB virtual (mostly mmap'd Phi-4-mini.gguf)
VmHWM:   3358608 kB    # 3.20 GiB peak resident
VmRSS:   3080004 kB    # 2.94 GiB currently resident
VmSwap:  5615780 kB    # 5.36 GiB swapped out

$ systemctl show llama-server-extractor.service -p MemoryMax,MemorySwapMax
MemoryMax=3221225472   # 3.0 GiB cgroup cap
MemorySwapMax=infinity # no swap cap — overflow allowed
```

The combination of these settings creates a swap pump:

1. The 3 GiB `MemoryMax` cap is *exactly* at llama-server's `VmHWM` ceiling.
2. Whenever the host wants any anonymous page from llama-server (KV cache, decode buffers, prompt-cache, sampler state), the cgroup forces older pages out to swap to stay under the cap.
3. With `MemorySwapMax=infinity`, the kernel happily evicts pages indefinitely. The model file is mmap'd from `/var/cache/llama/models/Phi-4-mini-instruct-Q4_K_M.gguf` (~3.6 GiB) and re-faults on every decode, dragging swap I/O onto the data path.
4. Result: ~85% of the host's 6.5 GiB swap is llama-server's own pages, churning constantly. This costs latency for every request to :11436 and starves postgres of buffer cache.

Familiar-loadguard never trips because it watches `load1` thresholds (warn 30 / throttle 45 / panic 60); a host quietly swap-thrashing at load 5 doesn't fire the guard.

## Memory budget (current, swap-included)

| Service              | RSS    | Swap   | Footprint | Cap          |
|----------------------|--------|--------|-----------|--------------|
| llama-server-extractor | 3.1 GiB | 5.6 GiB | **8.7 GiB** | 3 GiB |
| mempalace-db (postgres) | 2.3 GiB | n/a | 2.3 GiB | 6 GiB (cgroup) |
| postgres backends (combined RssShmem-corrected) | ~3 GiB | ~0 | 3 GiB | n/a |
| palace-daemon | 1.5 GiB | 0.5 GiB | 2.0 GiB | 2 GiB |
| kg-extract worker | 0.1 GiB | 0.4 GiB | 0.5 GiB | 1 GiB |
| familiar-api (Bun) | 0.1 GiB | <0.1 GiB | 0.1 GiB | 2 GiB |
| syncthing, dockerd, tailscaled, OS | ~0.5 GiB | ~0.1 GiB | ~0.6 GiB | — |
| **total real working set** | | | **~17 GiB** | — |

Host has 15 GiB physical. Working set wants ~17 GiB. Difference (2 GiB) is the swap pressure.

## Proposed actions (priority order)

### 1. Stop llama-server swap thrash (do this first)

The cheapest fix is to forbid llama-server from spilling to swap at all, and instead size its `MemoryMax` to its actual `VmHWM` + a small margin.

Edit `/etc/systemd/system/llama-server-extractor.service.d/z-dual-gpu.conf`:

```ini
[Service]
MemoryMax=4G
MemorySwapMax=0
ExecStart=
ExecStart=/opt/llama.cpp/build/bin/llama-server \
  --model /var/cache/llama/models/Phi-4-mini-instruct-Q4_K_M.gguf \
  --port 11436 --host 0.0.0.0 \
  --n-gpu-layers 999 --ctx-size 4096 --parallel 4 --threads 8 \
  --cont-batching --alias phi-4-mini --mlock
```

Three changes:
- `MemoryMax=4G` — raise from 3 GiB to match observed VmHWM (3.36 GiB) plus headroom for `--parallel 4 × ctx 4096` host-side prompt cache.
- `MemorySwapMax=0` — refuse swap entirely. If memory pressure exceeds the cap, the cgroup OOM-kills llama-server (clean failure, loadguard sees it, restart kicks in) instead of silently degrading every request.
- `--mlock` — pin the model file's mmap pages in RAM. Stops the page-fault-then-swap-out cycle on cold tokens.

Risk: if `--mlock` + `MemorySwapMax=0` collides with a transient spike, llama-server gets OOM-killed and restarts (~5s of downtime). This is a strictly better failure mode than the current silent swap-thrash, and the systemd unit already has `Restart=on-failure`.

Expected impact: frees ~5.5 GiB of swap, reduces postgres + palace-daemon latency variance (no I/O contention from swap), and brings the host back to ~60% memory used.

### 2. Lower postgres `max_connections` from 200 to 32

Postgres is configured for 200 connections but only ~16 are ever active (palace-daemon's pool is sized to 8 per worker × 1-2 workers).

```
$ docker exec mempalace-db psql -U palace -d mempalace_2026_05_13 -c \
    "SELECT state, count(*) FROM pg_stat_activity GROUP BY state;"
 state  | count
--------+-------
 active |     2
 idle   |     9
        |     5
```

Each `max_connections` slot reserves ~10 MB of process table + lock manager state per backend even when idle. Dropping `max_connections` from 200 to 32 frees ~1.5 GiB of postgres process overhead. 32 is 2× the observed peak, ample headroom.

Edit the postgres config inside the mempalace-db container (this is the same file managed by palace-daemon repo #117):

```
max_connections = 32   # was 200
```

Reload requires a postgres restart (`docker restart mempalace-db`). DO NOT do this during writethrough load — palace-daemon will reconnect cleanly but in-flight queries error out. Coordinate with JP.

### 3. Document the next-RAM-bump path

Even after fixes 1 and 2, the host budget is tight:

| Bucket | Reservation |
|--------|-------------|
| postgres (shared_buffers + backends, max_connections=32) | 4 GiB |
| llama-server-extractor (capped, mlock'd) | 4 GiB |
| palace-daemon | 2 GiB |
| kg-extract worker | 0.5 GiB |
| familiar-api | 0.3 GiB |
| OS + buff/cache + dockerd + syncthing + tailscaled | 3 GiB |
| **total** | **~14 GiB / 15 GiB** |

Slack: ~1 GiB. Any new memory-hungry service on familiar exhausts this. Likely next steps:

- **Move palace-daemon to katana** (4 GiB freed on familiar; katana has 64 GiB). Requires a network DSN to mempalace-db (already exposed on :5433) and updating MCP bridge config. Estimated 30 min work.
- **Move kg-extract worker to katana** (already feasible — katana has its own `mempalace-kg-extract@.service`). Familiar becomes a pure inference + database host.
- **Upgrade familiar to 32 GiB RAM**. If familiar is bare-metal, this is a physical mod. If it's a VM/VPS, a config bump. Either way it's the cleanest path — postgres can grow `shared_buffers` to 4 GiB, llama-server can run `--ctx 8192 --parallel 8` again, palace-daemon stays put.

The cheapest first move is fix 1; the 32 GiB bump is the cleanest long-term move; service migration to katana is intermediate.

## Sub-issues to file

- `ops: cap llama-server-extractor swap (MemorySwapMax=0) + add --mlock` — applies fix 1
- `ops: lower mempalace-db max_connections from 200 to 32` — applies fix 2 (palace-daemon repo, blocked on JP coordinating restart window)
- `ops: evaluate moving palace-daemon and/or kg-extract worker off familiar` — long-running discussion issue

## Verification (after applying fix 1)

```bash
ssh familiar 'free -h && ps -p $(pidof llama-server) -o pid,rss,vsz,command && \
  sudo grep -E "(VmHWM|VmRSS|VmSwap)" /proc/$(pidof llama-server)/status && \
  systemctl show llama-server-extractor.service -p MemoryCurrent,MemoryMax,MemorySwapMax'
```

Expect:
- `Swap: used` drops from 6.5 GiB to <1 GiB within ~5 min as kernel reclaims swapped pages.
- `VmSwap` for llama-server reads near-zero.
- `MemoryCurrent` for the service settles near 3.5–4.0 GiB.
- `free -h` reports `available` > 4 GiB.

If llama-server OOM-restarts after the change, the `--parallel 4 × ctx 4096` configuration is over-budget for 4 GiB; drop to `--parallel 2` or reduce ctx to 3072 and re-test.

## Refs

- [#58](https://github.com/techempower-org/familiar.realm.watch/issues/58) — this ticket
- [palace-daemon#117](https://github.com/techempower-org/palace-daemon/pull/117) — mempalace-db cgroup raised to 6 GiB
- [palace-daemon#99](https://github.com/techempower-org/palace-daemon/issues/99) — memory canary
- `familiar-loadguard.service` — existing watchdog, currently only `load1`-aware (memory thresholds would catch this earlier)
