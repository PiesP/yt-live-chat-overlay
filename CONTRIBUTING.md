# Contributing to YouTube Live Chat Overlay

Thanks for improving **YouTube Live Chat Overlay** — a single-file userscript that renders YouTube live chat as a Nico-nico style overlay with 100% local processing.

> **Language policy**: Code, comments, commits, and docs — English only.

## Before opening an issue

Include: browser + version, OS + userscript manager, stream type (live/premiere/replay), repro steps, script version, and console output (prefixed with module names like `[App]`, `[Renderer]`).

## Development setup

### Prerequisites

- Use the Volta versions in `package.json` (currently Node.js `26.5.0` and pnpm
  `11.17.0`), or engines-compatible Node.js `>=22.13.0` and pnpm `>=11.17.0`.

### Commands

```bash
pnpm install
pnpm build           # prod bundle (quality gate via prebuild)
pnpm build:dev       # dev bundle with source maps
pnpm dev             # dev watch mode
pnpm quality         # fmt + lint + check + circular + knip
pnpm quality:fix     # auto-fix then check
pnpm check           # tsc --noEmit
pnpm lint            # Biome lint
pnpm fmt             # Biome format
pnpm circular        # dpdm circular dependency detection
pnpm knip            # unused dependencies scan
pnpm knip:full       # full unused files/exports/deps scan
```

`pnpm build` runs the quality gate via `prebuild` before producing `dist/yt-live-chat-overlay.user.js`.

### Testing

1. Install `dist/yt-live-chat-overlay.dev.user.js` in Violentmonkey with "Track local file".
2. Run `pnpm dev` — auto-rebuilds on changes; Violentmonkey picks up the update.
3. Reload YouTube to see changes.

## Project constraints

- **No runtime-loaded external code** — dependencies, including the pinned
  `@piesp/browser-core` submodule, are bundled; preserve the single-file userscript.
- **All processing stays in-browser** — no server-side data fetching.
- **Greasy Fork rules** — no minification or obfuscation.
- **DOM-safe rendering** — `textContent`, sanitized attributes; no raw HTML injection.
- **SSOT principle** — single source of truth for settings, dedup, measurement.

### Dependency update policy

- Prefer current stable libraries and tools; this personal project intentionally
  adopts modern platform and ecosystem capabilities quickly.
- pnpm and Dependabot enforce a 24-hour cooling window for newly published
  packages. Do not bypass it for routine updates.
- Dependabot checks npm packages and GitHub Actions daily. Passing patch/minor
  tooling updates may auto-merge; major and runtime behavior changes require
  manual review.
- pnpm also rejects recent trust-level downgrades, unapproved dependency build
  scripts, and exotic transitive sources. The daily security workflow checks
  pinned Nose, OSV Scanner, and Semgrep releases after the cooling window.

## Code style

See [CODE_STANDARDS.md](./CODE_STANDARDS.md) for detailed conventions. Key points:

- Path aliases: `@util/*`, `@app/*`, `@renderer/*`, `@chat/*`, `@settings/*`, `@i18n/*`, `@app-types` (see tsconfig.json)
- Use `createLogger('[ModuleName]')` from `@util/logging`
- Non-null assertions (`!`) and `any` are forbidden
- Prefer Canvas2D renderer for new rendering features

## Pull requests

- Clear title + explanation of **what** and **why**
- Small, focused commits with descriptive messages
- Validation note: `pnpm verify:full` passed, or why a smaller set was sufficient
- Update README / CHANGELOG if user-visible behavior changed

Thanks for helping improve **YouTube Live Chat Overlay**!
