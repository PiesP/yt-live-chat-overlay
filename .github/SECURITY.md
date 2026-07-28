# Security Policy

This document describes how security is handled for **YouTube Live Chat Overlay** and how to responsibly report vulnerabilities.

---

## Supported Versions

We only provide security support for the **latest released version** of the userscript on [GitHub Releases](https://github.com/PiesP/yt-live-chat-overlay/releases).

| Version | Supported          |
| ------- | ------------------ |
| Latest  | :white_check_mark: |
| Older   | :x:                |

Userscript managers (Tampermonkey, Violentmonkey, etc.) can auto-update the script; we recommend keeping auto-update enabled.

---

## Reporting a Vulnerability

If you discover a security vulnerability, **do not** disclose it publicly.

1. **Preferred**: Use [GitHub Security Advisories](https://github.com/PiesP/yt-live-chat-overlay/security/advisories/new).
2. If that is not available, open a minimal GitHub issue asking for a private channel **without** sharing technical details.

Please include, where possible:

- A short description and impact
- Steps to reproduce
- Browser, OS, and userscript manager versions
- Script version (from the userscript header)

We aim to respond within **7 business days** and coordinate disclosure once a fix is available.

---

## Security Model & Privacy

**YouTube Live Chat Overlay** is a client-side userscript that runs entirely in your browser on YouTube.

- All logic executes locally in the browser.
- We do **not** collect, store, or transmit personal data or chat content.
- The script does not use `eval()` or similar dynamic code execution.

---

## Development Security

We use several mechanisms to keep the codebase secure:

- **GitHub Security Suite** (`.github/workflows/security.yaml`)
  - CodeQL for JavaScript/TypeScript and GitHub Actions
  - Dependency scanning with OSV Scanner (PR diff + daily full scans)
  - Static analysis with Semgrep on PR, daily, and manual runs
  - Daily freshness checks for pinned Nose, OSV Scanner, and Semgrep releases
- **Dependabot** (`.github/dependabot.yaml`)
  - Daily grouped updates for npm packages and GitHub Actions after a 24-hour cooldown
- **Quality & Testing**
  - pnpm enforces the same cooling window, recent trust-level non-downgrade,
    reviewed install scripts, and registry-only transitive dependencies
  - TypeScript strict mode, Biome, Knip, circular-dependency checks, duplication,
    tracked unit tests, browser/extension Playwright E2E, and mutation tests

These checks run in pull requests, the merge queue, and scheduled/manual workflows; local development uses the same toolchain via `pnpm` commands.

---

## Scope

In scope for this policy:

- Vulnerabilities in this userscript (XSS, injection, logic flaws, privacy leaks)
- Vulnerabilities introduced by this repository’s dependencies

Out of scope:

- Issues in YouTube itself (report via Google/YouTube security channels)
- Bugs in userscript managers (Tampermonkey, Violentmonkey, etc.)

---

## License

This project is licensed under the [MIT License](../LICENSE).
