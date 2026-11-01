# Workflow change classification

`classify-workflow-changes.ts` uses only Node.js built-ins. CI and Security set
up the manifest-pinned Node runtime without installing dependencies, then run
the CLI from the trusted base revision for pull requests and merge groups.
If the trusted base lacks the classifier, the callers select all 11 scopes.
Failed checkout, runtime setup, or classification also selects every scope. Pushes run the checked-out CLI.

The CLI accepts `--paths` for explicit policy checks. Event comparisons use
`BASE_SHA...HEAD_SHA` for pull requests and merge groups and
`BASE_SHA..HEAD_SHA` for pushes. Git paths are NUL-delimited with rename
detection disabled, preserving both sides of a move. It prints all 11 outputs
and appends them to `GITHUB_OUTPUT` when set.

# Pinned security tools

`pinned-tools.json` records OSV scanner and Semgrep versions and image digests.
The reviewed `browser-core/automation/actions/prepare-scanner-pins` Action
copies its dependency-free CLI into private runner storage. The security
workflow separately copies this repository's reviewed JSON to a private file
and passes its absolute path to both `env` and `check`. `env` writes validated
image references to `GITHUB_ENV`; `check` checks stable GitHub releases older
than 24 hours and the OSV tag's GHCR manifest digest. Version drift warns;
invalid metadata, API failure, or digest drift fails. Later checks continue
after an earlier failure.

The workflow pins consumer data at
`e61b85b0c31bc0dc1d526f43eb5ee158a512c3be` and provider code at
`4ab0442d8d2e3cf640767b499b6444c92f6479b5`, independently by full SHA.
Both paths run after the selected Node setup, and no scanner code or pin data
comes from a candidate PR checkout. The provider snapshots in
`test/fixtures/scanner-provider/` are test-only copies from the reviewed Action
revision. `test/unit/config/pinned-tools-cli.test.ts` checks their byte hashes
and exercises the real Action preparation and CLI without changing the runtime
`packages/core` gitlink. The workflow Action SHA and caller paths are checked by
`test/unit/config/scanner-pin-workflow.test.ts`.

CI runs `test:ci` within quality when quality is selected. When only unit is
selected, the unit job runs it before independent full coverage. A failed or
unavailable owner is not a completed check. Local `pnpm quality` always runs
the Vite+ Node policy `test:ci` project. Protected release-source verification
rejects tags whose quality scripts still invoke retired Nose tooling before any
validation job starts.
