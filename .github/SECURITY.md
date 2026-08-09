# Security policy

This policy covers the userscript and the Chrome and Firefox extension builds
of **YouTube Live Chat Overlay**.

## Supported versions

Security support is provided for the latest release on
[GitHub Releases](https://github.com/PiesP/yt-live-chat-overlay/releases).
Older releases and unpacked extension builds copied from older releases are not
maintained.

Userscript managers can update the userscript automatically. Unpacked Chromium
and temporary Firefox installations must be replaced manually when a new
release is published.

## Report a vulnerability

Do not disclose vulnerabilities in a public issue.

1. Prefer a [private GitHub Security Advisory](https://github.com/PiesP/yt-live-chat-overlay/security/advisories/new).
2. If advisories are unavailable, open a minimal issue requesting a private
   contact channel without including technical details.

Include the impact, reproduction steps, distribution, release version, browser,
and OS when available. We aim to respond within seven business days and
coordinate disclosure after a fix is available.

## Security and privacy model

- Application logic runs in the browser on YouTube pages.
- The project does not operate an analytics, telemetry, translation, or chat
  processing server.
- Runtime requests use YouTube and Google media hosts required to acquire and
  render chat content.
- Extension permissions are declared in the versioned manifests.
- The application does not use `eval()` or equivalent dynamic code execution.

See [PRIVACY.md](../PRIVACY.md) for data, storage, network, and translation
details.

## Development security

CI combines strict TypeScript, Biome, i18n and consistency checks, unit coverage,
userscript and extension Playwright tests, production builds, artifact checks,
duplication analysis, mutation testing, CodeQL, OSV Scanner, and Semgrep. The
workflow files and package scripts are authoritative for the exact checks.

Codex Security is an advisory, AI-assisted review layer and does not replace
those deterministic gates or human validation. Local scans use the pinned CLI
from `.github/workflows/codex-security.yaml` without changing the dependency
lockfile:

```bash
pnpm security:codex:dry-run
pnpm security:codex:working-tree
pnpm security:codex:branch -- origin/master
pnpm security:codex:full
```

Scan results may contain source excerpts and vulnerability details. The wrapper
stores its state and output outside the repository with private permissions;
review and remove retained results according to their sensitivity. Treat every
finding as a candidate until its source-to-sink path, preventive controls,
runtime reachability, and severity have been validated by a human. Coverage
marked partial or unknown is not evidence of a complete review.

The GitHub workflow remains disabled unless the repository variable
`CODEX_SECURITY_ENABLED` is exactly `true` and the `CODEX_SECURITY_API_KEY`
Actions secret is configured. It runs without a severity failure threshold
during the advisory rollout. Pull-request scans are limited to trusted
same-repository, non-Dependabot branches; manual dispatch runs a standard
full-repository scan. Findings are advisory, while input/runtime errors and
partial or unknown coverage still fail the job. CI sends findings to GitHub code
scanning and retains only manifest and coverage metadata for seven days.

Dependencies retain the repository's cooling window, trust policy, approved
build-script list, and registry-source restrictions. Do not weaken those
controls to accept an update.

## Scope

In scope are vulnerabilities introduced by this repository, including
injection, unsafe URL or message handling, permission misuse, privacy leaks, and
supply-chain issues. Vulnerabilities in YouTube, browsers, and userscript
managers should be reported to their respective vendors unless this project's
integration causes the issue.

## License

This project is licensed under the [MIT License](../LICENSE).
