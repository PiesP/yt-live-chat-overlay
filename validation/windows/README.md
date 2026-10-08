# Windows acceptance profile

This validation has four separate evidence tiers. None substitutes for another.

1. **Artifact-only smoke (`yt-visual`):** injects the production userscript into
   a deterministic fixture and checks stable-browser Canvas rendering and
   lifecycle handling.
2. **Short installed-package smoke:** installs the real extension or userscript
   in a fresh task-owned browser profile and checks a deterministic fixture. It
   does not establish native tab visibility or a sustained observation period.
3. **Duration observation:** runs the installed Chrome extension for five
   minutes visible, ten minutes natively hidden, and five minutes visible after
   resume. This is separate from the short installed smoke.
4. **Optional public-page observation:** inspects selected unchanged public
   YouTube pages after the deterministic fixture and can remain unverified when
   chat is unavailable.

## Artifact-only smoke

`yt-visual` is an artifact-only smoke profile for the common Windows acceptance runner. It
opens a deterministic YouTube watch-page fixture in the runner-provided headed Chrome Stable
or Edge Stable instance, injects the production userscript, exercises the real settings dialog,
and captures the Canvas output for Korean, Japanese, RTL, emoji, Super Chat, and membership
messages.

## Build prerequisite

From this repository, use the pinned Node toolchain to build the production userscript:

```bash
pnpm build:ci
```

The bundle producer must include every path listed in `profile.json`. The common runner supplies
portable Windows Node, `playwright-core`, a launched headed stable browser, and the extracted
bundle and artifact output paths to `run({ browser, root, output })`.

The profile returns JSON checks and observations and captures the basic settings, adjusted
preview, Canvas, and page. The injected userscript fixture selects the main-thread fallback
and additionally captures `yt-paid-card-ink.png`: an isolated outlined Super Chat body must
use cached bitmap rendering without ink beyond its right card boundary. Author and amount
labels are hidden for that check so they cannot satisfy the cached-body assertion.
A missing artifact, failed readiness assertion, page error, console error, or incomplete
render rejects the run.

## Scope

This profile verifies production userscript injection, stable-browser Canvas/font rendering,
keyboard disclosure interaction, the opacity/outline/safe-zone preview, translation capability
separate from preference, and deterministic paid and multilingual chat rendering. It also runs one
connected production-runtime fixture through low-rate and burst ingress, video pause and seek,
synthetic hidden/visible plus `pageshow` delivery, and an SPA transition to a different video. The
fixture checks the exact duplicate-free accessible message ID set, phase membership, pause-drop
counters, and old Canvas/session teardown. Canvas lane and collision admission can activate and
announce equal-priority messages in a different order from ingress. The installed-extension lane
therefore checks strict Worker `addMessages` ingress order separately, in addition to Worker
acknowledgement, termination, and replacement readiness. It does not
install a userscript manager, install an extension, access live or authenticated YouTube, capture
native Windows desktop chrome, validate OS DPI/theme matrices, or measure GPU performance. Those
remain separate acceptance profiles or host-level observations.

The installed Chrome/Edge Worker fixture also checks sustained high-activity
polling. It saves a positive minimum through the settings UI, delivers enough
unique batches to fill the density window, records request/response timestamps
and concurrent requests, then verifies ordinary polling resumes after an empty
response. `profile.mjs` records the fixture sizes and network-event tolerance;
fake-time `source-live.test.ts` assertions cover exact timer boundaries. This
scenario uses intercepted fixture traffic rather than a live chat account.

The settings fixture also exercises independent font group and input names,
keyboard weight/preset/custom edits, preview font updates, and the existing
motion override without changing its saved representation. It retains settings
captures and geometry for dark appearance, Forced Colors and reduced-motion
media emulation, and a narrow Arabic RTL view. Installed Chrome/Edge runs add
200% browser tab zoom using the installed package's Tabs API on the exact
fixture tab, verify the reported zoom, and restore it before continuing.
Artifact-only runs explicitly leave browser zoom unverified. These automated
observations do not establish physical DPI or screen-reader acceptance.

The deterministic synthetic visibility transition proves lifecycle handling only. It is not
evidence of native tab occlusion, browser freezing, pixel equivalence between the main and Worker
renderers, or sustained live-site performance; the duration profile remains the native
visible-hidden-visible observation.

## Installed application profiles

The common Windows controller also supports opt-in `--installation extension`
and `--installation userscript`. These profiles use a fresh, task-owned browser
profile and install actual packages. They do not supply application JavaScript,
GM mocks, or an extension bridge through `addInitScript`.

Chrome/Edge installation uses a persistent context and the experimental CDP
`Extensions.loadUnpacked` command over Playwright's debugging pipe. The
`--enable-unsafe-extension-debugging` launch flag applies only to that isolated
browser. The extension is explicitly uninstalled before browser/profile cleanup.
Firefox uses the installed system executable and native WebDriver BiDi temporary
installation; it does not require Playwright's patched Firefox executable.

The optional duration observation is a separate, exact contract: headed Chrome,
the unpacked extension, one existing public `https://www.youtube.com/watch?v=...`
or `https://www.youtube.com/live/VIDEO_ID` URL admitted by the controller, and
`{ "mode": "duration", "duration_seconds": 1200 }`. It runs the
deterministic installed-extension fixture first. It then starts a task-owned Chrome
process with muted audio and loopback DevTools, attaches with Playwright launch
defaults disabled, and observes five minutes visible, ten minutes natively hidden
behind a second real tab, and five minutes visible after resume. Thirty-second
checkpoints retain media, Canvas, bridge, renderer, native visibility, normalized
player-error UI, and accessible-render fingerprint evidence. Public chat volume is
uncontrolled, so a stream with no accessible chat is recorded as unverified. The
structured observation records only chat counts and fingerprints. It does not
retain raw chat text.

