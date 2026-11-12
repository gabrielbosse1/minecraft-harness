#!/bin/bash
# Start the REAL ZincAI bot against the isolated loopback server,
# capturing stdout/stderr to logs/bot.log (timestamped append per run).
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUN="$ROOT/.zinc-test-run"
cd "$ROOT"
export MC_HOST=127.0.0.1
export MC_PORT=25570
export MC_AUTH=offline
export MC_VERSION=""
export AMD_MODEL=Qwen3.8-27B
export ZINC_DATA_DIR="$RUN/zincai-data"
export LOG_LEVEL=info
exec node zincai/index.js 2>&1 | tee -a "$RUN/logs/bot.log"
