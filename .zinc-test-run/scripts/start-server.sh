#!/bin/bash
# Start the isolated test Minecraft 26.3 server (loopback only).
# Heap kept conservative: machine has 7.5GiB total; local model + OS get the rest.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/server"
exec "$ROOT/jdk25/bin/java" -Xms768m -Xmx1536m -XX:+UseG1GC -XX:MaxGCPauseMillis=50 \
  -jar mc-server-26.3.jar --nogui
