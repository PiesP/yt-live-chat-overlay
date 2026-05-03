# AGENTS.md

AI coding guidance for **YouTube Live Chat Overlay**.

This repository is a **Tampermonkey/Violentmonkey userscript** that provides a Nico-nico style comment overlay for YouTube live chat. All processing is done locally in the browser.

## Stack

- TypeScript 6.0.x
- Vite 8.x
- Biome 2.x
- pnpm 10.x
- Node.js 24.x

## Repository Structure

- `src/` — userscript source code
- `tooling/` — build tooling (Vite plugins, userscript header generation)
- `dist/` — build artifacts (gitignored)

## Core Constraints

- **No external runtime dependencies**: zero runtime dependencies, 100% local processing.
- **No server involvement**: all comment overlay logic runs in the user's browser.
- **Greasy Fork rules**: scripts must not be minified/obfuscated.
- Source code, comments, and documentation: **English only**.
- Commit messages: **English**, conventional commits.

## Commands

```bash
pnpm build           # prod bundle (runs quality via prebuild)
pnpm build:dev       # dev bundle with source maps
pnpm check           # TypeScript type check (no emit)
pnpm lint            # Biome lint
pnpm lint:fix        # Biome lint --write
pnpm fmt             # Biome format check
pnpm fmt:fix         # Biome format --write
pnpm knip            # Unused dependency scan
pnpm quality         # fmt + lint + check + knip
pnpm quality:fix     # quality with auto-fix
pnpm clean           # rimraf dist
```

## Code Rules

- Follow `CODE_STANDARDS.md` for detailed conventions.
- Keep the bundle small and efficient.
- Use `MutationObserver` for DOM change detection where applicable.
- Prefix runtime logs with `[YTLiveChat]`.
