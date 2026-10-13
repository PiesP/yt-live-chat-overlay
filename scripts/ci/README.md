# Workflow change classification

`classify-workflow-changes.ts` uses only Node.js built-ins. CI and Security set
up the manifest-pinned Node runtime without installing dependencies, then run
the CLI from the trusted base revision for pull requests and merge groups.
If the trusted base lacks the classifier, the callers select all 12 scopes.
Failed checkout, runtime setup, or classification also selects every scope. Pushes run the checked-out CLI.

The CLI accepts `--paths` for explicit policy checks. Event comparisons use
`BASE_SHA...HEAD_SHA` for pull requests and merge groups and
`BASE_SHA..HEAD_SHA` for pushes. Git paths are NUL-delimited with rename
detection disabled, preserving both sides of a move. It prints all 12 outputs
and appends them to `GITHUB_OUTPUT` when set.

# Pinned security tools

`pinned-tools.json` records OSV scanner and Semgrep versions and image digests.
The dependency-free `check-pinned-tools.ts` checks the newest stable GitHub
release older than 24 hours and the OSV tag's GHCR manifest digest. Version
drift warns; missing metadata, API failure, or digest drift fails. It continues
checking later pins after an earlier failure. `pinned-tools.ts env` writes
validated image references to `GITHUB_ENV` and accepts no metadata path. Both
modules are inert on import.

The security workflow resolves scanner images and freshness checks from the
immutable reviewed `83364ae1027cf6b1761a91dcb855ea9a95c8886c` revision.
Each job sets up Node before running a private copy of the helpers. The
privileged security jobs never run candidate PR helper code. Repin only to a
reviewed, published full commit. The focused CLI fixture test is
`test/unit/config/pinned-tools-cli.test.ts`.

CI runs `test:ci` within quality when quality is selected. When only unit is
selected, the unit job runs it before independent full coverage. A failed or
unavailable owner is not a completed check. Local `pnpm quality` always runs
`test:ci`. Protected release-source verification rejects tags whose quality
scripts still invoke retired Nose tooling before any validation job starts.

# Deep code-analysis reuse

The scheduled deep workflow may reuse successful fast or renderer mutation
results for unchanged tracked bytes, file modes, gitlinks, configuration, locks,
declared Node/pnpm versions, pinned tools/actions, gate,
OS, architecture, ImageOS, and runner label. Manual runs default to fresh
analysis; `reuse_success=true` opts in. Unknown runner identity, missing or
corrupt markers, and cache failures run fresh.

Eligible successful default-branch runs attempt to save an immutable version 3
marker with their run ID, attempt, SHA, and analysis time. Cache publication is
best-effort. Before reuse, the workflow checks the origin and every later
selected gate against bounded, paginated Actions history. A
later failed, cancelled, or unfinished gate, a rerun, or unavailable history
runs fresh. A successful fresh pass can replace an invalidated result on the
next schedule. Fast and renderer mutation success is recorded only after the
respective required report upload succeeds.

The run summary estimates avoided analysis time from the prior successful
gate's check step when Actions provides valid step timing. It excludes cache
restore, provenance API calls, setup, report uploads, and all other workflow
overhead. This estimate is not a measure of net runtime savings or billed time.

This is bounded reuse of a code-analysis result. Ubuntu image build revisions
(`ImageVersion`) are recorded as provenance but excluded from the key, allowing
weekly image refreshes at the same platform and label. It does not certify an
identical execution environment. Force a fresh manual run when investigating
runner or tool behavior. Security intelligence and external browser
compatibility checks retain their existing triggers and do not use this marker.

The early setup pins Node and pnpm without installing dependencies. A fresh
mutation run uses the normal frozen dependency setup. Local regression checks:
`pnpm test:ci` and `pnpm check:scripts`.

Reruns (`GITHUB_RUN_ATTEMPT > 1`) always analyze selected gates afresh, including
scheduled runs and manual reuse opt-ins. Actions run listings expose only the
latest attempt, so excluding the current attempt can hide its prior failures.
A successful fresh rerun may still publish its own marker for a later run's
first-attempt reuse.
