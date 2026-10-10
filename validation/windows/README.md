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

Installed Edge extension runs also execute `placement-timing.mjs` after the
ordinary fixture, in separate task-owned pages. These pages select a 32px font
and full safe zone initially, then restore a cloned prior settings snapshot.
A geometry sample marks future reservations separately from currently visible
messages; a reserved fixed rectangle is not an already painted overlap. One page observes the actual
packaged OffscreenCanvas Worker; the other makes
`transferControlToOffscreen()` fail before transfer so the application takes its
normal Canvas fallback. Both pages use the normal extension, chat response
parser, runtime, and renderer with routed, bounded text and paid-card messages.
The Worker page prefixes and suffixes a probe around the page-origin Blob built
from the packaged Worker source. The original Worker code runs between them;
the suffix attaches to the renderer instance only when the emitted handler
matches the expected shape. Bundle drift fails the fixture. The probe records
bounded exact Worker render/drain durations, queue residence for fixture IDs,
placement and collision rejection counts, active-message coordinates, work
before the first overlay clear, fixture text ink bounds, first sampled nonzero-alpha draw, committed geometric entry,
Worker queue receipts, and a screenshot. It does not change production source
or add application telemetry. The Canvas page records draw data on the main
thread. Ink bounds use backing-store pixels, including the canvas transform.
Observed draw samples require nonzero canvas alpha and include fade and frame
quantization; they do not establish a human readability threshold. Paid body
ink has its own fixture token and must enter the viewport in both renderer paths; committed geometric
entry is recorded separately from the final motion plan or the baseline
committed constant-speed path. Replay accessibility entry also records video
time minus source offset. The first-entry clock is
`performance.timeOrigin + performance.now()` in each realm; compare only samples
from the same run and inspect any clock disagreement before interpreting a
cross-realm latency. `preClearWorkMs` includes drain and cleanup, so it is a
work proxy; `exactWorkerDrainMs` is the wrapped drain method's duration. Text
ink rectangles exclude paid card backgrounds and do not by themselves prove
reservation safety. Collision rejection counts are attempted placements, not
distinct dropped messages. Final drops retain the production reason; baseline
reasons are inferred from the calling phase and unknown drops remain `other`.
The probe forwards every production method argument and respects `trackDrops`.

The focused #195/#196 `worker-spacing-speed` and `main-spacing-speed` scenarios
reuse this installed extension fixture. The page remains a 1280×720 watch
fixture and records the actual video rectangle, logical viewport, DPR and canvas
backing store. A bounded Japanese regular-comment stream runs at configured
32px with a transparent normal background and enabled outline. The fixture
checks at least two accessible snippets because each renderer mirrors at most
ten active messages per update; targeted canvas paint observations verify
entry separately. Captures at Lane Gap 0 and 8 include sampled fill/outline
ink and font, committed message height, the compiled page bundle's shared
regular insets, lane height, slot count, actual y positions, allocation pitch,
and current-frame visible row pitch, plus active/queue peaks and drops. The
allocation pitch uses positive active row-origin differences and can include
future or offscreen rows. Visible pitch uses distinct row origins that are
time-eligible, onscreen, and joined by ID to successful positive-alpha draws
in one completed frame. Each frame records its ID, start/end epoch, logical
viewport, backing-store ratio, phase settings, active rows, normalized draw
rectangles, and bounded Japanese glyph ink extents. A missing, incoherent, or
truncated frame yields `null` with a reason; historical aggregate ink cannot
fill that gap. The fixture waits for two Japanese glyph draws to intersect the
logical viewport before each gap capture. The default spread allocator can
leave legitimate empty lanes; neither pitch is an assumed `laneHeight`
formula. The Worker inset receipt is computed by that
same compiled page helper used for serialization; Worker paint is observed
separately through its image/ink samples. The existing settings dialog is exercised by
keyboard on its slider, Done, Escape, reopen, preview row metadata and an
extension-storage readback. The preview reports two rows and its reserved
pitch in `data-preview-rows`, `data-preview-row-height` and
`data-preview-row-pitch` on the existing preview text element.

An optional run can name only the two spacing scenarios and set
`spacingOnly: true` to stop after the gap-8 capture. Default runs still
exercise all eleven scenarios, including Backlog and recovery.

