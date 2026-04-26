#!/bin/bash
# One-shot Ollama install on familiar: binary, user, two systemd units, model pulls.
# Run LOCALLY on familiar (or via ssh + bash -s).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

echo ">>> Installing Ollama binary (official script)..."
curl -fsSL https://ollama.com/install.sh | sh

echo ">>> Stopping ollama default systemd unit (we replace it with two pinned units)..."
sudo systemctl stop ollama 2>/dev/null || true
sudo systemctl disable ollama 2>/dev/null || true
sudo rm -f /etc/systemd/system/ollama.service

echo ">>> Installing ollama-chat.service and ollama-embed.service..."
sudo install -m 644 "${REPO_ROOT}/ops/systemd/ollama-chat.service" /etc/systemd/system/
sudo install -m 644 "${REPO_ROOT}/ops/systemd/ollama-embed.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo mkdir -p /var/cache/ollama
sudo chown ollama:ollama /var/cache/ollama

echo ">>> Enabling + starting ollama-chat + ollama-embed..."
sudo systemctl enable --now ollama-chat.service
sudo systemctl enable --now ollama-embed.service

sleep 3

echo ">>> Checking Ollama chat on :11434..."
curl -s http://127.0.0.1:11434/api/tags || { echo "FAIL: ollama-chat not responding"; exit 1; }
echo ""
echo ">>> Checking Ollama embed on :11435..."
curl -s http://127.0.0.1:11435/api/tags || { echo "FAIL: ollama-embed not responding"; exit 1; }

echo ""
echo ">>> Ollama installed. Pulling models (this may take several minutes)..."
OLLAMA_HOST=127.0.0.1:11434 ollama pull qwen2.5:3b-instruct-q4_K_M
OLLAMA_HOST=127.0.0.1:11435 ollama pull nomic-embed-text:v1.5

echo ""
echo ">>> GPU check:"
nvidia-smi --query-gpu=name,memory.total,memory.used --format=csv
