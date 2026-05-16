#!/usr/bin/env bash
# Install llama.cpp on katana with CUDA support.
# Run LOCALLY on katana (or via ssh). Idempotent — re-runs are safe.
#
# Prereqs:
#   - NVIDIA driver installed (libcuda.so present from the driver package)
#   - sudo (for nvidia-cuda-toolkit installation if not already present)
#   - cmake, git, build-essential
#
# Output:
#   ~/.local/share/llama.cpp/build/bin/llama-server   (the binary)
#
# Pair with ops/katana/llama-server.service for systemd-user persistence.

set -euo pipefail

LLAMA_DIR="$HOME/.local/share/llama.cpp"
# RTX 2080 Ti = compute capability 7.5. Targeting one arch keeps the build fast.
# If you ever swap GPUs, update CMAKE_CUDA_ARCHITECTURES (or use 'native').
CUDA_ARCH="${CUDA_ARCH:-75}"

echo "==> Ensuring nvidia-cuda-toolkit (nvcc) is installed..."
if ! command -v nvcc >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo apt-get install -y nvidia-cuda-toolkit
fi
nvcc --version | tail -1

echo "==> Cloning/updating llama.cpp into $LLAMA_DIR..."
mkdir -p "$LLAMA_DIR"
if [ ! -d "$LLAMA_DIR/.git" ]; then
  git clone --depth 1 https://github.com/ggml-org/llama.cpp.git "$LLAMA_DIR"
else
  git -C "$LLAMA_DIR" pull --ff-only
fi

echo "==> Configuring CUDA build (arch=$CUDA_ARCH)..."
cmake -B "$LLAMA_DIR/build" -S "$LLAMA_DIR" \
  -DGGML_CUDA=on \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CUDA_ARCHITECTURES="$CUDA_ARCH"

echo "==> Building llama-server (target-scoped)..."
cmake --build "$LLAMA_DIR/build" --config Release --target llama-server -j "$(nproc)"

echo
echo "==> Done. Binary at: $LLAMA_DIR/build/bin/llama-server"
"$LLAMA_DIR/build/bin/llama-server" --version 2>&1 | head -3 || true
echo
echo "Next (system unit only — user units are not supported across this homelab; see palace-daemon CLAUDE.md):"
echo "  1. Drop a Qwen2.5-7B GGUF into ~/.local/share/models/"
echo "  2. sudo cp ops/katana/llama-server.service /etc/systemd/system/"
echo "     (edit User=, Group=, and ExecStart paths to match your install)"
echo "  3. sudo systemctl daemon-reload && sudo systemctl enable --now llama-server"
echo "  4. curl http://127.0.0.1:11436/health"