The speed phase routes 51 chat actions through the normal response parser to
trigger Backlog injection, then four ordinary actions through the same parser
to raise the burst detector. The fixture grows its video player from the
initial 860px CSS cap to 1000px during resize and requires the logical video
dimensions to grow while the same Backlog ID stays active. Lane Gap 0 and 8
were already sampled before the burst, and the settings slider exercises the
gap again after recovery. One Backlog message has long Japanese text so its
committed duration remains between the configured
5–30 second bounds. The receipt keeps its serialized burst multiplier
(Worker), committed travel distance, actual velocity, duration, geometric entry/exit, queue residence,
resize reflow and pause/resume observations. An observed Worker error
event exercises the application's recovery into Canvas; public YouTube traffic
is never altered. A private source-bound probe is inserted into the packaged
`page-script.js` closure before its ordinary `main()` call to observe Canvas
internals. The original app source executes intact; a changed closure/class
shape fails the scenario. Worker instrumentation uses the existing Blob
prefix/suffix guard. These additive probes can affect timings, so the recorded
frame work is diagnostic rather than a general performance claim.

For a baseline comparison, make a baseline-only harness commit that changes
`const comparisonOnly = false` to `true` in `chrome-install.mjs`. Keep the
`placement-timing.mjs` probe bytes identical to the candidate harness and
record both source and bundle hashes with the receipts. The baseline receipt
sets `comparisonOnly: true`; it still requires the real parser, renderer,
Backlog activation, unclamped geometry and source guards, while allowing the
old two-slot row and extra Worker burst acceleration. Both baseline and
candidate require same-ID retention through actual video resize and
Worker-to-Canvas recovery. The candidate commit keeps the constant `false`
and applies strict spacing and speed assertions. Preserve
both attempts and their source, bundle and probe hashes outside Git. Do not
interpret a `comparisonOnly` pass as a fix or substitute it for candidate
acceptance. The ordinary real-YouTube smoke retains its existing route and
scope.

For issue #193 performance comparison, run baseline and final source in the
same prepared VM, installed Edge version, profile mode, viewport, fixture, and
probe revision. Retain both source and bundle hashes and compare the reported
first-entry latencies and frame-work percentiles alongside Worker queue receipts
and screenshots. Report absent draw samples or Worker startup as unverified;
do not infer a performance gain from a single screenshot or a formula change.
The replay fixture holds video time at 10000, 10001, and 11500 ms and checks
the corresponding accessibility entries using routed replay continuation
actions. Separate installed Worker pages exercise top and bottom placement,
system reduced motion on/off and its user override on/off on existing active
messages, checking their effective motion and visible non-overlap; active viewport resize,
safe-zone/font/lane-density
shrink and expansion, and a queue cap of 50 with active cap of 30. The
congestion page requires an observed pending depth of at least 50 and an
activation with zero temporal and geometric entry delay at that depth.
Exact frame/drain samples reset immediately before this bounded pressure batch
to prevent initial idle frames from consuming the sample cap. A single 50-message batch uses
unique fixture authors, a 16px font and the full safe zone to keep initial
lane utilization below the existing backlog throttle. It remains within the
runtime live-batch boundary; the setting itself does not prove
queue pressure. The translation page sends one bounded test-only
`updateTranslation` through the production Worker protocol for a fixture ID,
checks active geometry reflow, then sends a bounded removal update. It does not prove translation-provider
availability. Each variant records its own status; any failed assertion makes
the installed Edge fixture fail. The pages are synthetic parser/runtime checks
until run in the prepared VM.

For every supplied public URL, the installed browser observer checks startup,
real video pause/resume and an in-range seek, then navigates to the next URL
(or reloads when only one URL is supplied) and checks chat, Canvas, and the
renderer again. No site response or chat content is substituted. The receipt
labels live versus replay from the site's chat renderer and retains a separate
status and bounded provider/access reason for each page. Two or more public
URLs in an Edge extension run must cover both live and replay plus cross-watch
navigation; blocked chat, login/consent, unavailable playback, missing seek
range, and unknown chat mode remain `unverified` rather than a pass. Without
public URLs, this real-site tier is untested even if the synthetic fixture passes.

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
