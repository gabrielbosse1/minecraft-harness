#!/bin/bash
# Start the isolated 26.1 test server (loopback only). Conservative heap.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/server-26.1"
exec "$ROOT/jdk25/bin/java" -Xms768m -Xmx1536m -XX:+UseG1GC -XX:MaxGCPauseMillis=50 \
  -jar server.jar --nogui
