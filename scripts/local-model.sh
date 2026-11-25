#!/usr/bin/env bash
# 本地小模型：llama.cpp + GGUF，暴露 OpenAI 兼容接口（默认 127.0.0.1:8090）
# 用法：./scripts/local-model.sh [模型.gguf]
set -euo pipefail
MODEL="${1:-$HOME/models/qwen3b/qwen2.5-3b-instruct-q4_k_m.gguf}"
LLAMA_DIR="${LLAMA_DIR:-$HOME/opt/llama/llama-b12674}"
LIBS="${LIBS:-$HOME/opt/llama/libs}"
PORT="${PORT:-8090}"
CTX="${CTX:-8192}"
THREADS="${THREADS:-22}"
[ -f "$MODEL" ] || { echo "缺少模型文件：$MODEL"; exit 1; }
[ -x "$LLAMA_DIR/llama-server" ] || { echo "缺少 llama-server：$LLAMA_DIR"; exit 1; }
echo "model: $MODEL"
echo "endpoint: http://127.0.0.1:$PORT/v1  (OpenAI 兼容)"
LD_LIBRARY_PATH="$LIBS" exec "$LLAMA_DIR/llama-server" -m "$MODEL" -c "$CTX" -t "$THREADS" -ngl 0 --host 127.0.0.1 --port "$PORT"
