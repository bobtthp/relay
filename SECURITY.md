# Security policy

Relay can start coding-agent turns that read and modify local repositories. Treat
it as a privileged local application.

- The default listener is available to devices on the local network and uses a
  generated access token stored in `~/.relay-web/auth-token`. Use Relay only on
  a trusted local network. Never expose port 3000 to the public internet or
  forward it on your router.
- Never commit `.env`, `.relay/`, or session/cache files.
- Automatic approval is disabled by default. If enabled, Relay accepts command
  requests, file changes with a reviewable diff, and permissions limited to the
  current turn. Enable it only for projects and sessions you trust; URL actions,
  forms, and Codex questions still require manual handling.
- Use the repository's **Security → Report a vulnerability** page when private
  vulnerability reporting is enabled. Otherwise, use the private security
  contact listed in the repository's About section.
- Do not open a public issue for credentials, remote execution,
  authentication, or data-exposure bugs.

Before making the repository public, maintainers must enable GitHub private
vulnerability reporting or add a monitored private security contact to the
repository's About section.
