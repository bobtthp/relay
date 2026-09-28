#!/bin/sh
set -eu

USER_ID=$(id -u)
LABEL=dev.relay.agent
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ -f "$PLIST" ]; then
  launchctl bootout "gui/$USER_ID" "$PLIST" 2>/dev/null || true
  rm "$PLIST"
  printf 'Relay Agent LaunchAgent removed. Logs were kept under ~/Library/Logs/Relay.\n'
else
  printf 'Relay Agent LaunchAgent is not installed.\n'
fi
