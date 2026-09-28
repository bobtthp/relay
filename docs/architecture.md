# Relay architecture and repository plan

## Product boundary

Relay has two products with one protocol:

| Component | Distribution | Responsibility |
| --- | --- | --- |
| Relay Agent | Open source, runs on a user's Mac | Local Codex/Claude execution, local project access, durable outbound connection |
| Relay Protocol | Open source | Versioned messages, capability declarations, SDKs and compatibility tests |
| Relay Cloud | Commercial hosted service | Accounts, device pairing, access control, browser UI, event persistence and secure routing |

The Cloud never needs inbound SSH access to a user's Mac. Source code,
Codex credentials and agent process access remain on that Mac.

## Runtime topology

```text
Relay Web Browser
  │ authenticated HTTPS / WSS
  ▼
Relay Cloud ─────── task and event persistence
  │ authenticated, outbound WSS tunnel
  ▼
Relay Agent on the user's Mac
  │ localhost only
  ▼
Codex app-server / Codex CLI / approved project directories
```

The Agent initiates the tunnel and subscribes to its own machine channel. No
Mac port, SSH service, Vite development server, or raw Codex app-server is
published to the internet.

## Pairing and identity

1. A signed-in user creates a Machine in Relay Cloud.
2. Cloud issues a one-time pairing code or QR code, normally valid for ten
   minutes.
3. Relay Agent exchanges that code for a machine-specific credential.
4. The credential is held in macOS Keychain and used for a mutually
   authenticated, outbound WSS connection.
5. Cloud routes commands only when the signed-in user is authorized for that
   Machine; Agent independently checks the addressed machine and allowed
   project before execution.

There are deliberately separate credentials for a browser user and a machine
Agent. A user API key must never double as a long-lived remote-execution key.

## Protocol rules

The Agent accepts typed actions, not arbitrary remote shell execution.

```text
machine.hello
machine.heartbeat
project.list
task.create
task.resume
task.message
task.interrupt
agent.event
approval.request
approval.resolve
```

Every action includes a protocol version, request ID, user ID, machine ID and
task ID where applicable. Events are append-only and sequenced per task so a
browser can reconnect and rebuild the session timeline.

Cloud must record an audit entry for pairing, credential rotation, task
creation, approvals and Agent disconnects. Agent commands must be scoped to
locally approved Git projects. Installation and sensitive operations require a
user approval flow.

## Repository layout

```text
apps/
  web/             Local-first browser product and future Cloud Web client
packages/
  agent/           macOS daemon, Codex/Claude adapters and local state
  protocol/        JSON schemas, TypeScript types and protocol tests
  shared/          UI/domain helpers with no privileged machine access
deploy/
  launchd/         Service plist templates and install scripts
docs/              Architecture, protocol and operations documents
```

The hosted Cloud implementation is maintained separately and is not included
in this source distribution.

Today the runnable prototype is split into its intended component folders:

- `apps/web/src/` — browser UI
- `packages/agent/src/` — local API, Codex adapter, history discovery and cache
- `packages/protocol/src/` — shared protocol domain types

This preserves the current developer commands. Continue extraction
package-by-package:

1. Replace direct protocol source imports with a published package build.
2. Split `apps/agent` into its daemon core and a local HTTP adapter.
3. Keep an HTTP adapter in `apps/web` for local-only development.
4. Add Cloud broker support to Agent without changing Codex provider calls.
5. Build the Cloud UI/API on the same protocol.

## Deployment stages

### Stage 0: local development — now

The local backend binds to `127.0.0.1`; Vite proxies the browser to it. This is
for development and must not be directly exposed to the public internet.

### Stage 1: private remote access

The repository includes a macOS `launchd` installer that serves the built UI
and API from the loopback-only Agent. Use a private HTTPS reverse proxy such
as Tailscale Serve, with tailnet ACLs, for remote iPad/phone access. Do not
bind the Agent or development server to a public interface. This validates
remote use without operating a public relay.

### Stage 2: hosted preview

Cloud provides login, pairing and a broker. Agent maintains an outbound WSS
connection. A Cloudflare Tunnel can help expose the Cloud during early
development, but it is not a substitute for machine authorization.

### Stage 3: commercial Relay Cloud

Add production account management, billing, device revocation, audit logs,
notifications, multi-device synchronization and organization controls. The
public repository is currently licensed under MIT; Relay Cloud remains private.

## Non-negotiable safety constraints

- Do not expose Codex app-server, SSH, or the Agent's local API publicly.
- Do not store SSH private keys, Codex credentials or Agent credentials in the
  browser or plaintext files.
- Do not make a generic `shell.exec` Cloud-to-Agent protocol endpoint.
- Do not allow the Cloud to select an arbitrary local path without Agent-side
  allow-list validation.
- Do not use a development server as the production public endpoint.
