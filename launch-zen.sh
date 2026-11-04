#!/bin/sh
# Launch a dedicated Zen profile with RDP. Never close or reuse a running profile.
set -eu

PROFILE=${ZEN_RDP_PROFILE:-}
PORT=${ZEN_RDP_PORT:-6000}
BINARY=${ZEN_BINARY:-/Applications/Zen.app/Contents/MacOS/zen}

if [ -z "$PROFILE" ] || [ ! -d "$PROFILE" ]; then
  echo 'Set ZEN_RDP_PROFILE to the existing, explicitly authorized Zen profile directory.' >&2
  exit 2
fi
case "$PORT" in *[!0-9]*|'') echo 'ZEN_RDP_PORT must be an integer.' >&2; exit 2;; esac
if { [ -e "$PROFILE/lock" ] && lsof -n "$PROFILE/lock" >/dev/null 2>&1; } || { [ -e "$PROFILE/.parentlock" ] && lsof -n "$PROFILE/.parentlock" >/dev/null 2>&1; }; then
  echo "Profile appears active or locked; refusing to launch: $PROFILE" >&2
  exit 3
fi
if ! command -v lsof >/dev/null 2>&1 || lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "RDP port $PORT is unavailable or cannot be checked; refusing to launch." >&2
  exit 3
fi
if [ ! -x "$BINARY" ]; then echo "Zen executable not found: $BINARY" >&2; exit 2; fi

exec "$BINARY" --no-remote --profile "$PROFILE" --start-debugger-server "$PORT" about:blank
