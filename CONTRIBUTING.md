# Contributing

Thanks for improving **YouTube Live Chat Overlay**. Source, comments, commit
messages, and issue content should be written in English. Supported root README
translations may be written in Korean or Japanese when they remain aligned with
`README.md`.

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

## Command catalog

Run package commands from the repository root with manifest-pinned Node and
pnpm after restoring the recorded `packages/core` gitlink. The dependency-free
`preinstall` check can run before dependencies exist. `packages/core` supplies
product runtime code; automation helpers are consumer-owned or separately
pinned. The table records execution stage, inputs, side effects and checks.

### Package commands

| Public command or family | Purpose; owner, runtime, and stage | Inputs, outputs, side effects; verification |
| --- | --- | --- |
| `pnpm install` (`preinstall`) | `scripts/check/bootstrap.ts` checks the recorded core manifest with Node built-ins before dependencies or the submodule exist. | Reads `packages/core/package.json`; no check writes; missing path gives submodule recovery steps and exits nonzero. `test/unit/tooling/command-adapters.test.ts` and `pnpm check:scripts`. |
| `pnpm quality:nose` | Optional local duplication query via `scripts/check/nose.ts`; Nose remains an external tool. | Reads `src` and `.nose-baseline.json`, inherits cwd/environment, forwards status/signal; absent binary explicitly skips, installed failure fails. `test/unit/tooling/command-adapters.test.ts`; CI installation/integrity is required. |
| `pnpm dev`, `build`, `build:dev`, `build:ci` | Vite userscript build/watch; ordinary `build` has `prebuild` (`check:prebuild`) version/quality gate and `build:dev` selects development mode. `:ci` is the explicit gate-free build step. | Reads source/Vite/core; writes `dist`. `dev` watches; verify via `pnpm verify`, userscript artifacts and affected Playwright lane. |
| `pnpm build:extension`, `build:extension:firefox`, `build:extension:dev`, and `:ci` variants | Vite extension background/content/page builds for Chromium and Firefox; ordinary names have `prebuild:extension` or `prebuild:extension:firefox` quality/version gates. | Writes `dist-extension*`; `build:extension:dev` selects development mode. Check artifacts, extension config tests and Playwright browser lanes; no release publication. |
| `pnpm build:targets:ci`, `build:all`, `build:all:ci`, `prebuild:all`, `check:prebuild` | `build:targets:ci` chains userscript, Chromium, Firefox and `check:artifacts`; `build:all` aliases it. `build:all:ci` adds version/i18n checks; `prebuild:all` and the ordinary `prebuild`/extension lifecycle hooks invoke `check:prebuild` (versions + quality). | Generated `dist*` files; verify target outputs and gate order with `pnpm verify` and config tests, avoiding repeated quality checks when composing commands. |
| `pnpm clean`, `clean:all` | `scripts/build/clean.ts` removes generated `dist`, Chromium and Firefox outputs; `clean:all` aliases it. | Deletes only generated outputs relative to invocation cwd. `test/unit/config/node-script-boundaries.test.ts` covers import/CLI behavior. |
| `pnpm check:i18n`, `check:artifacts` | `scripts/check/i18n.ts` compares locale keys to English; `scripts/check/artifacts.ts` verifies built userscript/extensions, with `--e2e` selecting development user script. | Reads locale or generated build files; reports failures, no product source writes. `test/consistency/i18n-coverage.test.ts`, artifact/config tests and direct commands. |
| `pnpm check:versions`, `sync:versions`, `release:prepare` | `scripts/release/version.ts` checks or syncs extension versions against package version (`BUILD_VERSION` may select check target). `scripts/release/prepare.ts` validates `RELEASE_VERSION` and optional SHA, then prepares archives, checksums, metadata and release notes. | `check` reads; `sync` writes manifests; prepare reads builds/source identity and writes local release assets. `test/unit/config/{node-script-boundaries,release-prepare,release-runtime}.test.ts` plus artifact inspection. Preparation does not publish. |
| `pnpm check`, `check:extension`, `check:test`, `check:e2e`, `check:scripts`, `typecheck` | TypeScript projects for browser, extension, Vitest, Playwright and strict NodeNext/erasable scripts. `tsconfig.scripts.json` includes all `scripts/**/*.ts` plus the Node DevTools endpoint fixture; `tsconfig.test.json` excludes that direct-Node fixture. | Read-only; `pnpm quality` executes every type boundary. Windows `.mjs` is outside TypeScript checking and needs its own syntax/unit checks. |
| `pnpm fmt`, `fmt:check`, `lint`, `knip`, `knip:full`, `knip:production`, `circular` | Biome formatting/lint, unused-code and source graph analysis. | Read-only; Knip includes `scripts/**/*.ts`, tooling and test projects. `fmt:fix`, `lint:fix`, `quality:fix` write source formatting and need diff review. |
| `pnpm quality`, `verify`, `verify:full` | Quality chains formatting, lint, all type projects, direct Node CI tests, i18n, circular, Knip and optional Nose. Verify adds versions and all production target builds/artifact checks; full adds core verification, coverage and Playwright E2E. | Writes generated builds/reports/browser profiles at broader stages; `verify` alone is not browser or prepared-VM acceptance. |
| `pnpm test`, `test:watch`, `test:cov`, `test:ci`, `test:core`, `validate:consistency` | Vitest and direct Node `scripts/ci/{deep-check-reuse,repository-authority}.test.ts` and `scripts/release/verify-source.test.ts`; `test:core` installs/verifies the pinned core checkout, and consistency selects contract tests. | Watch persists and coverage writes reports; `test:ci` checks reuse, authority and tagged source, not UI. `test:core` changes submodule dependencies and needs a prepared checkout. |
| `pnpm test:e2e`, `test:e2e:headed`, `pretest:e2e` | Playwright config under `test/e2e/`; pre-hook builds development userscript plus Chromium/Firefox bundles and checks `--e2e` artifacts. | Requires installed browsers, writes profiles/results/screenshots; validate actual fixture browser flow. Headed local tests are distinct from source-bound Windows installation/live acceptance. |
| `pnpm mut`, `mut:fast`, `mut:renderer` | Stryker full/fast/renderer mutation profiles. | Writes temp/report files; use actual mutation/deep-check receipts. |
| `python3 validation/windows/prepare-userscript-manager.py --output <new-directory>` | Host-side Python standard-library preparation of reviewed Tampermonkey before optional Windows userscript installation; it is not a guest bundle asset. | Direct HTTPS to clients2.google.com or clients2.googleusercontent.com, at most five redirects, 60-second timeout and 16 MiB body; verifies pinned SHA-256, CRX3 bounds and MV3 manifest, limits ZIP to 1,000 entries/64 MiB declared uncompressed size, then writes an installation receipt by atomic rename. Nine local fixtures in `test/unit/config/userscript-manager-package.test.ts`; see `validation/windows/README.md` for untested archive/failed-write and VM cases. |

