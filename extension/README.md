# Browser extension

The project builds Manifest V3 packages for Chromium and Firefox from the same
application source as the userscript. Release archives are developer builds,
not browser-store installations.

## Architecture

- `manifest.json`: Chromium manifest
- `manifest.firefox.json`: Firefox manifest and minimum version
- `content-script.ts`: isolated-world entry point and storage relay
- `page-bridge.ts`: typed bridge shared with the injected page script
- `background.ts`: context menu and extension lifecycle handling
- `src/platform/`: storage, menu, worker, cross-tab, language, and translation adapters

The isolated content script injects a small `page-script.js` bridge into the
YouTube page's main world. Messages crossing that boundary use the versioned
bridge protocol; extension APIs remain in the isolated or background context.

| Capability | Userscript | Chromium extension | Firefox extension |
| --- | --- | --- | --- |
| Storage | Userscript manager `GM_*` storage | Extension local storage | Extension local storage |
| Cross-tab sync | Userscript value-change listener | Extension storage events | Extension storage events |
| Menu | Userscript menu command | Context menu | Context menu |
| Worker URL | Bundled userscript URL | `runtime.getURL()` | `runtime.getURL()` |
| Translation | When the browser exposes Translator | When Chromium exposes Translator | Unavailable |

## Build

```bash
pnpm build:extension
pnpm build:extension:firefox
pnpm build:all:ci
```

Outputs are written to `dist-extension/` and `dist-extension-firefox/`. The
all-target CI build also validates expected files through `check:artifacts`.

## Load during development

### Chrome, Edge, or Brave

1. Run `pnpm build:extension`.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Select **Load unpacked** and choose `dist-extension/`.

### Firefox

1. Run `pnpm build:extension:firefox`.
2. Open `about:debugging#/runtime/this-firefox`.
3. Select **Load Temporary Add-on** and choose
   `dist-extension-firefox/manifest.json`.

The Firefox installation is removed when the browser restarts.

Firefox 128 is the manifest's technical compatibility floor. It does not mean
that Firefox 128 is still a serviced ESR; development and release checks should
use a currently supported Firefox release.

## Browser validation

Playwright loads the real unpacked Chromium extension. Its Firefox project runs
the shipped userscript bundle in Firefox because Playwright does not provide an
equivalent fixture for loading a temporary Firefox extension. That lane covers
Gecko startup, chat ingestion, and Canvas rendering, but it does not validate
the Firefox manifest, content-script injection, extension storage, or menus in
an installed extension context.

Before publishing a Firefox archive, load `dist-extension-firefox/manifest.json`
as a temporary add-on in a currently supported Firefox release and verify:

1. The content script injects the overlay on a YouTube live or replay page.
2. Settings persist through extension storage and the settings menu opens.
3. Chat renders without unexpected errors in the page and extension consoles.
4. Navigation or tab closure cleans up the overlay and renderer.

## Rendering and translation

The implemented renderer uses Canvas2D. It prefers an OffscreenCanvas worker and
falls back to main-thread Canvas2D if transfer, initialization, or worker health
checks fail. There is no WebGL renderer.

Translation is enabled only when the browser exposes the built-in Translator
API and supports the selected language pair. Firefox currently runs without
translation. The browser may download language models before first use.

## Release packaging

The versioned release workflow builds and packages both extension directories,
generates checksums and metadata, and attaches the ZIP files to GitHub Releases.
Keep the manifests, package version, release script, and artifact checks aligned
instead of preparing store packages manually.
