# Relay Protocol

This package will publish versioned schemas and TypeScript types shared by
Relay Agent, Relay Cloud and supported self-hosted implementations.

The protocol is designed around typed task actions and sequenced normalized
events. It must not include customer secrets or provider-specific raw stdout
as an API contract.
