# YouTube Live Chat Overlay

A userscript that shows YouTube live chat as Nico-nico style flowing comments over the video.
All processing is local — chat content is never stored or sent anywhere.

## Features

- Live chat flows over the player (right-to-left scroll, reverse, top, bottom modes)
- Works on live streams, premieres, and replays with chat
- Fetches chat via YouTube's InnerTube API — no chat panel dependency
- Rich content: text, emoji, membership items, Super Chats (with stickers)
- Dual rendering: Canvas2D (default, rAF-based) or CSS animation
- Backlog injection, per-author rate limiting, anti-block density control
- Cross-tab settings sync via `localStorage` / `GM_setValue`
- Settings panel (⚙ button on the player) — speed, font, opacity, colors, outline, safe zones

## Install

1. Install Tampermonkey or Violentmonkey.
2. Open the latest release in your browser to install:
   - [yt-live-chat-overlay.user.js](https://github.com/PiesP/yt-live-chat-overlay/releases/latest/download/yt-live-chat-overlay.user.js)
3. The userscript manager will auto-update when new releases are published.

## Usage

Open a YouTube live stream, premiere, or replay with chat. The overlay starts automatically.
Click the ⚙ button in the top-right of the player to adjust settings.

## Privacy

All chat fetching, parsing, and rendering happens locally in your browser.
No data is stored (beyond saved settings) or transmitted to any third party.

## Development

Requires Node.js `>=24.0.0` and pnpm `>=10.29.2`.

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

**🌟 Star this repo if you find it useful! 🌟**

</div>
