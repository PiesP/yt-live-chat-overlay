# YouTube Live Chat Overlay

A userscript that shows YouTube live chat as flowing Nico-nico style comments on top of the video.
All processing happens locally in your browser, and chat content is never stored or sent anywhere.

## Features

- Live chat comments flow from right to left as an overlay on the player
- Works on YouTube live streams, premieres, and replays with chat
- Fetches chat directly in your browser without depending on the visible chat panel
- Renders rich chat content including text, emoji, membership items, and Super Chats
- Quick settings via the ⚙ button on the player
- 100% local processing (no external servers)

## Install

1. Install Tampermonkey or Violentmonkey
2. Install the latest release:
   - Stable install: [yt-live-chat-overlay.user.js](https://github.com/PiesP/yt-live-chat-overlay/releases/latest/download/yt-live-chat-overlay.user.js)
   - Metadata/update URL: [yt-live-chat-overlay.meta.js](https://cdn.jsdelivr.net/gh/PiesP/yt-live-chat-overlay@release/dist/yt-live-chat-overlay.meta.js)
3. Open the stable `.user.js` file in your browser or userscript manager to install

## How to Use

1. Open a YouTube live stream, premiere, or replay with chat
2. The overlay starts automatically when the page is supported and chat is available
3. Use the ⚙ button in the top-right of the player to open settings

## Settings

- Adjust speed, font size, opacity, safe zones, lane spacing, author display, colors, and outline
- Settings are saved in `localStorage` and can be reset anytime

## Privacy & Safety

- All chat fetching, parsing, and rendering happen locally in your browser
- Chat content is never stored or transmitted
- The script injects an overlay and settings button into the player, and renders content with DOM APIs instead of injecting chat HTML

## Development

Prerequisites: Volta Node.js `24.15.0` (project default) or engines-compatible Node.js `>=24.0.0`, pnpm `>=10.29.2`

```bash
pnpm install
pnpm build:dev
pnpm check
pnpm quality
pnpm build
```

- `pnpm build` runs `prebuild`, so the repository quality gate is enforced before the production userscript is emitted.
- Detailed contributor workflow: [CONTRIBUTING.md](./CONTRIBUTING.md)
- Coding policy: [CODE_STANDARDS.md](./CODE_STANDARDS.md)

## Support

- Bug reports and requests: [GitHub Issues](https://github.com/PiesP/yt-live-chat-overlay/issues)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the expected development flow and PR checklist.

## License

MIT License — see [LICENSE](LICENSE).

---

<div align="center">

**🌟 If you find this project useful, please give it a Star! 🌟**

**Made with ❤️ and GitHub Copilot by [PiesP](https://github.com/PiesP)**

</div>
