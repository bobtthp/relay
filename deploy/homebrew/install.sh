#!/bin/sh
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
FORMULA_NAME=relay/local/relay
LEGACY_PLIST="$HOME/Library/LaunchAgents/dev.relay.agent.plist"

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is required. Install it from https://brew.sh/" >&2
  exit 1
fi

NODE22_PREFIX=$(brew --prefix node@22 2>/dev/null || true)
if [ ! -x "$NODE22_PREFIX/bin/node" ]; then
  brew install node@22
  NODE22_PREFIX=$(brew --prefix node@22)
fi
PATH="$NODE22_PREFIX/bin:$PATH"
export PATH

if [ -f "$LEGACY_PLIST" ]; then
  echo "The legacy Relay LaunchAgent is installed. Stop and remove it first with:" >&2
  echo "  sh \"$PROJECT_DIR/deploy/launchd/uninstall.sh\"" >&2
  exit 1
fi

PACKAGE_VERSION=$(node -p "require('$PROJECT_DIR/package.json').version")
BREW_REPOSITORY=$(brew --repository)
TAP_DIR="$BREW_REPOSITORY/Library/Taps/relay/homebrew-local"
FORMULA_DIR="$TAP_DIR/Formula"
FORMULA_PATH="$FORMULA_DIR/relay.rb"
TEMPLATE="$PROJECT_DIR/deploy/homebrew/relay.rb.template"
CACHE_DIR="$HOME/Library/Caches/Relay/Homebrew"

if [ ! -d "$TAP_DIR" ]; then
  DEVELOPER_STATE=$(brew developer 2>&1 || true)
  brew tap-new --no-git relay/local
  case "$DEVELOPER_STATE" in
    *disabled*) brew developer off >/dev/null ;;
  esac
fi

if [ -f "$FORMULA_PATH" ] && ! grep -q '^# Generated locally by Relay' "$FORMULA_PATH"; then
  echo "A different relay formula already exists in $TAP_DIR; refusing to overwrite it." >&2
  exit 1
fi

REVISION=0
if [ -f "$FORMULA_PATH" ]; then
  PREVIOUS_VERSION=$(sed -n 's/^  version "\([^"]*\)"/\1/p' "$FORMULA_PATH" | head -n 1)
  PREVIOUS_REVISION=$(sed -n 's/^  revision \([0-9][0-9]*\)$/\1/p' "$FORMULA_PATH" | head -n 1)
  if [ "$PREVIOUS_VERSION" = "$PACKAGE_VERSION" ]; then
    REVISION=${PREVIOUS_REVISION:-0}
    REVISION=$((REVISION + 1))
  fi
fi

BUILD_DIR=$(mktemp -d "${TMPDIR:-/tmp}/relay-homebrew.XXXXXX")
trap 'rm -rf "$BUILD_DIR"' EXIT HUP INT TERM
SOURCE_DIR="$BUILD_DIR/source"
mkdir -p "$SOURCE_DIR" "$CACHE_DIR" "$FORMULA_DIR"
cp "$PROJECT_DIR/package.json" "$PROJECT_DIR/package-lock.json" "$PROJECT_DIR/tsconfig.json" "$SOURCE_DIR/"
cp -R "$PROJECT_DIR/apps" "$PROJECT_DIR/packages" "$SOURCE_DIR/"

ARCHIVE="$CACHE_DIR/relay-$PACKAGE_VERSION-$REVISION.tar.gz"
tar -czf "$ARCHIVE" -C "$SOURCE_DIR" .
SHA256=$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')
SOURCE_URL=$(node -e 'process.stdout.write(require("node:url").pathToFileURL(process.argv[1]).href)' "$ARCHIVE")

node -e '
const fs = require("node:fs");
const [templatePath, formulaPath, version, revision, sourceUrl, sha256] = process.argv.slice(1);
let formula = fs.readFileSync(templatePath, "utf8");
formula = formula.replaceAll("@@VERSION@@", version)
  .replace("@@REVISION@@", revision === "0" ? "" : `  revision ${revision}`)
  .replaceAll("@@SOURCE_URL@@", JSON.stringify(sourceUrl))
  .replaceAll("@@SHA256@@", sha256);
fs.writeFileSync(formulaPath, formula, { mode: 0o644 });
' "$TEMPLATE" "$FORMULA_PATH" "$PACKAGE_VERSION" "$REVISION" "$SOURCE_URL" "$SHA256"

if brew list --versions "$FORMULA_NAME" >/dev/null 2>&1; then
  brew services stop "$FORMULA_NAME" >/dev/null 2>&1 || true
  brew reinstall --build-from-source "$FORMULA_NAME"
  brew services start "$FORMULA_NAME"
else
  brew install --build-from-source "$FORMULA_NAME"
  brew services start "$FORMULA_NAME"
fi

printf 'Relay installed and managed by Homebrew. Open http://127.0.0.1:3000\n'
printf 'Manage it with: brew services stop relay/local/relay | restart | list\n'
printf 'Logs: %s/var/log/relay.log and relay-error.log\n' "$BREW_REPOSITORY"
