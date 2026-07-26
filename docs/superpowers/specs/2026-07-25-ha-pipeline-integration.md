# Spec: Connecting Claude Code to Home Assistant Pipeline via Qwen36-coder

**Date:** 2026-07-25
**Status:** Implemented (infrastructure)
**Author:** JP / Claude Code

## 1. Architecture Overview

```
┌────────────────────┐    ┌─────────────────────────┐    ┌──────────────────────────┐
│  katana            │    │  familiar                │    │  ha.jphe.in (ha VM)      │
│  10.0.6.129        │    │  10.0.6.124              │    │  10.0.6.108            │
│                    │    │                          │    │                          │
│  Claude Code CLI   │───▶│  Qwen36-coder            │    │  Home Assistant          │
│  (claude-local-qwen)│   │  llama.cpp /v1/messages  │───▶  2026.7.2              │
│                    │    │  :8091                   │    │  3,351 entities,         │
│                    │    │                          │    │  36 packages, 97 svc dom │
└────────────────────┘    └────────────┬─────────────┘    └──────────────────────────┘
                                      │
                               ┌──────┴───────┐
                               │  2× P102-100 │
                               │  Pascal SM 52│
                               │  52+61, 20GB │
                               └──────────────┘

  Side services on familiar:
    mempalace postgres   :8085  (375K drawers, 1.7M KG triples)
    collectd             20+ hosts monitored
```

### Data flow

1. JP invokes `claude-local-qwen` on katana — this sets `ANTHROPIC_BASE_URL=http://familiar:8091` and strips MCP for GBNF stability
2. Claude Code routes through `ANTHROPIC_BASE_URL=http://familiar:8091` to Qwen36-coder (Qwen3.6-35B-A3B UD-Q3_K_XL, 16.8GB MoE, 131K context)
3. Qwen36-coder generates responses; Claude Code uses its built-in tools (Bash, Read, Write, Edit) to interact with HA
4. HA operations go through:
   - **REST API** (`ha.jphe.in:8123`) for reads and service calls
   - **SSH** (`ssh jp@10.0.6.108`) for file reads/writes (cat | ssh tee)
   - **ha-ops wrapper** (`~/Projects/ha/go/ha-ops`) for common ops

### Key constraint: 2 GPU slots = single-loop only

The dual P102 constraint means **no multi-agent fan-out**. Each agent call consumes one slot. Claude Code's single-loop agent mode works fine for sequential tasks. The model can handle ~40 tok/s generation at full context, ~960 tok/s prefill on short context.

## 2. How Claude Code Connects to HA

### 2.1 REST API (primary read channel)

```bash
# Read states
curl -s -H "Authorization: Bearer $TOKEN" https://ha.jphe.in:8123/api/states
# Read single entity
curl -s -H "Authorization: Bearer $TOKEN" https://ha.jphe.in:8123/api/states/sensor.epever_pv_power
# Call services
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  https://ha.jphe.in:8123/api/services/switch/turn_on \
  -d '{"entity_id": "switch.goodwe_off_grid"}'
# Config check
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  https://ha.jphe.in:8123/api/config/core/check_config
```

Token: `bw get password ha-llat`

### 2.2 SSH to HA VM (for file edits)

```bash
ssh jp@10.0.6.108 "ls /homeassistant/packages/"
ssh jp@10.0.6.108 "cat /homeassistant/packages/solar_arbitrage.yaml"
```

File writes use `cat local | ssh remote "sudo tee /path > /dev/null"` (no scp subsystem).

### 2.3 WebSocket (for mutations that REST can't do)

- `lovelace/config/save` — dashboard changes
- `energy/save_prefs` — energy dashboard
- `config_entries` — integrations
- `system_log/list` — error logs (REST `/api/error_log` is 404)
- Direct YAML config reload: `homeassistant/reload_all`

## 3. HA-Specific Claude Code Workflow

### 3.1 Package editing workflow

```
1. Claude Code reads package from HA VM via SSH:
   ssh jp@10.0.6.108 "cat /homeassistant/packages/solar_arbitrage.yaml"

2. Claude Code writes local copy to ~/Projects/ha/packages/

3. Claude Code edits the package (Read + Edit tools)

4. Claude Code deploys back to HA VM:
   cat ~/Projects/ha/packages/solar_arbitrage.yaml \
     | ssh jp@10.0.6.108 "sudo tee /homeassistant/packages/solar_arbitrage.yaml > /dev/null"

5. If template-sensor change: trigger full HA restart
   curl -X POST https://ha.jphe.in:8123/api/services/homeassistant/restart

6. If non-template change: trigger targeted reload
   curl -X POST https://ha.jphe.in:8123/api/services/homeassistant/reload_all
```

