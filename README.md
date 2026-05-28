# YouTube Live Chat Overlay

A userscript that shows YouTube live chat as Nico-nico style flowing comments over the video.
All processing is local — chat content is never stored or sent anywhere.

## Features

- **Live chat overlay** — comments flow over the video player in real-time
- **Four display modes** — RTL scroll (classic), LTR reverse, top-fixed, bottom-fixed
- **Rich content** — text, emoji, Super Chats (with stickers), membership messages
- **Chat translation** — real-time in-browser translation with dual/subtitle or replace mode (Chrome 138+)
- **Multi-language UI** — English, 한국어, 日本語, Español, 中文 (auto-detect or manual)
- **Backlog injection** — past messages fill the screen on entry (4 modes: playback-based, recent, full, none)
- **Depth layers** — speed-based near/far perception with configurable speed and opacity
- **Author badges** — owner, moderator, member visibility & colors
- **Full customization** — speed, font, size, opacity, colors, text outline, safe zones, lane spacing
- **Settings import/export** — share config across browsers or backup
- **Cross-tab sync** — settings sync instantly across YouTube tabs
- **Settings panel** — click the ⚙ button on the player to configure everything
- **100% local** — no external dependencies, no data collection, no tracking

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/)
2. Open the latest release in your browser to install:
   - [yt-live-chat-overlay.user.js](https://github.com/PiesP/yt-live-chat-overlay/releases/latest/download/yt-live-chat-overlay.user.js)
3. The userscript manager will auto-update when new releases are published.

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
pnpm build:dev       # dev bundle with source maps
pnpm build           # prod bundle (runs quality gate via prebuild)
pnpm quality         # fmt + lint + check + circular + knip
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full contributor workflow.

## License

MIT — see [LICENSE](./LICENSE).

---

<div align="center">

**🌟 If you find this project useful, please give it a Star! 🌟**

**Made with ❤️ and GitHub Copilot by [PiesP](https://github.com/PiesP)**

</div>
