# YouTube Live Chat Overlay

**Nico-nico style flowing comments overlay for YouTube live chat.**

100% local processing — no data collection, no external requests, no storage of chat content.

## Features

- Displays YouTube live chat messages in Nico-nico (ニコニコ) style flowing overlay
- 100% local processing in your browser
- No chat data storage or transmission
- Automatic SPA navigation handling
- Collision-free lane management
- Configurable speed, font size, and opacity
- Rate limiting to prevent performance issues

## Legal & Privacy

**IMPORTANT NOTICE:**

- This userscript operates **entirely in your browser** (100% local processing)
- **NO chat data** is stored, transmitted, or processed externally
- Only user settings (font size, speed, etc.) are stored in localStorage
- This is **NOT** an official YouTube or Nico-nico product
- YouTube UI/content is **NOT** modified — only an overlay is added
- The overlay uses `pointer-events: none` and does not interfere with YouTube functionality

## Installation

### Prerequisites

- [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/)

### Install from Release

1. Download `yt-live-chat-overlay.user.js` from [Releases](https://github.com/PiesP/yt-live-chat-overlay/releases)
2. Open the file in your browser
3. Your userscript manager will prompt you to install

### Manual Installation

1. Build the script:
   ```bash
   pnpm install
   pnpm build
   ```
2. Install `dist/yt-live-chat-overlay.user.js` in your userscript manager

## Usage

1. Navigate to a YouTube live stream or premiere with chat
2. The overlay will automatically activate when chat is detected
3. Messages will flow from right to left across the video

## Configuration

Settings are stored in `localStorage`. Use the ⚙ button on the video player to open the settings panel, or update via browser console:

```javascript
// Access settings (dev mode only)
__ytChatOverlay.settings.get();

// Update settings
__ytChatOverlay.settings.update({
  enabled: true,
  speedPxPerSec: 240,
  fontSize: 26,
  opacity: 0.92,
  safeTop: 0.08,
  safeBottom: 0.15,
  maxConcurrentMessages: 24,
  maxMessagesPerSecond: 6,
  outline: {
    enabled: true,
    widthPx: 2,
    blurPx: 3,
    opacity: 0.75,
  },
});
```

## Development

### Requirements

- Node.js >= 24.0.0
- pnpm >= 10.0.0

### Setup

```bash
# Install dependencies
pnpm install

# Type check
pnpm check

# Lint & format
pnpm quality

# Build
pnpm build          # Production build
pnpm build:dev      # Development build
```

### Project Structure

```
src/
├── main.ts              # Entry point
├── core/
│   ├── page-watcher.ts  # SPA navigation handler
│   ├── chat-source.ts   # Chat DOM monitoring
│   ├── overlay.ts       # Overlay container
│   ├── renderer.ts      # Message rendering
│   └── settings.ts      # Settings manager
└── types/
    └── index.ts         # Type definitions
```

## Architecture

### Components

1. **PageWatcher**: Monitors URL changes and triggers re-initialization
2. **ChatSource**: Finds and observes YouTube chat DOM for new messages
3. **Overlay**: Creates overlay container on video player
4. **Renderer**: Renders messages with lane management and collision detection
5. **Settings**: Manages user preferences (localStorage only)

### Safety Features

- Rate limiting: Max messages per second (default: 8/s)
- Concurrent limit: Max active messages (default: 30)
- Text sanitization: `textContent` only, no `innerHTML`
- TTL enforcement: Messages auto-remove after animation
- No external requests: Zero network activity
- No chat storage: Only settings are persisted

## License

MIT License - See [LICENSE](LICENSE) file

## Disclaimer

This is an independent, unofficial project. Not affiliated with YouTube or Nico-nico.

## Support

Issues and feature requests: [GitHub Issues](https://github.com/PiesP/yt-live-chat-overlay/issues)

---

<div align="center">

**🌟 If you find this project useful, please give it a Star! 🌟**

**Made with ❤️ and GitHub Copilot by [PiesP](https://github.com/PiesP)**

</div>
