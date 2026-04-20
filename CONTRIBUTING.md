# Contributing to YouTube Live Chat Overlay

Thanks for improving **YouTube Live Chat Overlay**. This repository ships a single-file userscript that renders YouTube live chat as a Nico-nico style overlay with 100% local processing.

> **Language policy**: Source code, comments, commit messages, and development documentation in this repository must be written in **English**.

## Communication

- Bugs / feature requests: GitHub Issues
- Security-sensitive reports: see [.github/SECURITY.md](./.github/SECURITY.md)
- Questions: GitHub Discussions if enabled; otherwise open an issue with clear context

## Before opening an issue

Please include:

- Browser + version
- OS + userscript manager
- Whether the page was a live stream, premiere, or replay with chat
- Steps to reproduce and expected vs actual behavior
- Script version (userscript header or release tag)
- Relevant console output (prefixed with `[YT Chat Overlay]`)

Avoid posting private account information or sensitive browser data.

## Development setup

### Prerequisites

- Volta Node.js `24.15.0` (project default) or engines-compatible Node.js `>=24.0.0`
- pnpm `>=10.29.2`

### Install

```bash
pnpm install
```

### Common commands

```bash
pnpm build
pnpm build:dev
pnpm check
pnpm typecheck
pnpm lint
pnpm fmt
pnpm knip
pnpm quality
pnpm quality:fix
```

`pnpm build` runs the repository quality gate through `prebuild` before generating `dist/yt-live-chat-overlay.user.js`.

## Recommended development flow

1. Make a focused change under `src/` or `tooling/`.
2. Use `pnpm build:dev` for quick iteration while testing in your userscript manager.
3. Run `pnpm quality`; use `pnpm quality:fix` first if you want standard format/lint fixes applied.
4. Run `pnpm build` before opening a PR.
5. Follow the manual verification checklist in [TESTING.md](./TESTING.md) whenever runtime behavior changed.
6. Update `README.md` and release-facing notes if user-visible behavior changed.

## Project constraints

- All processing must remain local to the browser; do not add external data services.
- Keep the overlay root non-interfering with the player (`pointer-events: none`).
- Use DOM-safe rendering only (`textContent`, sanitized attributes); do not inject raw chat HTML.
- Preserve the single-file userscript output model (no code splitting or runtime `import()`).

## Code style

- Use the path aliases documented in [CODE_STANDARDS.md](./CODE_STANDARDS.md).
- Prefer explicit return types for exported helpers and class methods.
- Keep logs prefixed with `[YT Chat Overlay]` via the shared logger utilities.
- Keep changes small and reversible; update docs when behavior or workflow changes.

## Pull request expectations

A good PR includes:

- A clear title and concise explanation of **what** changed and **why**
- Small, focused commits with descriptive messages
- A short validation note (`pnpm quality`, `pnpm build`, manual checks) or why a smaller check set was enough

## Reference documents

- [README.md](./README.md) — user-facing overview
- [CODE_STANDARDS.md](./CODE_STANDARDS.md) — coding rules and repository constraints
- [TESTING.md](./TESTING.md) — manual verification checklist

Thanks for helping improve **YouTube Live Chat Overlay**!
