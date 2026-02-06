# Contributing to YouTube Live Chat Overlay

Thanks for your interest in contributing! This guide covers the basics for reporting issues and submitting pull requests.

> **Language policy**: All source code, comments, commit messages, and documentation must be written in **English**.

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

# Lint source code
pnpm lint

# Format check
pnpm fmt

# Run all quality checks
pnpm quality
```

---

## Before opening a pull request

1. Sync with `master` and rebase if necessary.
2. Run at least a build and basic static checks locally:

```bash
pnpm build
# or
pnpm quality
```

3. Verify behavior on a desktop YouTube live stream.
4. Update documentation if user-visible behavior changed:
   - `README.md` for user-facing changes

---

## Pull request expectations

A good PR includes:

- A clear title and short description of **what** changed and **why**
- Small, focused commits with descriptive messages
- Tests or a short note explaining why tests are not required

---

Thank you for helping improve **YouTube Live Chat Overlay**!
