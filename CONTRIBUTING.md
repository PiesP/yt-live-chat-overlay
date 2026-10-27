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

Workflow jobs prepare the official remediated OS CA store before their first
JavaScript Action and select it through workflow-scoped Node TLS settings. The
[pinned shared helper contract](https://github.com/PiesP/browser-core/blob/381b4ca733494cf069212cd0d16458389a83c623/automation/README.md#consumer-contract)
covers Ubuntu 24.04 and the pinned Alpine scanner image; unsupported systems fail
closed. Runner downloads before job steps and tools with separate TLS stores
remain separate boundaries. Keep the helper first and preserve these settings
when editing workflows.


Use the toolchain pinned in `package.json`, or versions that satisfy its
`engines` fields.

```bash
git clone --recurse-submodules https://github.com/PiesP/yt-live-chat-overlay.git
cd yt-live-chat-overlay
git submodule sync --recursive
git submodule update --init --recursive
npm install --global "$(node -p "require('./package.json').packageManager")" --allow-scripts=pnpm
pnpm install --frozen-lockfile
```

Volta selects Node.js; `packageManager` selects the native pnpm release. Put
npm's global binary directory before Volta's experimental pnpm shim in `PATH`;
that shim expects the older JavaScript entrypoint.
For an existing global Volta pnpm selection, also follow the
[shared bootstrap](https://github.com/PiesP/browser-core/blob/master/README.md#development);
PATH order alone does not retire the manager injected by Volta's Node launcher.

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

| Public command or family                                                                                  | Purpose; owner, runtime, and stage                                                                                                                                                                                                                                                                                                                                                                                                                                              | Inputs, outputs, side effects; verification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install` (`preinstall`)                                                                             | `scripts/check/bootstrap.ts` checks the recorded core manifest with Node built-ins before dependencies or the submodule exist.                                                                                                                                                                                                                                                                                                                                                  | Reads `packages/core/package.json`; no check writes; missing path gives submodule recovery steps and exits nonzero. `test/unit/tooling/command-adapters.test.ts` and `pnpm check:scripts`.                                                                                                                                                                                                                                                                                                                                                                                            |
| `pnpm dev`, `build`, `build:dev`, `build:ci`                                                              | Vite userscript build/watch; ordinary `build` has `prebuild` (`check:prebuild`) version/quality gate and `build:dev` selects development mode. `:ci` is the explicit gate-free build step.                                                                                                                                                                                                                                                                                      | Reads source/Vite/core; writes `dist`. `dev` watches; verify via `pnpm verify`, userscript artifacts and affected Playwright lane.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pnpm build:extension`, `build:extension:firefox`, `build:extension:dev`, and `:ci` variants              | Vite extension background/content/page builds for Chromium and Firefox; ordinary names have `prebuild:extension` or `prebuild:extension:firefox` quality/version gates.                                                                                                                                                                                                                                                                                                         | Writes `dist-extension*`; `build:extension:dev` selects development mode. Check artifacts, extension config tests and Playwright browser lanes; no release publication.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `pnpm build:targets:ci`, `build:all`, `build:all:ci`, `prebuild:all`, `check:prebuild`                    | `build:targets:ci` records source/core/lock/config inputs, chains userscript, Chromium, Firefox and read-only `check:artifacts` once, verifies unchanged inputs, then records the footprint. `build:all` aliases it. `build:all:ci` adds version/i18n checks; `prebuild:all` and the ordinary `prebuild`/extension lifecycle hooks invoke `check:prebuild` (versions + quality).                                                                                                                                                                                                              | Generated `dist*` files and ignored `test-results/distribution-footprint.json`; verify target outputs and gate order with `pnpm verify` and config tests, avoiding repeated quality checks when composing commands.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `pnpm clean`, `clean:all`                                                                                 | `scripts/build/clean.ts` removes generated `dist`, Chromium and Firefox outputs; `clean:all` aliases it.                                                                                                                                                                                                                                                                                                                                                                        | Deletes only generated outputs relative to invocation cwd. `test/unit/config/node-script-boundaries.test.ts` covers import/CLI behavior.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `pnpm check:i18n`, `check:artifacts`                                                                      | `scripts/check/i18n.ts` compares locale keys to English; `scripts/check/artifacts.ts` verifies built userscript/extensions and enforces the packaged renderer's runtime-owned UTF-8 byte limit. `--e2e` selects the development user script. The checker is read-only; the all-target build owns the footprint receipt.                                                                                                                                                                                                                                                                                                     | Reads locale or generated build files; reports failures. `test/consistency/i18n-coverage.test.ts`, artifact/config tests and direct commands.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `pnpm check:versions`, `sync:versions`, `release:prepare`                                                 | `scripts/release/version.ts` checks or syncs extension versions against package version (`BUILD_VERSION` may select check target). `scripts/release/prepare.ts` validates `RELEASE_VERSION` and optional SHA, checks the producing-build footprint receipt against current files, then prepares archives, checksums, metadata and release notes.                                                                                                                                                                                                    | `check` reads; `sync` writes manifests; prepare includes per-file raw bytes/hashes, unpacked totals and actual ZIP bytes/hashes in the existing metadata. An exact `RELEASE_SHA` requires a clean source-bound receipt; without one, local metadata labels footprint unavailable. `test/unit/config/{node-script-boundaries,release-prepare,release-runtime}.test.ts` plus artifact inspection. Preparation does not publish.                                                                                                                                                                                                                                                                                                                             |
| `pnpm check`, `check:extension`, `check:test`, `check:e2e`, `check:scripts`, `check:windows`, `typecheck` | TypeScript projects for browser, extension, Vitest, Playwright and strict NodeNext/erasable scripts. `tsconfig.scripts.json` includes only `scripts/**/*.ts`; `tsconfig.windows.json` checks Windows helpers and the DevTools endpoint fixture with DOM types. `tsconfig.test.json` excludes that direct-Node fixture.                                                                                                                                                          | Read-only; `pnpm quality` executes every type boundary, including `check:windows`. Native Node syntax/unit checks complement the Windows TypeScript project.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `pnpm fmt`, `fmt:check`, `lint` | Vite+/Oxfmt checks formatting and imports; Oxlint checks source, scripts, extension, tests, tooling, Windows helpers and Action files. `import/no-cycle` checks static and type-import edges in the maintained source graph. | Read-only; `fmt:fix` and `lint:fix` apply safe fixes. `quality:fix` applies one safe Vite+ pass, then runs quality. Review the diff before committing. |
| `pnpm quality`, `verify`, `verify:full` | Quality runs one read-only `vp check` for format, lint, imports and static/type cycles, then all type projects, the Vite+ Node policy project and i18n. Verify adds versions and production builds/artifact checks; full adds core verification, coverage and `test:e2e:prepared`. | `verify` ends with production `dist` and both extensions. `verify:full` rebuilds the development userscript for E2E; its final `dist` is development-only. Reports and browser fixtures are generated. |
| `pnpm test`, `test:watch`, `test:cov`, `test:ci`, `test:core`, `validate:consistency`                     | Vite+ unit and Node policy projects; `test:ci` runs `scripts/ci/repository-authority.test.ts` and `scripts/release/{verify-source,verify-publication}.test.ts`; `test:core` installs/verifies the pinned core checkout, and consistency selects contract tests.                                                                                                                                                                                                                                              | Watch persists and coverage writes reports; `test:ci` checks repository authority and release source/publication guards, not UI. `test:core` changes submodule dependencies and needs a prepared checkout.                                                                                                                                                                                                                                                                                                                                                                            |
| `pnpm test:e2e`, `test:e2e:headed`, `pretest:e2e`, internal `test:e2e:prepared`                           | Public E2E commands run `pretest:e2e`: rebuild development userscript and all three Chromium and Firefox extension contexts, check `--e2e` artifacts, then run the configured Playwright browser projects. `test:e2e:prepared` is called only after the successful production builds, artifact check, core verification and coverage in the same `verify:full` sequence; it rebuilds development userscript, checks `--e2e` artifacts and runs Playwright with the same config. | Public E2E remains self-contained from absent or stale outputs. The internal path consumes the extension bytes built earlier in that invocation; do not run it standalone or after source/input changes. All E2E paths leave development-only `dist` and write profiles/results/screenshots. Pass Playwright options directly to `pnpm run test:e2e`, for example `pnpm run test:e2e --project=chromium --grep=... --reporter=line`, or use `pnpm run test:e2e:headed -- --project=chromium`. Headed local tests are distinct from source-bound Windows installation/live acceptance. |
| `node validation/windows/prepare-userscript-manager.ts --output <new-directory>`                          | Host-side, manifest-pinned Node 26.12.1 preparation of reviewed Tampermonkey before optional Windows userscript installation; it is not a guest bundle asset.                                                                                                                                                                                                                                                                                                                    | Direct HTTPS to clients2.google.com or clients2.googleusercontent.com, at most five redirects, 60-second deadline and 16 MiB body; verifies pinned SHA-256, CRX3 bounds, all ZIP entries, CRC, 1,000-entry/64 MiB expansion limits and MV3 manifest, then writes an installation receipt by staged rename. Sixteen local fixtures in `test/unit/config/userscript-manager-node.test.ts`; see `validation/windows/README.md` for the Windows installation gate.                                                                                                                        |

The Vite+ `import/no-cycle` rule checks static and type-only edges across the
recursive `src` scope, including the application root, deep settings UI and
separately bundled renderer Worker. It follows configured TypeScript aliases
and resolved imports into the linked core without a depth limit. The normal
`vp check` also passes top-level extension files to Oxlint, so resolved static
cycles there may be reported; extension build and type gates remain separate.
Arbitrary dynamic-only
and mixed static/dynamic cycles no longer have a whole-graph prevention gate.
Keep initialization and Worker-loading behavior tests for their real boundaries.

`pnpm test` and `pnpm test:cov` each run the Vite+ unit project once.
`pnpm test:watch` watches that project and reruns affected tests after edits.
`pnpm test:ci` runs the Vite+ Node policy project once. Policy tests still
spawn raw Node CLIs and Git fixtures where their contracts require them.

Verification success, production files present, and release preparation accepted are separate states. After `verify:full` or standalone E2E, run `pnpm build:all:ci` to restore the production userscript and metadata alongside both extension targets, then `pnpm check:artifacts`. Only then run `RELEASE_VERSION=<package version> pnpm release:prepare` for a local candidate; `prepare.ts` checks source/artifact versions and writes `release-bundle/` without publishing it. A development-only `dist` fails its production-file guard. Rebuild after any source or build-input change, even when old output directories exist.

When reviewing repeated code, check existing module responsibilities and prefer
small changes that preserve lifecycle and security boundaries; avoid an abstraction
that hides distinct behavior. Automated clone detection is retired.

### Workflow and subprocess entrypoints

| Surface | Contract; stage and side effects | Verification / status |
| --- | --- | --- |
| `.github/workflows/ci.yaml`, `security.yaml` changed-path jobs | `scripts/ci/classify-workflow-changes.ts` runs with Node setup, trusted-base materialization for PR/merge-group and protected checked-out source on push. It uses event-specific Git no-renames NUL-safe diffs and writes fixed conservative gate outputs. | `test/unit/config/{workflow-classifier-git,workflow-scope}.test.ts`; verify exact-SHA hosted jobs execute required work. |
| `.github/workflows/security.yaml` pinned tools and OSV | `scripts/ci/pinned-tools.json` owns tool versions/digests; trusted private `pinned-tools.ts` and `check-pinned-tools.ts` provide image env and freshness checks. The independently pinned browser-core `automation/actions/prepare-osv` supplies the private `overlay` OSV helper; `packages/core` is the runtime gitlink. | `test/unit/config/pinned-tools-cli.test.ts`, `test/unit/config/osv-workflow-composition.test.ts`, and provider overlay fixtures; `docs/osv-workflow.md` explains trust order and live-container limits. |
| `.github/workflows/security.yaml` Semgrep SARIF | The pinned scanner runs in its existing container. For exits 0 and 1, the workflow calls the full-SHA-pinned `.github/actions/validate-semgrep-sarif` Action with runner Node 24, then uploads only validated reports. A manual bounded finding fixture exercises status 1 and the upload guard without publishing a synthetic result. | `test/unit/config/{semgrep-sarif-action,semgrep-workflow-composition}.test.ts` covers Action and workflow behavior; inspect an executing exact-SHA hosted container job for runtime and scanner evidence. |
| `.github/workflows/release.yaml` | `scripts/release/verify-source.ts` checks protected tagged source and rejects retired Nose quality scripts before fan-out; `prepare.ts` creates local release files. `scripts/release/verify-publication.ts` guards live Latest ordering, source identity, and existing public assets before the locked publish action; short `run:` blocks select checkout, append outputs and launch actions. | `scripts/release/{verify-source,verify-publication}.test.ts`, `test/unit/config/{release-prepare,release-runtime}.test.ts` and exact-source artifact inspection. Local preparation does not publish. |
| `.github/workflows/dependabot-auto-merge*.yaml`, `update-browser-core.yaml` | Dependabot gate artifact precedes `scripts/ci/dependabot-apply.ts` validation and exact PR/commit rechecks before approval/merge. `scripts/ci/update-browser-core.ts` classifies under read permissions, then a separate writer reprepares the update from trusted `master`, verifies the classified consumer/core/automation identities and live heads, and scopes credentials to the Git push. Pure no-ops skip publication; an open stale PR enters the writer for revalidated cleanup. Runner shell passes event inputs and bounded output/checkout glue. | `test/unit/config/{dependabot-auto-merge,browser-core-automation}.test.ts` and `scripts/ci/repository-authority.test.ts`; hosted exact-SHA checks establish privileged results. |
| `.githooks/pre-commit`, `.githooks/pre-push` | Minimal Git-invoked Bash guards reject detached/default-branch commits and direct default-branch pushes before pinned Node setup. | `test/unit/config/git-hooks.test.ts`. Retained small pre-runtime Git adapter; revisit only if all Git hook invocations can rely on the pinned Node runtime without weakening the refusal. |
| Test subprocess callers | `test/unit/config/{workflow-classifier-git,release-prepare,node-script-boundaries,userscript-manager-node,windows-chrome-process,windows-chrome-profile,windows-firefox-profile,windows-live-duration}.test.ts`, `test/unit/tooling/command-adapters.test.ts`, and `scripts/ci/repository-authority.test.ts` exercise Git, CLI and native TypeScript contracts in fixtures. Provider tests own OSV parser/scanner behavior. | Keep executable paths and NodeNext configs aligned; isolated fixtures do not prove installed browser or public release behavior. |

CI installs Chromium/Firefox and their OS dependencies on every E2E run, then
executes the existing Xvfb E2E path. The browser cache was retired after the
bounded comparison for [issue #232](https://github.com/PiesP/yt-live-chat-overlay/issues/232)
did not establish a useful net benefit. Reconsider caching if runner provisioning,
the browser set or download costs change; compare miss, hit and no-cache runs
before restoring it. Package-manager caches have a separate contract.

Playwright records applicable attempts from the start with `retain-on-failure`
and keeps a trace only for a failed attempt. CI still permits one retry and fails
flaky tests. The pinned runner also records the persistent Chromium context in
`extension.spec.ts`; it owns trace finalization and report attachments, so do not
start a second manual recording. The native Firefox BiDi extension client is
outside Playwright's browser instrumentation and retains its own screenshots
and logs. A crash or termination can leave a trace incomplete or unavailable.
Failed, non-cancelled E2E jobs upload `test-results/` and `playwright-report/`
through the existing diagnostics artifact with seven-day retention. Open the
failed attempt's trace from that report; a retry is separate evidence.

The native Firefox fixture uses the public `puppeteer-core` 25.16.0 API with a
version-pinned pnpm patch. The patch defers loading the unused BiDi-over-CDP
mapper; its scoped dependency override removes `chromium-bidi` and the vulnerable
Zod 3 dependency (GHSA-mrhx-c7xc-m3w5). Native Firefox supplies its own BiDi
endpoint, while Chromium fixtures use Playwright. This package shape supports
that Firefox path only: Puppeteer's CDP mapper and internal type imports are not
supported. The patch does not change the fixture's protocol or cleanup logic,
and installation still enforces release age, provenance and build-script policy.
On a Puppeteer update, review the patch and dependency closure, then run the
Firefox projects, public API type check and full OSV scan. Remove the patch and
override together when an admitted upstream release has a safe mapper closure.

### External Windows bundle and retained languages

`validation/windows/profile.json` lists artifact-only assets, the installation entry, every transitive helper, and the `pnpm` build commands. The external controller supplies portable Windows Node from the exact `volta.node` pin, `playwright-core`, a headed stable browser, and calls `run({ browser, root, output })`. It admits `.mjs` and erasable `.ts` entries, copies declared source bytes without compiling them, verifies source and bundle hashes, and imports the entry with Node's native TypeScript stripping. Use explicit relative `.ts` imports for converted helpers, include each runtime helper in the profile assets, and type-check the Windows source through `tsconfig.windows.json`. The Node boundary suite runs `node --check` over both module formats; existing Windows helper unit tests cover behavior. These local checks do not prove desktop or live-site behavior; the prepared-VM campaign remains the runtime gate.

The userscript-manager preparer is a separately bounded **host** command on the manifest-pinned Node 26.12.1 runtime. Its experimental `node:zlib` ZIP reader passes the existing adversarial archive, direct-transport and staged-cleanup fixtures on that binary. The reviewed CRX's byte-for-byte comparison with the former Python output was performed on Node 26.9.0; it is historical evidence, not a new 26.12.1 extraction receipt. Node 22/24 remain supported for other project routes, but preparation rejects them before network or filesystem mutation. `validation/windows/README.md` records the local tests and the separate source-bound Windows installation gate.

Small workflow shell blocks remain runner bootstrap, checkout, output, and action-launch adapters; revisit them when tested Node entrypoints preserve trusted-source and write ordering. `scripts/release/verify-publication.ts` owns the locked release Latest and existing-asset guard; the workflow invokes it before the publish action.

Git hooks remain Bash because Git invokes them before pinned Node setup. Browser, Git and vendor binaries are tools rather than handwritten project languages.

Use the narrowest relevant check while working, `pnpm verify` before a pull
request and `pnpm verify:full` for publication-level or browser behavior
changes. A fixture run does not establish live YouTube, Windows, hosted-CI or
public-release evidence.

Report each validation stage as executed/passed, executed/failed, intentionally
skipped, blocked/unavailable, or not required, with its command and tested source
revision. Local quality always includes `test:ci`. CI quality owns focused
checks when selected; the unit job runs `test:ci` only when unit is selected
without quality. Full coverage runs independently in the unit job. Bind retained
results to the source/core revisions and tool version, and distinguish fresh
checks from reuse or previously reported evidence that has not been rechecked.

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

## Code style

`vite.config.ts` owns Oxlint and Oxfmt coverage and exceptions. Keep two-space
indentation, 100 columns, LF, single quotes, semicolons, ES5 trailing commas and
parentheses around arrow parameters. Style checks cover supported product, extension, test,
tooling, CI helper and Windows ESM files, plus maintained root configurations.
Generated builds, reports, browser profiles, vendor code and `packages/core`
remain excluded. Vite+ does not validate Python, shell or YAML; retain their
existing boundary checks. HTML fixtures remain excluded from style checks while
the pinned formatter's full HTML support is experimental; browser checks still
load them.

The Vite alias reports the selected Vite+ version and records the bundled Vite
version in its package metadata. Strict peer validation stays enabled.
`pnpm-workspace.yaml` permits only that exact alias
for the reviewed Vitest, mocker and userscript-plugin versions, whose declared
Vite ranges include the bundled implementation. Recheck callers, their original ranges and both
versions together on updates; never widen this to `allowAny`. Validate a fresh
dependency resolution as well as the frozen install, since a migration lockfile
can otherwise hide peer metadata conflicts.

Update the managed toolchain as one unit. Select an exact stable Vite+ release
that has cleared the 24-hour window, then run from the repository root:
Replace `VERSION` in both commands with that selected exact release.

```sh
pnpm dlx --package=vite-plus@VERSION vp help migrate
pnpm dlx --package=vite-plus@VERSION vp migrate --no-interactive --no-agent --no-editor --no-hooks
```

Review the managed Vite alias, bundled Vitest/coverage catalogs, lockfile and
exact peer entries together. Preserve Node/pnpm and hook ownership; finish with
fresh resolution, frozen installation and the maintained quality, build and test
gates. Dependabot keeps Vite+ updates visible for manual alignment review and
excludes only normal version updates of its bundled components. Security alerts
and security updates retain their existing handling. A package-only Vite+ bump
is not an aligned migration and is ineligible for normal automatic merge.
See [project updates](https://viteplus.dev/guide/upgrade-project); global
`vp upgrade` alone does not update the project.

Use `import type` for type-only statements and inline `type` specifiers when
the same module supplies values. Keep side-effect import order and direct-Node
`.ts`/ESM extension requirements. Prefer relative imports within a cohesive
local module and existing aliases across product domains; do not create runtime
barrels just to shorten paths. Safe fixes must converge on a second run.

Keep the recommended lint preset and explicitly stronger correctness and
performance severities. Oxlint type-aware lint is disabled because automatic
project discovery does not cover all six TypeScript contexts reliably;
all six explicit `tsc --noEmit` checks, including `check:windows`, remain
mandatory in `pnpm quality`. Vite+/Oxlint/Oxfmt own routine lint and format
checks across the first-party source, scripts, extension, tooling, Windows helpers
and GitHub Action files. The former Biome-only `noUnusedTemplateLiteral` and
`noImplicitAnyLet` restrictions are retired: no-substitution template literals
and evolving-any locals are no longer rejected separately. Strict TypeScript
`noImplicitAny` does not enforce the retired evolving-any restriction. Native
explicit-any, unused-binding and correctness rules remain active.

Non-null expression assertions are errors in product
and extension code: use checked initialization or guards, or explain a proven
bounded-index invariant at its exact use. Definite-assignment fields have a
different initialization contract. Test assertions and direct Node test mocks
have a narrow override; mock-only `any` and constructor-return exceptions name
their existing test files.

Remaining production exceptions are scoped: control-character regexes sanitize
chat, font names and userscript-manager labels; `void` unions describe browser
callback contracts. The Windows launch adapters deliberately aggregate cleanup
failures in `finally` while preserving the primary failure. Test source strings
may contain literal template placeholders. Static helper classes remain allowed;
this project does not impose class, loop or file-length bans.

Promise-presence checks are not enforcement gates: they can misclassify
serialization, storage and replay code, and `void` alone does not define
rejection handling. Detached
tasks must instead have a reviewed rejection/cancellation policy. Rule trials
and decisions belong in the change's validation evidence.

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

Vite+ keeps ordinary unused-binding/import checks and static/type cycle lint.
Whole-project unused-file, export and dependency reachability are no longer
mandatory checks; local lint, type checking and builds do not prove that those
graph issues are absent. Review touched entry points and dependency ownership
when changing them. A separately requested versioned audit can be run without
adding a recurring second toolchain.

The GitHub Actions updater watches root workflows and
`.github/actions/setup-release/action.yaml`, with independent CodeQL,
`pnpm/action-setup`, and other Actions groups. For each Action SHA update, verify the
full commit against the official upstream release and wait at least 24 hours
from that release. Review changed executable behavior and update independent
allowed-SHA assertions in `test/unit/config/toolchain-action.test.ts` and any
affected workflow tests in the same PR. Never derive the trusted expected SHA
from the workflow or action under test. Preserve the release action's manifest
runtime, v2-compatible inputs, disabled cache, `install: false`, frozen install,
and no-publish boundary; review a major action upgrade's compatibility
explicitly. Run focused toolchain and Dependabot policy tests, `pnpm verify`,
and exact-head CI before merging. Resolve a stale fixture for its specific
update without closing all independent Actions updates. Automation-only pin
maintenance does not change the `packages/core` runtime gitlink.

## Pull requests

Keep changes focused and describe what changed, why it changed, and how it was
validated. Update README or CHANGELOG content when user-visible behavior or
release notes change.

By contributing, you agree that your changes are licensed under the
[project license](./LICENSE).
