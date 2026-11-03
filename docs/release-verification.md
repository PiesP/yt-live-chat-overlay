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
