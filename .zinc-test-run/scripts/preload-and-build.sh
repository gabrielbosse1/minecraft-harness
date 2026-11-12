#!/bin/bash
# Preload far regions (poll until chunks generate), then build the areas.
# Runs the long part of the campaign setup; bot stays connected meanwhile.
cd "$(dirname "$0")/.."   # campaign root (.zinc-test-run)
echo "[preload] B region"
node scripts/preload_chunks.js 40 -20 140 60
WORLD_FLOOR=105 node scripts/build_world.js B 2>&1 | tee logs/build-world-261-B.log | grep -E "batch done|BUILD"
echo "[preload] F region"
node scripts/preload_chunks.js 150 -20 220 40
WORLD_FLOOR=105 node scripts/build_world.js F 2>&1 | tee logs/build-world-261-F.log | grep -E "batch done|BUILD"
echo "PRELOAD_BDF_DONE"
