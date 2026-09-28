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
check and production build, then attaches a source archive and its SHA-256 file
to a GitHub Release. It also renders
`deploy/homebrew/relay.release.rb.template` and commits the versioned formula
to `Formula/relay.rb` on the default branch. The archive excludes local files
that are not tracked by Git, including `.env` and `node_modules`.

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
`brew update`; users can upgrade Relay with `brew upgrade relay`.

For each release, update `version` in `package.json` and `package-lock.json`,
commit and push the change to the default branch, then push the matching
`vX.Y.Z` tag. The release workflow needs permission to push the generated
formula commit to the default branch, so repository Actions settings must
allow GitHub Actions to write contents.

Keep the existing local installer for checkout-based development; the release
Formula uses a versioned GitHub Release archive instead.

The service listens on `127.0.0.1:3000`. Codex CLI and its login remain a
separate prerequisite. Do not run the Homebrew service and the legacy
LaunchAgent at the same time because they use the same port and launchd label.