### 3.2 ESPHome workflow (already documented in ha skill)

```
cd ~/Projects/ha/scratch/
esphome compile device.yaml    # local compile, 5x faster
esphome upload device.yaml --device 10.0.6.X
```

### 3.3 HA config validation

Before deploying any change:

```bash
curl -X POST https://ha.jphe.in:8123/api/config/core/check_config \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

### 3.4 Template sensor gotcha awareness

Per CLAUDE.md, template sensor edits need a full HA restart (not reload). Dynamic entity refs via `states.sensor` domain-scans don't reliably re-render. Only explicit static entity references work.

## 4. Qwen36-coder Capability Assessment

### What it can do well
- **YAML generation and validation** — MoE architecture excels at structured output
- **Pattern matching** — recognize HA config patterns, fix syntax
- **Documentation reading** — context window holds HA docs + current config
- **Code review** — review existing packages for correctness, efficiency

### Hard limits
- **No multi-agent** — 2 GPU slots = sequential only, no fan-out
- **~40 tok/s at full context** — long sessions will feel slow
- **131K context wall** — auto-compact fires at 110K, compaction request must fit
- **Tool grammar** — must use `--strict-mcp-config` with empty MCP config to avoid GBNF parsing failures
- **Pre-fill time** — at deep context, 5-8 min before first token

### Model characteristics
- **Qwen3.6-35B-A3B UD-Q3_K_XL** — 34.7B total params, ~3.5B active per token
- **UD (Uniform Distribution)** — quantization distributes error evenly
- **131K context** — 262K trained, compressed to 131K at runtime
- **--jinja mandatory** — llama.cpp requires this for tool-calling to parse correctly

## 5. Integration: `claude-local-qwen` + `ha-ops`

### 5.1 Launcher: `claude-local-qwen`

Already exists at `~/.local/bin/claude-local-qwen` and works for HA work. It sets:

- `ANTHROPIC_BASE_URL=http://familiar:8091`
- `ANTHROPIC_MODEL=qwen36-coder`
- `API_TIMEOUT_MS=600000`
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW=110000`
- `CLAUDE_CODE_ATTRIBUTION_HEADER=0`
- Strips MCP via `--strict-mcp-config` + `empty-mcp.json` for GBNF stability

No new `claude-ha` launcher needed — cd to the workspace and invoke `claude-local-qwen` directly:

```bash
cd ~/Projects/ha && claude-local-qwen
```

### 5.2 CLAUDE.md additions for HA workspace

Add to `~/Projects/ha/CLAUDE.md`:

```markdown
## AI Operations

When working with HA config changes, Claude Code must:

