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

The profile returns JSON checks and observations and writes `yt-visual-canvas.png` and
`yt-visual-page.png`. A missing artifact, failed readiness assertion, page error, console error,
or incomplete render rejects the run.

## Scope

This profile verifies production userscript injection, stable-browser Canvas/font rendering,
one settings interaction, and deterministic paid and multilingual chat rendering. It does not
install a userscript manager, install an extension, access live or authenticated YouTube, capture
native Windows desktop chrome, validate OS DPI/theme matrices, or measure GPU performance. Those
remain separate acceptance profiles or host-level observations.