### Workflow and subprocess entrypoints

| Surface | Contract; stage and side effects | Verification / status |
| --- | --- | --- |
| `.github/workflows/ci.yaml`, `security.yaml` changed-path jobs | `scripts/ci/classify-workflow-changes.ts` runs with Node setup, trusted-base materialization for PR/merge-group and protected checked-out source on push. It uses event-specific Git no-renames NUL-safe diffs and writes fixed conservative gate outputs. | `test/unit/config/{workflow-classifier-git,workflow-scope}.test.ts`; verify exact-SHA hosted jobs execute required work. |
| `.github/workflows/deep-checks.yaml` | `scripts/ci/deep-check-reuse.ts` owns bounded duplication, fast mutation and renderer mutation reuse. The workflow copies `scripts/ci/{pinned-tools.json,pinned-tools.ts,install-nose.ts}` from the reviewed tool revision before required Nose installation. | `scripts/ci/deep-check-reuse.test.ts` and `test/unit/config/pinned-tools-cli.test.ts`; digest/network failure remains fatal. |
| `.github/workflows/security.yaml` pinned tools and OSV | `scripts/ci/pinned-tools.json` owns tool versions/digests; trusted private `pinned-tools.ts` and `check-pinned-tools.ts` provide image env and freshness checks. The independently pinned browser-core `automation/actions/prepare-osv` supplies the private `overlay` OSV helper; `packages/core` is the runtime gitlink. | `test/unit/config/pinned-tools-cli.test.ts`, `test/unit/config/osv-workflow-composition.test.ts`, and provider overlay fixtures; `docs/osv-workflow.md` explains trust order and live-container limits. |
| `.github/workflows/release.yaml` | `scripts/release/verify-source.ts` checks protected tagged source before fan-out; `prepare.ts` creates local release files. The locked publish job still contains live Latest ordering and public-release action wiring in workflow shell; short `run:` blocks select checkout, append outputs and launch actions. | `scripts/release/verify-source.test.ts`, `test/unit/config/{release-prepare,release-runtime}.test.ts` and exact-source artifact inspection. Local preparation does not publish. |
| `.github/workflows/dependabot-auto-merge*.yaml`, `update-browser-core.yaml` | Dependabot gate artifact precedes `scripts/ci/dependabot-apply.ts` validation and exact PR/commit rechecks before approval/merge. `scripts/ci/update-browser-core.ts` verifies remote SHA/impact and owns gitlink PR preparation/publication. Runner shell passes event inputs and bounded output/checkout glue. | `test/unit/config/{dependabot-auto-merge,browser-core-automation}.test.ts` and `scripts/ci/repository-authority.test.ts`; hosted exact-SHA checks establish privileged results. |
| `.githooks/pre-commit`, `.githooks/pre-push` | Minimal Git-invoked Bash guards reject detached/default-branch commits and direct default-branch pushes before pinned Node setup. | `test/unit/config/git-hooks.test.ts`. Retained small pre-runtime Git adapter; revisit only if all Git hook invocations can rely on the pinned Node runtime without weakening the refusal. |
| Test subprocess callers | `test/unit/config/{workflow-classifier-git,release-prepare,node-script-boundaries,userscript-manager-package,windows-chrome-process,windows-chrome-profile,windows-firefox-profile,windows-live-duration}.test.ts`, `test/unit/tooling/command-adapters.test.ts`, and `scripts/ci/repository-authority.test.ts` exercise Git, CLI, Python and raw `.mjs` contracts in fixtures. Provider tests own OSV parser/scanner behavior. | Keep executable paths and NodeNext configs aligned; isolated fixtures do not prove installed browser or public release behavior. |

