# Contributing

Thanks for improving **YouTube Live Chat Overlay**. Source, comments,
documentation, commit messages, and issue content should be written in English.

## Report an issue

Use the repository issue templates and include:

- Distribution: userscript, Chromium extension, or Firefox extension
- Release version, browser, OS, and userscript manager when applicable
- Stream type: live, premiere, or replay
- Exact reproduction steps and expected versus actual behavior
- Relevant module-prefixed console output with private data removed

Do not report vulnerability details publicly. Follow the
[security policy](./.github/SECURITY.md).

## Development setup

Use the toolchain pinned in `package.json`, or versions that satisfy its
`engines` fields.

```bash
git clone --recurse-submodules https://github.com/PiesP/yt-live-chat-overlay.git
cd yt-live-chat-overlay
git submodule sync --recursive
git submodule update --init --recursive
pnpm install
```

`packages/core` is a pinned Git submodule. Restore the recorded revision with
`git submodule update --init --recursive`; do not pull inside the detached
submodule. Shared changes belong in `PiesP/browser-core` and must be integrated
here as a reviewed gitlink update.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm build:dev` | Build a development userscript with source maps |
| `pnpm build:all:ci` | Build userscript, Chrome, and Firefox outputs |
| `pnpm test` | Run the Vitest suite |
| `pnpm test:cov` | Run tests with coverage thresholds |
| `pnpm test:e2e` | Run userscript and extension browser flows |
| `pnpm validate:consistency` | Run focused schema and consistency tests |
| `pnpm quality` | Run formatting, lint, type, i18n, dependency, and source checks |
| `pnpm verify` | Run quality, all production builds, and artifact checks |
| `pnpm verify:full` | Add coverage and browser tests to `verify` |

Run the narrowest relevant check while working. Use `pnpm verify` before a pull
request and `pnpm verify:full` for publication-level or browser behavior changes.

## Project constraints

- Bundle runtime dependencies; do not add remotely loaded runtime code.
- Preserve the single-file, readable userscript required by userscript hosts.
- Keep userscript and extension differences behind `src/platform/` adapters.
- Use safe DOM APIs for chat content; do not use unsanitized `innerHTML`, `eval`,
  `new Function`, or string timers.
- Use strict TypeScript, project aliases, type-only imports, and explicit guards.
- Use `createLogger('ModuleName')` for runtime diagnostics and avoid logging
  private chat or account data.
- Keep App and RuntimeManager lifecycle ownership deterministic across YouTube
  single-page navigation.
- Keep renderer and worker state instance-owned, bounded, DPR-aware, and
  cleanup-safe. Canvas2D is the implemented rendering path.

## Browser validation

For user-visible changes, verify the affected distribution on a real YouTube
flow and check:

1. Live or replay chat acquisition and overlay startup
2. Settings interaction and persistence
3. Pause, resume, tab visibility, and YouTube navigation cleanup
4. Console health and extension content-script injection
5. Main-thread fallback when worker rendering is unavailable

Explain any browser or extension lane that could not be run.

`pnpm test:e2e` covers the Firefox userscript and installed extension on
deterministic fixtures. Before a release, also complete the
[Firefox extension checklist](./extension/README.md#browser-validation) on a real
YouTube page in a currently supported Firefox release.

## Dependency updates

The repository intentionally follows current stable tools after a 24-hour
cooling window. Keep pnpm trust, build-script, and transitive-source controls
enabled. `package.json`, `pnpm-workspace.yaml`, the lockfile, and pinned workflow
references are authoritative.

## Pull requests

Keep changes focused and describe what changed, why it changed, and how it was
validated. Update README or CHANGELOG content when user-visible behavior or
release notes change.

By contributing, you agree that your changes are licensed under the
[project license](./LICENSE).
