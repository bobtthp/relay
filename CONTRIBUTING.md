# Contributing

Use Node.js 22 or newer.

1. Run `npm ci` from the repository root.
2. In one terminal, run `npm run dev:backend`; in another, run `npm run dev`.
3. Open `http://localhost:5173` and choose a local Git repository in Relay.
4. Run `npm run check` and `npm run build` before opening a pull request.

The selected repository is saved in Relay's local state. `RELAY_PROJECT_PATH`
is not currently read by the application, so setting it in `.env` has no effect.

Do not add real session logs, credentials, private keys, or repository source
code to fixtures or issues.

## Language support

Add new user-visible web interface text to the locale dictionary in
`apps/web/src/App.tsx` in both English and Simplified Chinese. Do not add
hard-coded single-language labels in components. Keep technical identifiers,
paths, commands, and agent-provided output unchanged.
