# Code Standards

Consistency guide for **YouTube Live Chat Overlay**. Follow these rules to keep code modern, readable, and easy to maintain.

## Table of Contents

1. [File Organization](#1-file-organization)
2. [Naming Conventions](#2-naming-conventions)
3. [TypeScript Conventions](#3-typescript-conventions)
4. [Import/Export Rules](#4-importexport-rules)
5. [Common Patterns](#5-common-patterns)
6. [Anti-patterns](#6-anti-patterns)
7. [Pre-Commit Checklist](#7-pre-commit-checklist)

---

## 1. File Organization

```
src/
├── core/          # Core logic modules (.ts)
├── types/         # TypeScript definitions (.ts)
└── main.ts        # Entry point
tooling/
├── vite/          # Vite plugins
└── userscript-header.ts
```

**File names**

- Modules: `kebab-case.ts`
- Types: `kebab-case-types.ts` or `index.ts`
- Components/classes: `PascalCase.ts`
- Hooks: `use-kebab-case.ts`

## 2. Naming Conventions

- **Types and interfaces**: `PascalCase`
- **Functions and variables**: `camelCase`
- **Constants**: `UPPER_SNAKE_CASE`
- **Private/internal members**: prefix with `_` (convention, not enforced)
- **File names**: kebab-case for modules, PascalCase for component files

## 3. TypeScript Conventions

- **Strict mode**: enabled. Avoid `any` at all costs.
- **Explicit types**: prefer explicit return types on exported functions.
- **`unknown` over `any`**: use `unknown` + narrowing for external/uncertain values.
- **`as const`**: use for fixed maps, enum-like objects, and literal arrays.
- **No `eval`**: never use `eval`, `new Function`, or string-based timers.

## 4. Import/Export Rules

- **No barrel imports**: import directly from the source module.
- **Alias-first**: use configured path aliases (`@core/*`, `@app-types`) for cross-directory imports.
- **Relative imports**: only for same-directory imports.
- **Named exports**: prefer named exports over default exports.
- **Type imports**: use `import type { ... }` for type-only imports.

## 5. Common Patterns

- **Singleton services**: use `getInstance()` pattern.
- **Event handling**: use typed event maps where possible.
- **DOM access**: prefer `textContent` over `innerHTML`.
- **MutationObserver**: prefer over polling for DOM change detection.
- **Logging**: prefix runtime logs with `[YTLiveChat]`.

## 6. Anti-patterns

- ❌ No `any` unless absolutely necessary (and document why).
- ❌ No barrel files (`index.ts` that re-export).
- ❌ No `eval`, `new Function`, or string-based `setTimeout`/`setInterval`.
- ❌ No raw HTML injection (use `textContent` or safe DOM APIs).

## 7. Pre-Commit Checklist

```bash
pnpm fmt:fix
pnpm lint
pnpm check
pnpm knip
pnpm build
```
