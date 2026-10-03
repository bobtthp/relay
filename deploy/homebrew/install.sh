#!/bin/sh
set -eu

# Build with the installed Node runtime, then sync the artifacts into the
# Homebrew keg. Homebrew does not compile Relay, so current Xcode CLT versions
# are not required for normal updates.
PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
LOCAL_FORMULA_NAME=relay/local/relay
PUBLIC_FORMULA_NAME=bobtthp/relay/relay
LEGACY_PLIST="$HOME/Library/LaunchAgents/dev.relay.agent.plist"

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is required. Install it from https://brew.sh/" >&2
  exit 1
fi

NODE22_PREFIX=$(brew --prefix node@22 2>/dev/null || true)
if [ ! -x "$NODE22_PREFIX/bin/node" ]; then
  brew install --force-bottle node@22
  NODE22_PREFIX=$(brew --prefix node@22)
fi
PATH="$NODE22_PREFIX/bin:$PATH"
export PATH

if brew list --versions "$LOCAL_FORMULA_NAME" >/dev/null 2>&1; then
  FORMULA_NAME=$LOCAL_FORMULA_NAME
elif brew list --versions "$PUBLIC_FORMULA_NAME" >/dev/null 2>&1; then
  FORMULA_NAME=$PUBLIC_FORMULA_NAME
else
  brew tap bobtthp/relay https://github.com/bobtthp/relay.git
  brew install --force-bottle "$PUBLIC_FORMULA_NAME"
  FORMULA_NAME=$PUBLIC_FORMULA_NAME
fi

PREFIX=$(brew --prefix "$FORMULA_NAME")
LIBEXEC="$PREFIX/libexec"

if [ -f "$LEGACY_PLIST" ]; then
  PLIST_SERVER=$(plutil -extract ProgramArguments.1 raw -o - "$LEGACY_PLIST" 2>/dev/null || true)
  case "$PLIST_SERVER" in
    "$LIBEXEC"/dist-server/packages/agent/src/server.js) ;;
    *)
      echo "A separate LaunchAgent is using the Relay service label. Stop and remove it first with:" >&2
      echo "  sh \"$PROJECT_DIR/deploy/launchd/uninstall.sh\"" >&2
      exit 1
      ;;
  esac
fi

cd "$PROJECT_DIR"
npm ci --no-audit --fund=false
npm run build

if [ ! -f dist-server/packages/agent/src/server.js ] || [ ! -f dist/web/index.html ]; then
  echo "Relay build output is incomplete; the installed service was not changed." >&2
  exit 1
fi

ACTIVE_TASK_COUNT=$(node -e '
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[1];
let count = 0;
try {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const state = JSON.parse(fs.readFileSync(path.join(root, entry.name, "state.json"), "utf8"));
      count += (state.tasks ?? []).filter(task => task.status === "running" || task.status === "waiting_for_approval").length;
    } catch { /* Ignore missing or incomplete project caches. */ }
  }
} catch { /* No Relay cache exists yet. */ }
process.stdout.write(String(count));
' "$HOME/.relay-web/projects")
if [ "$ACTIVE_TASK_COUNT" -gt 0 ]; then
  echo "Relay has $ACTIVE_TASK_COUNT active task(s). Interrupt or finish them before updating; no service files were changed." >&2
  exit 1
fi

brew services stop "$FORMULA_NAME" >/dev/null 2>&1 || true
mkdir -p "$LIBEXEC/dist-server" "$LIBEXEC/dist/web" "$LIBEXEC/node_modules"
cp -R "$PROJECT_DIR/dist-server/." "$LIBEXEC/dist-server/"
cp -R "$PROJECT_DIR/dist/web/." "$LIBEXEC/dist/web/"
cp -R "$PROJECT_DIR/node_modules/." "$LIBEXEC/node_modules/"
brew services start "$FORMULA_NAME"

printf 'Relay updated from this checkout and started with Homebrew. On this Mac: http://127.0.0.1:3000\n'
printf 'On the local network, open http://<Mac-LAN-IP>:3000 and enter the token from: cat ~/.relay-web/auth-token\n'
printf 'Use only on a trusted local network. Do not expose port 3000 to the public internet or forward it on your router.\n'
printf 'Manage it with: brew services stop %s | restart | list\n' "$FORMULA_NAME"
printf 'Logs: %s/var/log/relay.log and relay-error.log\n' "$(brew --repository)"
