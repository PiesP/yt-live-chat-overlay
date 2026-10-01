# Deep code-analysis reuse

The scheduled deep workflow may reuse successful duplication, fast mutation, or
renderer mutation results for unchanged tracked bytes, file modes, gitlinks,
configuration, locks, declared Node/pnpm versions, pinned tools/actions, gate,
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
mutation run uses the normal frozen dependency setup; duplication installs Nose
only when it runs. Local regression checks: `pnpm test:ci` and
`pnpm check:scripts`.

Reruns (`GITHUB_RUN_ATTEMPT > 1`) always analyze selected gates afresh, including
scheduled runs and manual reuse opt-ins. Actions run listings expose only the
latest attempt, so excluding the current attempt can hide its prior failures.
A successful fresh rerun may still publish its own marker for a later run's
first-attempt reuse.
