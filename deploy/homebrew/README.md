# Homebrew install and service management

This local development installer builds the UI and Agent from the current
checkout with Node.js 22, then copies the built files into the installed
Homebrew Relay keg. Homebrew manages the service and Node runtime; it does not
compile Relay, so updating Relay does not depend on the local Command Line
Tools version. If Relay is not installed yet, the script installs the
published bottle first. End users should use the published release formula.

From the repository root, install or update Relay with:

```sh
sh deploy/homebrew/install.sh
```

Open `http://127.0.0.1:3000` on the Mac or `http://<Mac-LAN-IP>:3000` from a
device on the same trusted network. The service requires the token stored at
`~/.relay-web/auth-token`; retrieve it with `cat ~/.relay-web/auth-token`.
Never expose port 3000 to the public internet or forward it on your router.
Codex CLI must be installed and logged in separately.

## Troubleshooting

The installer builds Relay in the checkout before stopping the service. If the
build fails, the installed service is left untouched. It also checks the Relay
task cache and stops before updating if any task is running or awaiting
approval; finish or interrupt those tasks, then rerun the installer.

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