1. **Read from HA VM** before editing: `ssh jp@10.0.6.108 "cat <path>"`
2. **Validate with check_config** before deploying
3. **Deploy via cat | ssh tee** — scp subsystem is unavailable
4. **Restart HA** for template-sensor changes (reload_all doesn't suffice)
5. **Check .storage/ cache** — direct file edits to .storage files get
   overwritten by HA's in-memory cache. Use WS APIs or restart immediately.
6. **No multi-agent** — Qwen36-coder has 2 GPU slots, single-loop only.
7. **Token awareness** — long sessions hit the 131K context wall. Keep
   edits focused and compact.
```

### 5.3 HA-specific utility script: `ha-ops`

Already exists at `~/Projects/ha/go/ha-ops` (265 lines). Claude Code calls it via Bash:

```bash
~/Projects/ha/go/ha-ops states               # list all states or one entity
~/Projects/ha/go/ha-ops services             # list available services
~/Projects/ha/go/ha-ops check-config         # validate HA config
~/Projects/ha/go/ha-ops restart              # restart HA
~/Projects/ha/go/ha-ops reload               # reload_all
~/Projects/ha/go/ha-ops deploy <file>        # write file to HA VM + reload
~/Projects/ha/go/ha-ops deploy-restart <file># write file + full HA restart (template)
~/Projects/ha/go/ha-ops logs [count]         # fetch recent error logs via WebSocket
~/Projects/ha/go/ha-ops entities [domain]    # list entities by domain
~/Projects/ha/go/ha-ops snapshot             # export config to scratch dir
```

Claude Code calls this from its Bash tool instead of crafting curl/SSH commands inline. The script handles auth token fetching, REST calls, and SSH operations transparently.

### 5.4 Palace integration

Since Qwen36-coder runs on familiar, palace-daemon (also on familiar) is locally accessible. Claude Code can:

1. **Write session data to palace** after HA config changes (wing=familiar-realm-watch, room=decisions)
2. **Query palace** for prior HA-related decisions before making changes
3. **Use mempalace CLI** via `mempalace search "HA <topic>"` for historical context

## 6. Use Cases (Ranked)

### High value, low risk (start here)
1. **Package review** — read packages, suggest improvements, fix syntax
2. **New package generation** — describe what you want, Claude Code writes YAML
3. **Entity discovery** — query HA state space, understand entity landscape
4. **Template debugging** — analyze broken template sensors, suggest fixes

### Medium value, medium risk
5. **Config change generation** — write packages, deploy, validate
6. **Automation design** — propose automations based on current setup
7. **Dashboard analysis** — read dashboard JSON, suggest layout changes

### Lower value, higher risk
8. **Live mutations** — direct service calls, entity registry changes (needs confirmation)
9. **System-level changes** — Mosquitto config, network changes (too risky)

## 7. Risk Mitigations

### 7.1 Dry-run contract

Before deploying any config change:
```
1. Show the diff of what will change
2. Run check_config in dry-run (simulate config load)
3. Ask JP to confirm before deploying
```

### 7.2 Snapshot-first policy

For significant config changes:
```
1. Export current config: ssh "tar czf /tmp/backup-$(date +%Y%m%d).tar.gz /homeassistant/packages/<dir>"
2. Download: ssh "cat /tmp/backup-*.tar.gz" > ~/Projects/ha/scratch/backup-*.tar.gz
3. Then make changes
```

### 7.3 Rollback procedure

If check_config fails after deploy:
```bash
# Restore from local copy
cat ~/Projects/ha/packages/<file>.yaml \
  | ssh jp@10.0.6.108 "sudo tee /homeassistant/packages/<file>.yaml > /dev/null"
# Or from snapshot
ssh jp@10.0.6.108 "cd /homeassistant && tar xzf /tmp/backup-20260725.tar.gz packages/<dir>/ <dir>/"
curl -X POST https://ha.jphe.in:8123/api/services/homeassistant/restart
```

## 8. Performance Budget

| Operation | Expected latency | Notes |
|-----------|-----------------|-------|
| Short prompt (<5K tokens) | ~1-3s first token, ~40 tok/s | Prefill ~960 tok/s |
| Medium prompt (30-50K) | ~10-30s first token | KV cache warming |
| Long prompt (80-100K) | ~5-8 min first token | Deep context wall |
| Auto-compact trigger | fires at ~110K tokens | Compaction must fit in 131K |
| HA API call (states) | ~200-500ms | 3,351 entities = large JSON |
| HA API call (single) | ~50-100ms | |
| SSH config read | ~300-800ms | Network RTT + serial |
| File deploy + restart | ~30-60s | HA restart time |
| ESPHome compile | ~10-15s | Local, not on HA VM |

## 9. Future: Wave 2

### 9.1 Dedicated HA MCP server

If Qwen36-coder's tool grammar can be made stable with MCP loaded (currently broken — GBNF fails with >50 tools), a dedicated HA MCP server could provide:
- `ha_read_state(entity_id)` — get entity state
- `ha_call_service(domain, service, data)` — call service
- `ha_list_services()` — enumerate services
- `ha_check_config()` — validate config

### 9.2 Inference optimization

- **Batched reads** — fetch entity groups instead of individual reads
- **Context caching** — cache full entity state snapshot across turns
- **Model quantization swap** — try Q4_K_M (slower but more accurate for YAML) if Q3_K produces bad YAML

### 9.3 Local HA testing

- **Docker HA instance** on katana for safe testing of complex changes
- **esphome** already compiles locally — extend to `ha config check` locally

## 10. Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-07-25 | Use existing Qwen36-coder lane, no new model | P102 has no room for a second model; Qwen36 is sufficient |
| 2026-07-25 | No MCP for HA — use Bash scripts | GBNF parsing fails with MCP tool schemas loaded; Bash wrappers are simpler |
| 2026-07-25 | SHA-256 verify GGUFs before first boot | Already documented for Qwen36-coder; applies to any model swap |
