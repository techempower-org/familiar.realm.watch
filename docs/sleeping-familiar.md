# Putting familiar to sleep

`realm wol sleep familiar` used to appear to do nothing, or to wake the host straight
back up. It was three independent faults stacked, each of which reproduces the symptom on
its own. All three are fixed; this is the operator's view.

## The short version

```bash
realm wol sleep familiar      # quiesces, suspends, and VERIFIES the host went dark
realm wol wake familiar       # wakes it; the resume hook restores everything
```

`sleep` now returns `verified: true` only after the host stops answering. If it comes back
`ok: false` with a `reason`, the suspend genuinely did not hold — believe it.

## What actually happens

| Step | Where |
|---|---|
| 1. Set the HA "let familiar sleep" hold | `familiar-ha-hold on` |
| 2. Stop `qwen3-coder` + `donkey-llm` (frees ~10 GB of GPU-pinned system RAM) | `familiar-sleep-now` |
| 3. `systemd-run --no-block systemctl suspend` | `familiar-sleep-now` |
| 4. Poll until the host goes dark, then report | `plugins/wol/power_ops.py` (realmwatch) |
| 5. On resume: restart the lanes, clear the hold | `familiar-ml-quiesce` (system-sleep hook) |

Install/refresh all of it with `ops/scripts/install-familiar-ml-quiesce.sh`.

## The three faults, and why each mattered

**1. The suspend OOM'd and rolled back.** The llama-server lanes pin ~10 GB of GPU buffers
in *system* RAM and fill the 16 GB zram swap. At suspend entry the kernel cannot reclaim
(kswapd is frozen, storage is going down), so only already-free memory counts — and there
was ~1.5 GB. Measured: with the lanes running, the prepare phase took **81.7 s and killed 7
processes**, and the host reached S3 for ~2 s. With them stopped: **0.06 s**, nothing killed.

**2. Home Assistant woke it back up.** Ember treats a sleeping familiar as a fault and heals
it — any announce, presence event or satellite listen calls `script.ember_wake_backend` →
`script.wake_familiar` → magic packet, every 75 s, forever. That is by design (added
2026-08-03) and is right when the host fell asleep on its own. `input_boolean
.familiar_sleep_hold` is the off switch, and familiar flips it itself.

**3. katana woke it back up.** mempalace's `auto_wake` fires `realm wol wake familiar`
whenever a palace query finds the daemon down — including from Claude Code hooks, with
nobody typing anything. One packet ended a deliberate sleep 245 ms later. Now routed
through `familiar-wake-unless-held`, which checks the same hold.

## Diagnosing it if it regresses

**Did it actually sleep, or just prepare?** Wall-clock timestamps cannot tell you: journald
is frozen through the suspend, so everything from "Freezing user space processes" onward is
stamped at resume. Use the kernel's monotonic clock, which stops during S3 —

```bash
ssh familiar "journalctl -k -o short-monotonic | grep -E 'PM: suspend (entry|exit)'"
```

Wall-elapsed minus monotonic-elapsed **is** the time spent asleep.

**What woke it?** Not the ACPI counters — on this board `sci`, `gpe_all` and `ff_pwr_btn`
all stay 0 across real wakes, and `PNP0C0C:00` gains events as a resume artifact. Watch the
wire instead. A magic packet is UDP/9 with a 102-byte payload:

```bash
sudo tcpdump -i enp5s0 -nn -e 'udp port 9 or udp port 7 or ether proto 0x0842'
```

The source address names the culprit directly.

**Did the quiesce run?** `ssh familiar "journalctl -u systemd-suspend -n 40"`. If you see
`WARNING: ... still running at suspend entry`, the sleep bypassed `familiar-sleep-now` (a
bare `systemctl suspend` does) and will probably OOM — systemd will report success anyway.

## Known edges

- A **bare `systemctl suspend`** on the host skips the quiesce. It still gets the HA hold and
  the resume-side restore, and the hook warns loudly, but expect a rollback.
- The 12 h hold expiry is an automation `delay`, which **does not survive an HA restart**. If
  HA restarts while the hold is on, the hold persists until something clears it — familiar
  stays asleep rather than being woken against your wishes. The dashboard toggle
  ("Familiar: let it sleep") is the real off switch.
- `familiar-wake-unless-held` **fails open**: if HA is unreachable it wakes as before, and
  says so on stderr.
