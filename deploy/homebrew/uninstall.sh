#!/bin/sh
set -eu

FORMULA_NAME=relay/local/relay

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is not installed. Nothing to remove."
  exit 0
fi

if brew list --versions "$FORMULA_NAME" >/dev/null 2>&1; then
  brew services stop "$FORMULA_NAME" >/dev/null 2>&1 || true
  brew uninstall "$FORMULA_NAME"
else
  echo "Relay is not installed as a Homebrew formula."
fi

echo "Relay's project list and task cache were kept in ~/.relay-web."
echo "Homebrew logs and the local tap were also kept."
