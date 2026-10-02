# Homebrew install and service management

This local development installer creates a Homebrew formula from the current
checkout and builds the UI and Agent on this Mac. It installs Node.js 22 and
registers the service through `brew services`. This source build requires
compatible Command Line Tools. End users should use the published release
formula; the release workflow will provide precompiled bottles for supported
Macs.

From the repository root, install or update Relay with:

```sh
sh deploy/homebrew/install.sh
```

Open `http://127.0.0.1:3000` after installation. The Agent listens on loopback
only. Codex CLI must be installed and logged in separately.

## Troubleshooting

If this local source installer stops with “Your Command Line Tools are too
outdated,” install the update offered in System Settings → General → Software
Update, then rerun it. If Software Update has no matching update, download the
Command Line Tools version named in the error from
[Apple Developer Downloads](https://developer.apple.com/download/all/). The
release formula will avoid this local build for supported Macs by installing a
precompiled bottle once the updated release workflow is used.

Manage the service with Homebrew:

```sh
brew services list
brew services stop relay/local/relay
brew services start relay/local/relay
brew services restart relay/local/relay
```

The install script rebuilds from this checkout, updates the local formula, and
restarts the service. It stops the previous Homebrew service during an update.
Do not start the old LaunchAgent and Homebrew service at the same time: both
use port 3000 and the `dev.relay.agent` launchd label.

To migrate from the older LaunchAgent installation, stop and remove that
service before installing the Homebrew formula:

```sh
sh deploy/launchd/uninstall.sh
sh deploy/homebrew/install.sh
```

To uninstall Relay:

```sh
sh deploy/homebrew/uninstall.sh
```

Uninstalling keeps the project list and task cache in `~/.relay-web`, and keeps
Homebrew's logs and local tap. Logs are under `$(brew --prefix)/var/relay/log/`.

If the Codex CLI is not available on Homebrew's service `PATH`, set `CODEX_BIN`
or add its directory to `PATH` in `~/.homebrew/services/relay.env`, then restart
the service. For example:

```text
CODEX_BIN=/path/to/codex
PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
```

This local tap is generated from the checkout on this Mac. For the published
formula, see [GitHub releases and Homebrew formula](RELEASING.md). The source
repository itself hosts the public tap formula; a separate tap repository is
not required.
