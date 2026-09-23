# YouTube Live Chat Overlay

[English](./README.md) | [한국어](./README.ko.md) | [日本語](./README.ja.md)

Display YouTube live chat as NicoNico-style flowing comments over live streams,
premieres, and replays. The project is available as a userscript and as unpacked
Chrome and temporary Firefox extension builds.

## Features

- Right-to-left, left-to-right, top-fixed, and bottom-fixed comment modes
- Text, emoji, Super Chat, sticker, membership, and author badge rendering
- Backlog injection for recent or replayed messages
- Speed, font, opacity, outline, safe-zone, lane, and depth controls
- Six interface languages with automatic or manual selection
- Optional in-browser chat translation when the browser provides the Translator API
- Settings import, export, and cross-tab synchronization
- Main-thread Canvas2D rendering with an OffscreenCanvas worker when available

## Install

### Userscript

Install [Tampermonkey](https://www.tampermonkey.net/) or
[Violentmonkey](https://violentmonkey.github.io/), then install the
[latest userscript](https://github.com/PiesP/yt-live-chat-overlay/releases/latest/download/yt-live-chat-overlay.user.js).

The userscript manager checks the metadata URL embedded in the script for
updates.

### Chrome, Edge, or Brave extension

The release archive is an unpacked developer build; it is not installed from a
browser store and does not update automatically.

1. Download `yt-live-chat-overlay-chrome.zip` from the
   [latest release](https://github.com/PiesP/yt-live-chat-overlay/releases/latest).
2. Extract the archive to a permanent directory.
3. Open `chrome://extensions` and enable **Developer mode**.
4. Select **Load unpacked** and choose the extracted directory.

### Firefox extension

1. Download `yt-live-chat-overlay-firefox.zip` from the
   [latest release](https://github.com/PiesP/yt-live-chat-overlay/releases/latest).
2. Open `about:debugging#/runtime/this-firefox`.
3. Select **Load Temporary Add-on** and choose the ZIP.

This development installation is removed when Firefox restarts. Use the
userscript for a persistent installation.

## Use

Open a YouTube live stream, premiere, or replay with chat. The overlay starts
automatically. Select the gear button added to the player to configure display,
backlog, translation, performance, and accessibility options.

## Browser support

| Distribution | Support |
| --- | --- |
| Userscript | Current desktop browsers supported by Tampermonkey or Violentmonkey |
| Chromium extension | Chrome/Chromium 116+ developer mode |
| Firefox extension | Firefox 128+ technical minimum; temporary developer installation |

Translation support is detected at runtime and is independent of these browser
floors. Translation requires the browser's built-in Translator API and support
for the selected language pair. Automatic source-language detection uses the
Language Detector API when available and otherwise falls back to in-browser
Unicode heuristics. The browser may download a required language model or
language pack. Without Translator, the overlay continues to work without
translation.

Firefox 128 is the extension's technical compatibility floor, not a claim that
Firefox 128 remains a currently serviced ESR. Use a currently supported Firefox
release for normal use and release validation.

## Privacy and security

Chat parsing and rendering happen in the browser. The project does not operate
an analytics, telemetry, translation, or chat-processing server; normal YouTube
and Google media requests still occur. See [Privacy](./PRIVACY.md) for storage
and network details and [Security](./.github/SECURITY.md) for vulnerability
reports.

## Project documentation

This project is developed with assistance from AI tools.

See [Contributing](./CONTRIBUTING.md) for development setup and validation, and
the [extension guide](./extension/README.md) for extension architecture, builds,
and unpacked loading.

## Support

- Usage and troubleshooting: [Support](./SUPPORT.md)
- Bugs and feature requests: [GitHub Issues](https://github.com/PiesP/yt-live-chat-overlay/issues)
- Release history: [Changelog](./CHANGELOG.md)
- Vulnerabilities: [Security policy](./.github/SECURITY.md)

## License

MIT. See [LICENSE](./LICENSE).
