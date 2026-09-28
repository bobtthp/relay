# Private macOS deployment

For Homebrew-managed installation and service commands, see
[`deploy/homebrew/README.md`](../homebrew/README.md). Use only one deployment
method at a time because both services use port 3000 and the same launchd label.

The LaunchAgent runs the built Relay Agent as the signed-in macOS user. The
Agent serves the built web UI and API from one origin and binds to
`127.0.0.1:3000` by default. It does not expose a public listener or store
Codex credentials.

From the repository root, install or update it with:

```sh
sh deploy/launchd/install.sh
```

The installer runs `npm run build`, writes
`~/Library/LaunchAgents/dev.relay.agent.plist`, and starts the service. Open
`http://127.0.0.1:3000` on the Mac. Logs are kept under
`~/Library/Logs/Relay/`.

To remove the LaunchAgent:

```sh
sh deploy/launchd/uninstall.sh
```

This removes the generated plist and stops the service; it keeps the logs,
repository, task cache, and Codex session history.

## Private remote access

Keep the Agent bound to loopback. For access from another device, use a
private-network HTTPS reverse proxy such as Tailscale Serve, targeting
`http://127.0.0.1:3000`, and restrict membership with your tailnet ACLs. Do not
set `RELAY_HOST=0.0.0.0`, expose port 3000 on the router, or publish the Vite
development server. Confirm the resulting URL is tailnet-only before using it.

The local prototype does not yet implement Cloud accounts, device pairing,
per-user authorization, or an outbound Cloud tunnel. Tailscale access is the
private Stage 1 deployment path, not a substitute for those hosted controls.
