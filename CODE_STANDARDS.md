# Code Standards

Consistency guide for **YouTube Live Chat Overlay**.

## 1. Project shape

- `src/main.ts` is the userscript entry point and owns application bootstrap.
- `src/core/` contains runtime modules such as page watching, settings, rendering, and logging.
- `src/types/index.ts` is the shared type/defaults entry point.
- Build output must remain a **single-file userscript** in `dist/`.

## 2. Naming and file layout

- Classes, types, and interfaces: `PascalCase`
- Functions, variables, and methods: `camelCase`
- Constants: `UPPER_SNAKE_CASE`
- Core modules: `kebab-case.ts`
- Keep browser-runtime logic in `src/core/`; keep shared type definitions in `src/types/`.

## 3. Imports and module boundaries

- Prefer path aliases for cross-folder imports:
  - `@/` → `src/`
  - `@core/` → `src/core/`
  - `@app-types` → `src/types/index.ts`
- Use same-folder relative imports only when the alias would add noise.
- Use `import type` for type-only imports.
- Keep imports static; do not introduce runtime `import()`.
- Do not add barrel imports for cross-folder modules.

## 4. TypeScript rules

- Keep TypeScript strict and avoid `any`.
- Use explicit return types for exported helpers and class methods.
- Prefer `unknown` + narrowing over loose typing.
- Keep settings/config values strongly typed and immutable where practical.

## 5. DOM and userscript safety

- Render message text with DOM APIs such as `textContent`; do not inject raw HTML.
- Avoid `eval`, `new Function`, or string-based timers.
- Keep the overlay non-blocking for YouTube UI (`pointer-events: none` on the overlay root).
- Do not add external storage or network services beyond the existing browser-local flow.

## 6. Runtime conventions

- Route page lifecycle changes through `PageWatcher` and `RuntimeManager`.
- Persist settings through the `Settings` service and `DEFAULT_SETTINGS` from `src/types/index.ts`.
- Keep console logging behind the shared logger and the `[YT Chat Overlay]` prefix.
- When adding user-visible settings, update both runtime defaults and the settings UI.

## 7. Quality gates

Run these before opening a PR:

```bash
pnpm quality
pnpm build
```

Helpful focused checks:

```bash
pnpm check
pnpm fmt
pnpm lint
pnpm knip
pnpm quality:fix
```

## 8. Manual verification

Follow [TESTING.md](./TESTING.md) when runtime behavior changes.

At minimum, validate:

- live stream pages
- premiere pages
- replay pages with chat
- settings persistence and cleanup across YouTube SPA navigation

## 9. Pre-PR checklist

- [ ] `pnpm quality` passes
- [ ] `pnpm build` succeeds
- [ ] Manual checks from `TESTING.md` were run when runtime behavior changed
- [ ] `README.md` / `CONTRIBUTING.md` updated if user-visible behavior or workflow changed
- [ ] No raw HTML injection, dynamic imports, or external service dependencies were introduced
