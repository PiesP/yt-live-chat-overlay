# OSV workflow ownership and validation

`.github/workflows/security.yaml` runs the `overlay` profile of the pinned
`PiesP/browser-core/automation/actions/prepare-osv` action. The action copies
its fixed TypeScript helper closure to a private runner directory. The
`packages/core` gitlink remains the product runtime dependency and does not
provide the security workflow helper. The scanner image is resolved independently
from the reviewed tool-metadata source by the `pin-metadata` job; failed metadata
preparation fails both OSV jobs even when the changed-path scan would be skipped.

For pull requests, the workflow checks out the target history, switches to the
trusted PR base, initializes that base's submodule, sets up Node without a
dependency install, and prepares the helper. It scans the base, restores the
target and its submodule, scans the target, then reports introduced findings.
For merge groups, the Node setup and helper preparation use the merge-group
base manifest before restoring the target for a full scan. Push, schedule, and
manual runs verify the checked-out SHA against the event SHA before setup.
The helper remains in private runner storage across the target checkout.

The retired overlay Python validator and workflow execution fixtures map to
the provider's tests as follows. The provider tests exercise the real CLI with
fake Docker; this repository's `osv-workflow-composition.test.ts` exercises the
actual workflow wiring, conditions, trust order, helper output path, and CLI
modes without loading code from another checkout.

| Retired overlay coverage | Provider fixture coverage |
| --- | --- |
| Valid findings, formerly excepted IDs, and unknown scanner metadata are preserved | `test/scripts/osv-validator.test.ts`: `validates findings with profile overlay without filtering`, `preserves unknown metadata integer lexemes exactly` |
| Malformed JSON, duplicate keys, non-finite values, overflowing numbers, missing or wrong-shaped results, and stale output removal | `test/scripts/osv-validator.test.ts`: strict JSON parser cases and `removes stale output on invalid input`, including malformed result shapes |
| Missing source, invalid package fields, missing vulnerability ID, invalid groups and aliases | `test/scripts/osv-validator.test.ts`: overlay schema, malformed nested package records, and malformed result shapes in `removes stale output on invalid input` |
| Input/output same-path and hardlink alias protection | `test/scripts/osv-validator.test.ts`: same, relative, hardlink, symlink, and parent-symlink alias matrix |
| Trusted validator materialization at PR base and merge-group base | `test/scripts/prepare-osv-helper.test.ts`: fixed private closure, byte equality, symlink rejection, partial-copy cleanup; local composition test checks base-before-action order |
| Scanner status 0 or 1, stale raw/normalized output, missing or malformed raw output, reporter parse diagnostics, and nonzero or signaled Docker | `test/scripts/consumer-workflow.test.ts`: scan mode argv, stale output, scanner/raw-reporter failures, parse diagnostics, signal propagation, and log replacement |
| PR diff and full reporter argv, valid SARIF, vulnerability exit 1, malformed SARIF, reporter failures, and upload authorization | `test/scripts/consumer-workflow.test.ts`: report-pr/report-full argv, SARIF and status cases, invalid inputs, output-write failure, and replaced-log cases; local composition test checks upload condition |

The retired workflow test also had optional real-container reporter cases gated
by `OSV_TEST_CONTAINER_RUNTIME`. Those are runtime evidence, separate from the
unit and workflow-composition checks above; do not count a fake-Docker test as
a real-container run.

The provider overlay validator additionally checks optional vulnerability metadata,
including timestamps, text, list, and object fields. The overlay scanner test
checks that this profile remains distinct from the consumer profile.
