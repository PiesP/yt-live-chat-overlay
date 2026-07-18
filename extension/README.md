# Browser Extension (MV3)

The YouTube Live Chat Overlay is also available as a browser extension for
Chrome, Edge, Brave, Vivaldi, and Firefox (MV3).

## Architecture

```
packages?
  src/
    core/          ← Shared business logic (renderers, lane allocator, chat parser)
    platform/      ← Abstraction layer (StorageAdapter, WorkerFactory, MenuAdapter)

  extension/
    background.ts   ← Service Worker (context menu, message routing)
    content-script.ts ← MAIN world content script entry point
    manifest.json    ← Chrome MV3 manifest
    manifest.firefox.json ← Firefox MV3 manifest

  dist-extension/         ← Chrome extension output (gitignored)
  dist-extension-firefox/ ← Firefox extension output (gitignored)
```

## Platform Abstraction

The application logic is organized into domain-specific directories under `src/`: `app/`, `chat/`, `renderer/`, `settings/`, `i18n/`, `translation/`, `media/`, `util/`. Platform differences
are isolated behind adapter interfaces in `src/platform/`:

| Capability | Userscript | Chrome Extension | Firefox Extension |
|---|---|---|---|
| Storage | `GM_getValue`/`GM_setValue` | `chrome.storage.local` | `browser.storage.local` |
| Worker URL | `new URL(..., import.meta.url)` | `chrome.runtime.getURL(...)` | `browser.runtime.getURL(...)` |
| Menu | `GM_registerMenuCommand` | `chrome.contextMenus` | `browser.menus` |
| Cross-tab sync | `GM_addValueChangeListener` | `chrome.storage.onChanged` | `browser.storage.onChanged` |
| Translation | `self.Translator` (Chrome 138+) | `self.Translator` | Not supported |

## Build Commands

```bash
# Userscript (output: dist/)
pnpm build

# Chrome/Edge/Brave Extension (output: dist-extension/)
pnpm build:extension

# Firefox Extension (output: dist-extension-firefox/)
pnpm build:extension:firefox
```

## Loading the Extension During Development

### Chrome
1. Navigate to `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" → select `dist-extension/`

### Firefox
1. Navigate to `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on" → select `dist-extension-firefox/manifest.json`

## Key Design Decisions

- **ISOLATED world content script**: The extension uses `"world": "ISOLATED"`.
  A small page script is injected into MAIN world via a `<script>` element for
  `window.fetch` interception, identical to the userscript. The content script
  relays messages between the ISOLATED world (chrome.* API access) and the
  MAIN world (YouTube page context).

- **No webextension-polyfill dependency**: Chrome and Firefox use slightly
  different API namespaces (`chrome.*` vs `browser.*`), but the core code
  never calls these directly. The platform adapter layer handles the mapping.

- **Worker bundles in web_accessible_resources**: The render worker
  (`workers/renderer.js`) must be listed in
  `web_accessible_resources` so the content script can spawn them via
  `chrome.runtime.getURL()`.

- **Zero runtime dependencies**: Same as the userscript — no npm packages
  are loaded at runtime. All processing is local.

## Firefox Limitations

- **No built-in translation**: Firefox does not support the `self.Translator`
  API (Chrome 138+). The translation feature is automatically disabled in
  Firefox — `TranslationService.isSupported()` returns `false`.

- **OffscreenCanvas + WebGL2 Worker**: Firefox has partial support. The
  renderer already falls back to main-thread Canvas2D when OffscreenCanvas
  is unavailable.

## Publishing

### Chrome Web Store
1. Run `pnpm build:extension`
2. Zip `dist-extension/`
3. Upload to Chrome Developer Dashboard

### Firefox Add-ons (AMO)
1. Run `pnpm build:extension:firefox`
2. Zip `dist-extension-firefox/`
3. Upload to Firefox Add-on Developer Hub

### Greasy Fork (Userscript)
1. Run `pnpm build`
2. Upload `dist/yt-live-chat-overlay.user.js`
