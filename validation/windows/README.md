# Windows acceptance profile

`yt-visual` is an artifact-only smoke profile for the common Windows acceptance runner. It
opens a deterministic YouTube watch-page fixture in the runner-provided headed Chrome Stable
or Edge Stable instance, injects the production userscript, exercises the real settings dialog,
and captures the Canvas output for Korean, Japanese, RTL, emoji, Super Chat, and membership
messages.

## Build prerequisite

From this repository, load the workspace Node environment and build the production userscript:

```bash
source /home/piesp/.config/shell/env.sh
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
separate from preference, and deterministic paid and multilingual chat rendering. It does not
install a userscript manager, install an extension, access live or authenticated YouTube, capture
native Windows desktop chrome, validate OS DPI/theme matrices, or measure GPU performance. Those
remain separate acceptance profiles or host-level observations.

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

Prepare the reviewed userscript manager outside the checkout:

```bash
python3 validation/windows/prepare-userscript-manager.py \
  --output /tmp/yt-tampermonkey-5.5.0
```

The helper downloads the official Store CRX and verifies its pinned SHA-256 and
version before extraction. Downloads use direct HTTPS to the approved Store
origins, with at most five redirects; proxy environment variables are not used.
This tests Tampermonkey loaded as an unpacked package,
not the Chrome Web Store installation confirmation. It enables Developer Mode
and Allow User Scripts through Chrome's UI in the isolated profile and imports
the source-bound `.user.js` through Tampermonkey's
real file-import and installation confirmation UI. GM storage remains real.

After committing a clean named checkout and running the repository gates:

```bash
source /home/piesp/.config/shell/env.sh
python3 /home/piesp/projects/windows-acceptance/vmctl.py run \
  --repo "$PWD" --browser chrome --installation extension \
  --output /tmp/yt-chrome-installed
python3 /home/piesp/projects/windows-acceptance/vmctl.py run \
  --repo "$PWD" --browser chrome --installation userscript \
  --manager-directory /tmp/yt-tampermonkey-5.5.0 \
  --output /tmp/yt-userscript-installed
python3 /home/piesp/projects/windows-acceptance/vmctl.py run \
  --repo "$PWD" --browser firefox --installation extension \
  --output /tmp/yt-firefox-installed
```

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
