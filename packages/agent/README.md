# Relay Agent

The Relay Agent is the open-source macOS component installed on a user's Mac.
It owns local Codex/Claude integration, approved project discovery, local
session recovery, and an outbound authenticated connection to Relay Cloud.

The current local Codex adapter, project discovery, cache, and local API now
live in `src/`. The next extraction splits that local API into a thin adapter
and leaves a reusable daemon core here. The Agent exposes typed provider
operations and must never provide a generic remote shell endpoint.