Phase summaries report `mediaTimeRangeSeconds`, the difference between the largest
and smallest finite sampled media positions, or `null` with fewer than two positions.
This range includes seeks and timeline resets; it does not measure playback progress
or watch time. Older records named this field `mediaProgressSeconds` and must be
interpreted as the same position range. Phase health is checked separately.

Chat message counts and fingerprints describe observed accessible-render activity.
`mediaTimeRangeSeconds` describes the sampled media-position range.
The five-minute, ten-minute, and five-minute phases describe the profile's
wall-clock observation schedule. They do not establish actual viewer attention
or viewing time. These measurements do not substitute for one another.

The ordinary short installation flow keeps the persistent-context launcher and
does not establish native tab visibility. Both Chrome launch paths use
`--mute-audio`. A duration run closes the owned browser before removing its fresh
profile; if exact process exit cannot be established, it preserves the profile and
fails cleanup.

Prepare the reviewed userscript manager outside the checkout:

```bash
python3 validation/windows/prepare-userscript-manager.py \
  --output /tmp/yt-tampermonkey-5.5.0
```

This is a host-side preparation step before VM installation, not an asset bundled
in `profile.json` or code run by the Windows profile. The Python 3 standard-library
helper owns the reviewed Tampermonkey 5.5.0 version, extension ID, exact Store URL,
and SHA-256 pin. Importing the module only defines the preparer; network and
filesystem work starts when `prepare()` is called or the CLI runs. The CLI takes
`--output` as its only operational input, refuses an existing destination before
downloading, and prints the new directory, version, and digest as JSON.

The helper downloads through direct HTTPS to `clients2.google.com` or
`clients2.googleusercontent.com` on port 443, without credentials, proxies, or
automatic redirects. It checks each redirect (at most five), applies a 60-second
request timeout, and limits the final body to 16 MiB. It verifies the pinned
SHA-256 and CRX3 header bounds before using Python's `zipfile`; extraction checks
at most 1,000 entries and 64 MiB of declared uncompressed size, rejecting
absolute, parent-traversal, backslash, colon, and symlink entries. It validates
entries before omitting `_metadata`, checks the manifest for version 5.5.0 and
Manifest V3, writes `installation-source.json` with Store identity, URL, digest,
method, and omission, then atomically renames a new staging directory into
place. Failures remove that staging directory.

The thirteen local tests in `test/unit/config/userscript-manager-package.test.ts`
cover a fixture package and receipt, pin mismatch, existing output, traversal,
approved and rejected redirects, redirect count, HTTP/body limits, and transport
failure without live downloads. They also reject wrong manager/manifest versions,
invalid CRX headers, corrupt/truncated ZIP payloads, symlink entries, excessive
entry counts and declared expanded sizes. Extraction, receipt-write and final
rename failure fixtures verify staging cleanup and preservation of unrelated
files. They do not establish duplicate-entry behavior, actual expanded-byte
limits, or VM installation. The manifest-pinned Node runtime has
no ZIP archive reader in its standard modules, and this repository has no
reviewed ZIP package. Keep the Python exception until a reviewed, pinned ZIP
reader can be supplied by the portable host contract.
Revisit the migration with adversarial archive and transport fixtures plus
source-bound Windows validation; do not add a guest runtime just to change the
helper's language.

This tests Tampermonkey loaded as an unpacked package,
not the Chrome Web Store installation confirmation. It enables Developer Mode
and Allow User Scripts through Chrome's UI in the isolated profile and imports
the source-bound `.user.js` through Tampermonkey's
real file-import and installation confirmation UI. GM storage remains real.

After committing a clean named checkout and running the repository gates, use
the configured controller in the prepared Windows validation environment. Run
the Chrome or Edge extension, userscript-manager, and Firefox extension profiles
as separate invocations with separate task-owned profiles and evidence output
outside the checkout.

Use separate invocations/profiles so the extension and userscript cannot mask
each other's behavior. Add repeatable `--live-url https://www.youtube.com/watch?v=...`
arguments (up to three per run) to inspect public watch pages after the
deterministic fixture phase. Select currently playable broadcasts or recordings
with chat replay; old broadcast URLs may no longer be available.
These observations never mock site responses or post chat. Inspect each live
result separately: chat absence, consent/login, network failure, and renderer
failure rejects the run unless every requested page proves chat rendering.
Screenshots and
logs remain external and source-bound. Fixture persistence assertions reload the
page through the actual installation rather than injecting saved settings.

Installed-extension fixtures require a running Worker. Their Canvas screenshots cover the
shared renderer visually; the main-thread-only pixel probe is not run in the Worker fixture. Public-page observations
also accept the application's main-thread fallback when the page reports a
Trusted Types restriction; the result records `workerPolicyFallback` explicitly.
Both paths must render real chat into the attached Canvas overlay.
Known native YouTube media, ad-pixel, and site-module network errors are counted
separately from unexpected application errors. Signed URL query strings are
removed from retained diagnostics.

Run VM packaging and local E2E serially: both build into the same distribution
directories, and production packaging replaces the development userscript that
E2E requires.
