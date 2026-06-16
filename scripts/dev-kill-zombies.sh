#!/usr/bin/env bash
# scripts/dev-kill-zombies.sh
# =============================================================================
# Kill ZOMBIE Next.js / tsx / turbo dev processes that squat on ports 3000-3010
# without killing the actively-running dev services.
#
# The SuiPredict web app uses port 3000 (Next.js) and 3001 (agents service).
# Other open ports in 3000-3010 are usually zombies from prior dev sessions
# that never got cleaned up — they're a demo-killer because the new
# `pnpm dev:web` will see the port busy, fall back to 3004, and every
# Playwright test pointing at localhost:3000 will hit a 500.
#
# This script is conservative: it only kills processes on ports that are
# 1) not the canonical dev port (3000), and
# 2) not the agents service (3001).
# A live `pnpm dev:agents` on 3001 stays up; a stale `pnpm dev:web` zombie
# on 3002 (from a prior session that left it on the wrong port) gets killed.
#
# Usage:
#   ./scripts/dev-kill-zombies.sh
#   pnpm dev:web     # if no Next.js is on 3000
#   pnpm dev:agents  # if no agents service is on 3001
#
# This is the #1 thing that breaks a live demo. Run it before every demo
# or before re-running /uat.
# =============================================================================
set -euo pipefail

CANONICAL_WEB_PORT=3000
CANONICAL_AGENTS_PORT=3001
PROTECTED_PORTS="$CANONICAL_WEB_PORT $CANONICAL_AGENTS_PORT"

# Find all listening sockets in the dev port range. Track which are
# the canonical ports and which are zombies.
ALL_PIDS=$(lsof -nP -iTCP:3000-3010 -sTCP:LISTEN -t 2>/dev/null | sort -u || true)
if [ -z "$ALL_PIDS" ]; then
  echo "✓ No dev processes on ports 3000-3010"
  exit 0
fi

ZOMBIE_PIDS=()
for pid in $ALL_PIDS; do
  port=$(lsof -nP -iTCP:3000-3010 -sTCP:LISTEN 2>/dev/null | awk -v p="$pid" '$2==p { split($9, a, ":"); print a[length(a)]; exit }')
  if [ -z "$port" ]; then
    continue
  fi
  case " $PROTECTED_PORTS " in
    *" $port "*)
      echo "  Protected (kept alive): PID $pid on port $port"
      ;;
    *)
      cmd=$(ps -p "$pid" -o command= 2>/dev/null | head -c 120 || true)
      echo "  Zombie: PID $pid on port $port — $cmd"
      ZOMBIE_PIDS+=("$pid")
      ;;
  esac
done

if [ ${#ZOMBIE_PIDS[@]} -eq 0 ]; then
  echo "✓ All dev ports are canonical (3000/3001). No zombies to kill."
  exit 0
fi

# Kill zombies. SIGTERM first (lets Next.js / tsx write a clean shutdown),
# then SIGKILL anything still alive after 2s.
for pid in "${ZOMBIE_PIDS[@]}"; do
  kill -TERM "$pid" 2>/dev/null || true
done
sleep 2
for pid in "${ZOMBIE_PIDS[@]}"; do
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null || true
  fi
done

# Also kill orphan tsx watch / turbo dev wrappers that aren't bound to a
# port (they leak memory — in the UAT run one ramped to 9 GB RSS and 95%
# CPU after the parent next-server was killed).
# Only kill tsx/turbo processes that aren't holding 3000 or 3001.
for pid in $(pgrep -f "tsx watch|tsx.*loader.mjs|node.*preflight.cjs|turbo dev" 2>/dev/null); do
  holds_protected=$(lsof -nP -iTCP:3000,3001 -sTCP:LISTEN -t 2>/dev/null | grep -F "$pid" || true)
  if [ -n "$holds_protected" ]; then
    echo "  Protected (holds 3000/3001): PID $pid — $(ps -p "$pid" -o command= 2>/dev/null | head -c 80)"
    continue
  fi
  echo "  Killing orphan: PID $pid — $(ps -p "$pid" -o command= 2>/dev/null | head -c 80)"
  kill -9 "$pid" 2>/dev/null || true
done

# Verify clean
sleep 1
REMAINING=$(lsof -nP -iTCP:3002-3010 -sTCP:LISTEN -t 2>/dev/null | wc -l | tr -d ' ')
if [ "$REMAINING" -gt 0 ]; then
  echo "✗ Still $REMAINING process(es) on 3002-3010 after kill — manual cleanup needed"
  lsof -nP -iTCP:3002-3010 -sTCP:LISTEN
  exit 1
fi

# Clear stale .next cache so the next dev run doesn't reuse a corrupted
# React Client Manifest (the resolved-market page visit crashed this
# exact cache in the UAT run, locking every route to HTTP 500).
if [ -d "apps/web/.next/cache" ]; then
  rm -rf apps/web/.next/cache
  echo "✓ Cleared apps/web/.next/cache"
fi

echo "✓ Dev environment clean (zombies killed, canonical services preserved)"
