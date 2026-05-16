# Phi-4 14B on NVIDIA P102-100 (mining card) via llama.cpp

**Date**: 2026-05-15
**Host**: `familiar` (Ryzen 9 3900X, 32 GB RAM, Ubuntu 24.04, no display)
**GPU 0**: NVIDIA P102-100 (Pascal, sm_61, 10 GB GDDR5X, mining-vBIOS PCIe Gen 1 ×2)
**GPU 1**: NVIDIA GTX 970 (Maxwell, sm_52, 4 GB) — runs the embed model
**Driver**: nvidia 570.211.01
**Inference**: `llama-server` built from `ggml-org/llama.cpp` with `cmake -B build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES="52;61"`

## TL;DR

- **Phi-4 14B Q4_K_M on a $100-ish used P102 mining card hits 28 tok/s sustained.**
- Stock Ollama prebuilt binaries silently CPU-fallback on Pascal — they ship no sm_61 SASS despite PTX markers. **Skip Ollama for Pascal**; build llama.cpp directly.
- Among 4 candidate models, Phi-4 wins on **wall-clock per response** (median 6.4 s vs Qwen3.5-9B's 25–86 s) because it's the only non-thinking model in the set. Raw `tok/s` is misleading; what matters is `eval_tokens ÷ tok/s` since thinking models emit 1–4× more tokens into hidden `reasoning_content` before reaching the visible answer.

## Why this matters

P102-100 cards are surplus ETH-mining GPUs you can buy for ~$80–120 on eBay. 10 GB of GDDR5X and 3,200 CUDA cores at Pascal-era flop rates — totally adequate for 7B–14B parameter chat models if you can talk to them. The combination of (a) llama.cpp built with `sm_61`, (b) Q4_K_M quants of Phi-4 or similar, and (c) the mining-vBIOS PCIe Gen 1 ×2 limit gives you ~28 tok/s end-to-end interactive chat for the cost of a mid-range gaming peripheral.

## Setup

```bash
# Build llama.cpp with both Pascal and Maxwell SASS
sudo apt install nvidia-cuda-toolkit cmake build-essential
git clone --depth 1 https://github.com/ggml-org/llama.cpp /opt/llama.cpp
cd /opt/llama.cpp
cmake -B build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES="52;61" -DLLAMA_CURL=ON
cmake --build build --config Release -j 12 --target llama-server llama-cli llama-embedding

# Verify startup log shows the right arches
/opt/llama.cpp/build/bin/llama-server --version 2>&1 | grep ARCHS
# system_info: ... CUDA : ARCHS = 520, 610
```

GGUFs: `unsloth/<model>-GGUF` quants from HuggingFace are reliable. Q4_K_M is the sweet spot at 10 GB.

## Candidates benched

Four chat models, same 6-prompt suite (summarization / reasoning / code / casual-companion / technical-jargon / RAG-multi-doc), `max_tokens=3000` (raised from 800 to give thinking models enough budget — see methodology note below).

| Model | Q4_K_M size | VRAM | Avg tok/s | Median eval tokens | Wall-clock per response (median) |
|---|---|---|---|---|---|
| **Phi-4 14B** | 8.3 GB | 9.3 GB / 91% | **27.7** | **177** | **6.4 s** ← winner |
| Gemma 4 E4B-it | 4.7 GB | 3.8 GB / 37% | 49.5 | 539 | 10.9 s |
| Qwen 3.5-9B-Instruct | 5.3 GB | 6.0 GB / 58% | 41.6 | 2,518 | 67.3 s |
| DeepSeek-R1-Distill-Qwen-14B | 8.4 GB | 9.4 GB / 92% | 25.0 | 648 | 25.9 s |

The dominant cost is `eval_tokens`, not `tok/s`. Qwen3.5-9B's chain-of-thought averages 2.5 k tokens per visible answer; Phi-4's averages 177. Same hardware, same generation rate, ~10× the wall-clock for a thinking model.

## Methodology gotcha (and the fix)

Initial run used `max_tokens=400`. Qwen3.5-9B and DeepSeek-R1-Distill-Qwen-14B both hit `finish_reason=length` on the harder prompts because their `reasoning_content` chains routinely run 5–14 k characters before reaching the visible answer. **This made them look like they failed prompts they were actually mid-thinking on.**

Re-ran with `max_tokens=3000` (and Qwen3.5 at `ctx_size=8192 / max_tokens=6000` for the two prompts that still hit the cap). All four models then finished all six prompts cleanly. **For any bench against modern thinking models, give them ~3000–6000 max_tokens or you're measuring truncation, not quality.**

## Sustained stress test on the winner

15 iterations of the 6-prompt suite back-to-back on Phi-4 14B, with continuous telemetry (`nvidia-smi` every 10 s + dmesg tail for any Xid event).

**Duration**: 10 minutes, 90 inference cycles.

| Metric | Min | Max | Avg |
|---|---|---|---|
| GPU temp (°C) | 42 | **74** | 71.1 |
| Tok/s | 27.3 | 28.3 | 27.6 |
| Power (W) | 79 | **94** | 87 |

Peak draw during inference (sampled mid-prompt rather than between prompts) was **246 W** — right at the 250 W TDP. **Zero NVRM Xid events** across the 10-min soak. Tok/s flat 27.3–28.3 (zero thermal throttling — Pascal throttles at ~85 °C, we stayed under by 11 °C). GPU core clock 1847 MHz at start → 1733 MHz at end (a 6% sag, consistent with normal NVIDIA Boost adjusting, not throttle).

## PCIe link state (mining-vBIOS quirk)

`lspci -vv` on the P102 reports `LnkCap: Speed 2.5GT/s, Width ×4` — the card's vBIOS caps PCIe at Gen 1 ×4 (some slots negotiate down to ×2). This costs ~10 s on cold model load (9 GB / ~1 GB/s) but has zero effect on inference itself, which is compute-bound after the model is resident.

vBIOS reflash to unlock Gen 3 ×4 exists (cross-flash from GTX 1080 Ti). Skipped here — the brick risk dominates the marginal cold-load saving when keep-alive holds the model in VRAM.

## Why Ollama doesn't work

Stock Ollama 0.23.2 prebuilt binaries silently CPU-fallback on Pascal: the model loads, inference returns clean output, `nvidia-smi` shows 0 MiB VRAM used. The CUDA backend loads cleanly; device enumeration returns zero because the compiled SASS omits `sm_61`. **`sm_61` does appear in `strings libggml-cuda.so`, but only as PTX markers — there's no compiled SASS to actually run on Pascal.**

`OLLAMA_DEBUG=1` smoking-gun line: `inference compute id=cpu library=cpu` is the only entry, and `nvidia-smi --loop=1` confirms 0% utilization during generation. Side-bug along the way: `/usr/local/lib/ollama/cuda_v12/libcublasLt.so.12.8.5.5` ships mode `0700` (root-only), which prevents the `ollama` user from dlopening the CUDA backend at all. `chmod a+r` unblocks discovery but doesn't fix the bigger SASS gap.

Related upstream: ollama/ollama#8653, #12316, #14258. NixOS / Arch `ollama-cuda` packages build with `CUDA_ARCHITECTURES=75;80;86;89;90;100;120` only — Pascal is officially "supported" per docs but practically excluded from prebuilt binaries.

## Familiar's deployment shape

Behind a Caddy + Authelia front on `ubox0`, `familiar.jphe.in` runs:

- **`ollama-chat.service`** (legacy unit name kept for backwards-compat) → `/opt/llama.cpp/build/bin/llama-server` with `--model phi-4-Q4_K_M.gguf`, `--ctx-size 4096`, `CUDA_VISIBLE_DEVICES=0`, port 11434
- **`ollama-embed.service`** → `llama-server` with `--model nomic-embed-text-v1.5.gguf`, `--ctx-size 2048 --embeddings --pooling mean`, `CUDA_VISIBLE_DEVICES=1`, port 11435
- **`familiar-api`** (`src/ollama-client.ts`) speaks OpenAI-compatible `/v1/*` — same client class works against both `llama-server` and stock Ollama (which mounts `/v1/*` as a compat shim on the same port)

## Reproducibility

All eval and stress harness lives at `familiar:/home/jp/gpu-monitor/eval-suite/` (intended to move into this repo's `ops/` dir as a follow-up). Telemetry CSVs and per-prompt response JSON are preserved at `familiar:/home/jp/gpu-monitor/stress-phi-4-14b-*/` for any future re-measurement.

## What we'd want next

- **Multi-encoder benchmark on this same hardware** — the mempalace RRF research probe (`techempower-org/mempalace#85`) measured raw-vector vs hybrid pipeline on a different setup. Re-running on familiar with the production palace data would close the loop on whether RRF survives end-to-end on real-traffic queries.
- **Phi-4 14B at Q5_K_M** — would push VRAM to ~10.5 GB (over the 10 GB headroom). Could test with `--ctx-size 2048` to claw back 0.5 GB.
- **Power-capped run** — `nvidia-smi -pl 180` should lose <10% tok/s and drop ~30°C of thermal pressure. Worth measuring on a long-running 24-hour soak.
