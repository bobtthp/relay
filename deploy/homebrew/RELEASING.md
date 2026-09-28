# GitHub releases and Homebrew tap

## Source repository

Create a GitHub repository for this source tree and push the `main` branch.
The repository must contain the release workflow at
`.github/workflows/release.yml`. For each release, update `version` in
`package.json` and `package-lock.json`, commit the change, then create and push
a matching version tag such as `v0.2.0`:

```sh
git tag v0.2.0
git push origin main --tags
```

The workflow checks that the tag matches `package.json`, runs the TypeScript
check and production build, then attaches a source archive and its SHA-256 file
to a GitHub Release. The archive excludes local files that are not tracked by
Git, including `.env` and `node_modules`.

## Homebrew tap

Create a separate GitHub repository named `homebrew-relay` under the same
account or organization. Copy `relay.release.rb.template` to
`Formula/relay.rb`, replace the owner and source repository placeholders, and
set the version and SHA-256 to the values from the release assets. Commit and
push the Formula update.

Once both repositories are public, installation will look like:

```sh
brew install OWNER/relay/relay
brew services start OWNER/relay/relay
```

The first command taps `OWNER/homebrew-relay` automatically. Users can manage
the background service with `brew services stop`, `start`, `restart`, and
`list`. Keep the existing local installer for checkout-based development; the
release Formula uses a versioned GitHub Release archive instead.

The service listens on `127.0.0.1:3000`. Codex CLI and its login remain a
separate prerequisite. Do not run the Homebrew service and the legacy
LaunchAgent at the same time because they use the same port and launchd label.
