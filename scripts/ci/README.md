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
