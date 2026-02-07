# YouTube Live Chat Overlay

A userscript that shows YouTube live chat as flowing Nico-nico style comments on top of the video.
All processing happens locally in your browser, and chat content is never stored or sent anywhere.

## Features

- Live chat comments flow from right to left as an overlay
- 100% local processing (no external servers)
- Quick settings via the ⚙ button on the player

## Install

1. Install Tampermonkey or Violentmonkey
2. Install the latest release:
   - Stable: [yt-live-chat-overlay.user.js](https://github.com/PiesP/yt-live-chat-overlay/releases/latest/download/yt-live-chat-overlay.user.js)
   - Metadata (auto-update): [yt-live-chat-overlay.meta.js](https://cdn.jsdelivr.net/gh/PiesP/yt-live-chat-overlay@release/dist/yt-live-chat-overlay.meta.js)
3. Open the file in your browser to install

## How to Use

1. Open a YouTube live stream or premiere with chat
2. The overlay appears automatically when chat is detected
3. Use the ⚙ button in the top-right of the player to open settings

## Settings

- Adjust speed, font size, opacity, safe zones, colors, and outline
- Settings are saved in `localStorage` and can be reset anytime

## Privacy & Safety

- Chat content is never stored or transmitted
- The YouTube UI is not modified; only an overlay is added

## Support

- Bug reports and requests: [GitHub Issues](https://github.com/PiesP/yt-live-chat-overlay/issues)

## License

MIT License — see [LICENSE](LICENSE).

---

<div align="center">

**🌟 If you find this project useful, please give it a Star! 🌟**

**Made with ❤️ and GitHub Copilot by [PiesP](https://github.com/PiesP)**

</div>