### External Windows bundle and retained languages

`validation/windows/profile.json` lists artifact-only assets, installation entry `install-profile.mjs`, other raw `.mjs` helpers, and the `pnpm` build commands. The external controller supplies portable Windows Node, `playwright-core`, a headed stable browser, and calls `run({ browser, root, output })`. It does not compile TypeScript or load `.ts` from the guest bundle. Keep raw `.mjs` until the controller has a source-bound TS build/loader or checked generated-JS path with stale-output verification, all profile imports/assets are updated together, and focused prepared-VM smoke passes. The Node boundary suite runs `node --check` over every `validation/windows/**/*.mjs` file; existing Windows helper unit tests cover behavior. These do not prove desktop or live-site behavior.

The Python preparer is a separately bounded **host** exception: the manifest-pinned Node standard library has no ZIP archive reader and the repository has no reviewed, pinned ZIP package. Revisit only when a ZIP reader can preserve the current HTTPS, digest, CRX, extraction, cleanup and receipt contracts with adversarial local fixtures and source-bound Windows installation validation.
`validation/windows/README.md` records the nine tested cases. ZIP symlink/duplicate entries, corrupt archives, actual expanded-byte limits, failed-write cleanup and VM installation remain untested by those local fixtures.

Small workflow shell blocks remain runner bootstrap, checkout, output, and action-launch adapters; revisit them when tested Node entrypoints preserve trusted-source and write ordering. The locked release Latest policy is still substantive inline shell; review extraction when a local guard and hosted tests preserve live ordering, public asset checks and source authority.

Git hooks remain Bash because Git invokes them before pinned Node setup. External Nose, browser, Git and vendor binaries are tools rather than handwritten project languages.

Use the narrowest relevant check while working, `pnpm verify` before a pull
request and `pnpm verify:full` for publication-level or browser behavior
changes. A fixture run does not establish live YouTube, Windows, hosted-CI or
public-release evidence.

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

When upgrading static-analysis tools, review configuration hints and reconcile
automatic entry discovery with manual entries in `knip.json`. Run
`pnpm knip:full` and `pnpm knip:production` separately, keeping configuration
hints fatal. Use debug output to confirm that userscript, extension, and worker
entry points remain analyzed in both modes before running `pnpm quality` and
`pnpm build:all:ci`.

## Pull requests

Keep changes focused and describe what changed, why it changed, and how it was
validated. Update README or CHANGELOG content when user-visible behavior or
release notes change.

By contributing, you agree that your changes are licensed under the
[project license](./LICENSE).
