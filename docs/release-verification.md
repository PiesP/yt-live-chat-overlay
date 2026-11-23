# Release verification notes

Use this procedure when a release note describes tested browser behavior or
installation coverage. `scripts/release/prepare.ts` builds
`release-bundle/release/RELEASE_NOTES.md` from the version's `CHANGELOG.md`
entry and build metadata. `.github/workflows/release.yaml` publishes that file
as the initial GitHub Release body. Those files describe preparation and
publication; they do not establish which live or installed flows executed.

## Prepare a version-specific coverage note

1. Create a new `docs/releases/v<version>-verification.md` for the release.
   Record its evidence date, exact tag/source commit, shared-core commit and
   public artifact identity or links. Do not copy an earlier version's success
   claims into the new note.
2. Link the release's admission, execution and closeout records. For each
   browser/distribution route, label **executed**, **reused** or **unverified**.
   State the browser version, public site versus controlled fixture, renderer
   path, tested interactions and relevant failed prerequisites. Distinguish
   manual replacement from automatic update discovery; distinguish full
   document navigation from same-document navigation.
3. Review the generated notes and the draft coverage text together. Keep
   installation instructions, changelog and build details in their existing
   generated section. The coverage text should state only evidence supported by
   that release's records, with links to the detailed reports. Verify links and
   the rendered Markdown before publication. After the maintained workflow
   publishes its generated notes, the release owner appends the reviewed
   coverage text using the next step. Neither `prepare.ts` nor the workflow
   includes the draft automatically.
4. Before adding coverage to the published description, capture the original release body
   and asset IDs, names, sizes and digests first. Append a dated heading and the
   reviewed text to the body, preserving the original text, tag and assets.
   Read back the release body, links, tag and asset identities. Record the
   addendum separately: any original CI-note byte equality applies to the
   original body, not the edited body.

Use this outline for each new version; replace every bracketed field with
evidence from that version:

```markdown
## Verification coverage and known limits — [YYYY-MM-DD addendum, if later]

Source: [tag and commit]; core: [commit]; artifacts: [release or asset links].
Evidence: [dated admission/execution/closeout links].

- Executed: [browser/version, public or fixture route, renderer, interactions].
- Reused: [older source/artifact and the exact unchanged predicate, if any].
- Unverified or failed: [prerequisite, platform, navigation and update limits].
```

The [v0.46.0 coverage note](./releases/v0.46.0-verification.md) is a scoped
example, not a standing acceptance claim for later versions.

## Verify notices in published packages

For the first release containing [#482](https://github.com/PiesP/yt-live-chat-overlay/pull/482)
and subsequent releases, download the public files. From a clean checkout of the
released tag, set `TAG` and `RELEASE_SHA` to the tag and full commit SHA in the
publication receipt. Run this in Bash with a supported Node.js version, GitHub
CLI and `unzip`.

```bash
set -eu
: "${TAG:?Set TAG from the publication receipt}" "${RELEASE_SHA:?Set RELEASE_SHA from the receipt}"
test "$(git rev-parse HEAD)" = "$RELEASE_SHA"
test "$(git rev-parse "$TAG^{commit}")" = "$RELEASE_SHA"
out=$(mktemp -d)
gh release download "$TAG" --repo PiesP/yt-live-chat-overlay --dir "$out"
node --experimental-strip-types --input-type=module - "$out" <<'NODE'
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertDistributionNotice, assertNoticeFile, NOTICE_FILES,
} from './tooling/vite/distribution-notices.ts';

const dir = process.argv[2];
const prefix = 'yt-live-chat-overlay';
const user = `${prefix}.user.js`;
const archives = ['chrome', 'firefox'].map(browser => `${prefix}-${browser}.zip`);
for (const name of [user, ...archives]) {
  const bytes = readFileSync(join(dir, name));
  console.log(name, bytes.length, createHash('sha256').update(bytes).digest('hex'));
}

const script = readFileSync(join(dir, user), 'utf8');
assert.ok(script.startsWith('// ==UserScript=='), `${user}: metadata must be first`);
assertDistributionNotice(script, user);
for (const archive of archives) {
  const member = name => execFileSync('unzip', ['-p', join(dir, archive), name], {
    maxBuffer: 64 * 1024 * 1024,
  });
  for (const name of NOTICE_FILES) assertNoticeFile(member(name), name, archive);
  for (const name of ['page-script.js', 'workers/renderer.js']) {
    assertDistributionNotice(member(name).toString('utf8'), `${archive}/${name}`);
  }
}
NODE
```

Compare all three printed byte counts and SHA-256 digests with the recorded
publication receipt. A pass requires all three matches and a successful script
exit. The tagged sources supply the complete project, browser-core, bidi-js and
Unicode notices. The two archive-root notice files are checked byte for byte in
each ZIP. The metadata-only `.meta.js` has no bundled tables.

In [#483](https://github.com/PiesP/yt-live-chat-overlay/issues/483), link the
public release and receipt. Record the three output rows and the results for
the standalone userscript and both archives’ page scripts and renderer workers.
Identify the affected asset and member if a comparison fails.
