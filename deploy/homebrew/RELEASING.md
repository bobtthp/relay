# GitHub releases and Homebrew formula

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
check and production build, and creates a draft GitHub Release with a source
archive. It then builds Homebrew bottles for Apple Silicon and Intel on macOS
15 and macOS 26 runners, uploads them to the release, adds their checksums to
the rendered `Formula/relay.rb`, commits that formula to the default branch,
and publishes the release. The source archive excludes local files that are
not tracked by Git, including `.env` and `node_modules`.

Each bottle runner installs the formula and smoke-tests the Homebrew service,
including its health endpoint, access-token setup, and web page, before the
workflow can publish the release. The bottle includes Relay's built UI, server,
and Node.js dependencies. Homebrew still installs the `node@22` runtime as a
bottle dependency; supported Macs do not build Relay locally or need Command
Line Tools for the Relay formula.
Systems without a matching bottle may fall back to a source build and require
Command Line Tools.

## Installing from this repository

The source repository itself contains the tap formula, so a separate
`homebrew-relay` repository is not needed. Since the GitHub shorthand
`brew tap bobtthp/relay` normally maps to a repository named `homebrew-relay`,
users specify the Git URL explicitly:

```sh
brew tap bobtthp/relay https://github.com/bobtthp/relay.git
brew install bobtthp/relay/relay
brew services start bobtthp/relay/relay
```

After the tap is installed once, future formula updates arrive through
`brew update`; users can upgrade Relay with
`brew upgrade --formula bobtthp/relay/relay`.

For each release, update `version` in `package.json` and `package-lock.json`,
commit and push the change to the default branch, then push the matching
`vX.Y.Z` tag. The release workflow needs permission to push the generated
formula commit to the default branch, so repository Actions settings must
allow GitHub Actions to write contents.

Keep the existing local installer for checkout-based development; the release
Formula uses a versioned GitHub Release archive instead.

The service listens on port `3000` for local-network connections and requires
the token stored at `~/.relay-web/auth-token`. Keep the port private to a
trusted LAN; do not expose it publicly or forward it on a router. Codex CLI and
its login remain a separate prerequisite. Do not run the Homebrew service and
the legacy LaunchAgent at the same time because they use the same port and
launchd label.
