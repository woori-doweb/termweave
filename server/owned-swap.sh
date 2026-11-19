#!/bin/sh
# Started detached by owned-updater.ts. Stops the running owned install, puts the new build in
# its place, starts it, and restores the previous build if the new one does not answer.
# Usage: owned-swap.sh ROOT NEXT LAUNCHER_PID BUN PORT STAGE
set -u
root=$1 next=$2 launcher=$3 bun=$4 port=$5 stage=$6
prev="$root.prev"
log="$stage/swap.log"
exec >>"$log" 2>&1
say() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*"; }

answers() {
  i=0
  while [ $i -lt 40 ]; do
    curl -s -m 2 "http://127.0.0.1:$port/api/health?scope=bridge" | grep -q '"ok":true' && return 0
    i=$((i + 1)); sleep 1
  done
  return 1
}
start() { nohup "$bun" "$root/scripts/owned-server.ts" start >"$root/server.log" 2>&1 </dev/null & }
stop() {
  pid=$1
  kill -TERM "$pid" 2>/dev/null || return 0
  i=0
  while kill -0 "$pid" 2>/dev/null && [ $i -lt 30 ]; do i=$((i + 1)); sleep 1; done
  ! kill -0 "$pid" 2>/dev/null
}

say "stopping launcher $launcher"
stop "$launcher" || { say "FAIL: launcher did not stop; nothing changed"; exit 1; }
rm -rf "$prev"
mv "$root" "$prev" && mv "$next" "$root" || { say "FAIL: swap"; [ -d "$prev" ] && [ ! -d "$root" ] && mv "$prev" "$root"; start; exit 1; }
start
if answers; then
  say "PASS: new build answers on $port"
  rm -rf "$stage/src"
  exit 0
fi
say "FAIL: new build did not answer; restoring the previous build"
[ -f "$root/lifecycle.json" ] && stop "$(sed -n 's/.*"launcher":\([0-9]*\).*/\1/p' "$root/lifecycle.json")"
rm -rf "$root.failed"; mv "$root" "$root.failed" && mv "$prev" "$root"
rm -f "$root/lifecycle.json" "$root/.lifecycle.lock"
start
answers && say "restored previous build" || say "FAIL: previous build did not answer either"
exit 1
