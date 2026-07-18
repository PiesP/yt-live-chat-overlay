# YouTube Live Chat Overlay

A userscript and browser extension that shows YouTube live chat as Nico-nico style flowing comments over the video.
All processing is local — chat content is never stored or sent anywhere.

## Features

- **Live chat overlay** — comments flow over the video player in real-time
- **Four display modes** — RTL scroll (classic), LTR reverse, top-fixed, bottom-fixed
- **Rich content** — text, emoji, Super Chats (with stickers), membership messages
- **Chat translation** — real-time in-browser translation with dual/subtitle or replace mode (Chrome 138+)
- **Multi-language UI** — English, 한국어, 日本語, Español, 中文, العربية (auto-detect or manual)
- **Backlog injection** — past messages fill the screen on entry (4 modes: playback-based, recent, full, none)
- **Depth layers** — speed-based near/far perception with configurable speed and opacity
- **Author badges** — owner, moderator, member visibility & colors
- **Full customization** — speed, font, size, opacity, colors, text outline, safe zones, lane spacing
- **Settings import/export** — share config across browsers or backup
- **Cross-tab sync** — settings sync instantly across YouTube tabs
- **Settings panel** — click the ⚙ button on the player to configure everything
- **100% local** — no external dependencies, no data collection, no tracking

## Install

### Userscript

1. Install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/)
2. Open the latest release in your browser to install:
   - [yt-live-chat-overlay.user.js](https://cdn.jsdelivr.net/gh/PiesP/yt-live-chat-overlay@release/dist/yt-live-chat-overlay.user.js)
3. The userscript manager will auto-update when new releases are published.

### Browser Extension

#### Chrome / Edge / Brave

1. Download `yt-live-chat-overlay-chrome.zip` from the [latest release](https://github.com/PiesP/yt-live-chat-overlay/releases/latest)
2. Navigate to `chrome://extensions`
3. Enable **Developer mode** (toggle in top-right)
4. Drag and drop the ZIP file onto the page

#### Firefox

1. Download `yt-live-chat-overlay-firefox.zip` from the [latest release](https://github.com/PiesP/yt-live-chat-overlay/releases/latest)
2. Navigate to `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on** → select the ZIP file

> **Note:** Firefox does not support the built-in translation API (Chrome 138+). Translation is automatically disabled on Firefox.

## Usage

Open a YouTube live stream, premiere, or replay with chat. The overlay starts automatically.
Click the ⚙ button in the top-right of the player to adjust settings.

## Privacy

All chat fetching, parsing, rendering, and translation happens locally in your browser.
No data is stored (beyond saved settings) or transmitted to any third party.

## Development

Requires Node.js `>=26.0.0` and pnpm `>=11.2.2`.

```bash
pnpm install
pnpm build:dev            # dev userscript bundle with source maps
pnpm build                # prod userscript bundle (runs quality gate via prebuild)
pnpm build:extension      # Chrome extension build (output: dist-extension/)
pnpm build:extension:firefox  # Firefox extension build (output: dist-extension-firefox/)
pnpm quality              # fmt + lint + check + circular + knip
```

### Project Structure

```
src/
  app/           Runtime lifecycle, overlay, video pause, standby
  chat/          YouTube chat source, DOM watcher, poll loop, API
  i18n/          Locale files (en, ko, ja, zh-CN, es, ar)
  media/         Author rate limiter
  platform/      Platform abstraction (storage, workers, cross-tab)
  renderer/      Canvas2D renderer + OffscreenCanvas Worker
  settings/      Settings schema, limits, UI, store
  translation/   In-browser chat translation
  types/         Shared TypeScript types
  util/          Utilities (logging, DOM, LRU, message bus, etc.)
extension/
  content-script.ts  ISOLATED world entry point + storage relay
  background.ts   Service worker — context menu registration
  manifest.json   Chrome MV3 manifest
  manifest.firefox.json  Firefox MV3 manifest
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full contributor workflow.

## License

MIT — see [LICENSE](./LICENSE).

---

<div align="center">

**🌟 If you find this project useful, please give it a Star! 🌟**

**Made with ❤️ and GitHub Copilot by [PiesP](https://github.com/PiesP)**

</div>
