#!/bin/sh
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
NODE_BIN=$(command -v node)
USER_ID=$(id -u)
LABEL=dev.relay.agent
AGENTS_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/Relay"
PLIST="$AGENTS_DIR/$LABEL.plist"

cd "$PROJECT_DIR"
npm run build
TOKEN_DIR="$HOME/.relay-web"
TOKEN_FILE="$TOKEN_DIR/auth-token"
mkdir -p "$TOKEN_DIR"
chmod 700 "$TOKEN_DIR"
if [ ! -s "$TOKEN_FILE" ]; then
  node -e 'const fs = require("node:fs"); const crypto = require("node:crypto"); try { fs.writeFileSync(process.argv[1], crypto.randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 }); } catch (error) { if (error.code !== "EEXIST") throw error; }' "$TOKEN_FILE"
fi
chmod 600 "$TOKEN_FILE"
mkdir -p "$AGENTS_DIR" "$LOG_DIR"

node -e '
const fs = require("node:fs");
const [plistPath, projectDir, nodeBin, logDir] = process.argv.slice(1);
const xml = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const string = value => `<string>${xml(value)}</string>`;
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key>${string("dev.relay.agent")}
<key>ProgramArguments</key><array>${string(nodeBin)}${string("dist-server/packages/agent/src/server.js")}</array>
<key>WorkingDirectory</key>${string(projectDir)}
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>EnvironmentVariables</key><dict><key>PORT</key>${string("3000")}<key>RELAY_HOST</key>${string("0.0.0.0")}</dict>
<key>StandardOutPath</key>${string(`${logDir}/agent.log`)}
<key>StandardErrorPath</key>${string(`${logDir}/agent-error.log`)}
</dict></plist>
`;
fs.writeFileSync(plistPath, plist, { mode: 0o600 });
' "$PLIST" "$PROJECT_DIR" "$NODE_BIN" "$LOG_DIR"

launchctl bootout "gui/$USER_ID" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$USER_ID" "$PLIST"
launchctl kickstart -k "gui/$USER_ID/$LABEL"
printf 'Relay Agent installed and started. On this Mac: http://127.0.0.1:3000\n'
printf 'On the local network, open http://<Mac-LAN-IP>:3000 and enter the token from: cat ~/.relay-web/auth-token\n'
printf '\n>>> RELAY ACCESS TOKEN — KEEP PRIVATE <<<\n'
if [ -t 1 ]; then
  printf '\033[1;97;41m  '
  cat "$TOKEN_FILE"
  printf '  \033[0m\n'
else
  printf '  '
  cat "$TOKEN_FILE"
  printf '\n'
fi
printf '\n'
printf 'Use only on a trusted local network. Do not expose port 3000 to the public internet or forward it on your router.\n'
printf 'LaunchAgent logs: %s\n' "$LOG_DIR"
