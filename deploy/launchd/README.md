# Private macOS deployment

For Homebrew-managed installation and service commands, see
[`deploy/homebrew/README.md`](../homebrew/README.md). Use only one deployment
method at a time because both services use port 3000 and the same launchd label.

The LaunchAgent runs the built Relay Agent as the signed-in macOS user. The
Agent serves the built web UI and API from one origin and listens on port 3000
for devices on the local network. It creates an access token in
`~/.relay-web/auth-token`; the browser asks for this token before showing the
Relay UI.

From the repository root, install or update it with:

```sh
sh deploy/launchd/install.sh
```

The installer runs `npm run build`, writes
`~/Library/LaunchAgents/dev.relay.agent.plist`, and starts the service. Open
`http://127.0.0.1:3000` on the Mac or `http://<Mac-LAN-IP>:3000` from a device
on the same trusted network. Retrieve the token with
`cat ~/.relay-web/auth-token`. Logs are kept under `~/Library/Logs/Relay/`.

To remove the LaunchAgent:

```sh
sh deploy/launchd/uninstall.sh
```

This removes the generated plist and stops the service; it keeps the logs,
repository, task cache, and Codex session history.

## Private remote access

For private remote access, use a private-network HTTPS reverse proxy such as
Tailscale Serve, require the Relay access token, and restrict membership with
your tailnet ACLs. Never expose port 3000 to the public internet, configure
router port forwarding, or publish the Vite development server. Confirm the
resulting URL is tailnet-only before using it.

The local prototype does not yet implement Cloud accounts, device pairing,
per-user authorization, or an outbound Cloud tunnel. Tailscale access is the
private Stage 1 deployment path, not a substitute for those hosted controls.
