# Contributing to YouTube Live Chat Overlay

Thanks for your interest in contributing! This guide covers the basics for reporting issues and submitting pull requests.

> **Language policy**: Source code, identifiers, inline comments, and commit messages must be written in **English**. Documentation should follow the established language and style of the file you are editing (for example, English guides and Korean changelog entries).

---

## Reporting issues

- Use the **Bug report** or **Feature request** templates.
- Please include:
  - A clear description of the problem or idea
  - Steps to reproduce (for bugs)
  - Your browser, OS, and userscript manager
  - The script version (from the userscript header or GitHub release tag)

Security-sensitive issues should follow the process described in:

- [Security Policy](.github/SECURITY.md)

---

## Development basics

### Prerequisites

- [Node.js](https://nodejs.org/) **24.x** or later
- [pnpm](https://pnpm.io/) **10.x** or later

### Local setup

```bash
git clone https://github.com/PiesP/yt-live-chat-overlay.git
cd yt-live-chat-overlay
pnpm install
```

### Common commands

```bash
# Production build
pnpm build

# Development build
pnpm build:dev

# TypeScript typecheck
pnpm check

# Lint source and build tooling
pnpm lint

# Format check for source and build tooling
pnpm fmt

# Run the full local quality gate
pnpm quality
```

---

## Before opening a pull request

1. Sync with `master` and rebase if necessary.
2. Run the same checks used by local quality/release flows:

```bash
pnpm quality
pnpm build
```

3. Verify behavior on a desktop YouTube live stream, premiere, or replay page when applicable.
4. Update documentation if user-visible behavior changed:
   - `README.md` for user-facing changes
   - Release notes / `CHANGELOG.md` in the existing file language when preparing a release

---

## Pull request expectations

A good PR includes:

- A clear title and short description of **what** changed and **why**
- Small, focused commits with descriptive messages
- Tests or a short note explaining why tests are not required

---

Thank you for helping improve **YouTube Live Chat Overlay**!
