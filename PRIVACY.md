# Privacy

Last updated: 2026-07-29

YouTube Live Chat Overlay is distributed as a userscript and as Chrome and
Firefox extension builds. It does not use a developer-operated backend,
analytics, telemetry, advertising, or crash-reporting service.

## Data handled in the browser

The application reads the current YouTube page and same-origin YouTube chat
responses to identify live and replay messages. Message text, author details,
badges, emoji, stickers, and related video or channel identifiers are held in
memory only as needed to render and deduplicate the overlay.

Chat content and media are not sent to a server operated by this project and are
not written to persistent storage.

## Storage

Persistent storage contains settings such as display, backlog, translation,
language, performance, and accessibility preferences.

- Extension builds prefer the browser extension's local storage.
- The userscript prefers the installed userscript manager's `GM_*` storage.
- `localStorage` is used as a fallback when neither integration is available.
- Per-channel language detection memory is bounded and session-only.

Removing the userscript or extension may not remove its settings automatically.
Use the userscript manager or browser extension storage controls when a complete
reset is required.

## Network access

The application makes same-origin requests to `www.youtube.com` when page data
or chat continuations are not already available. It also loads YouTube-hosted
author images, emoji, and stickers from allowlisted Google media domains such as
`ggpht.com`, `googleusercontent.com`, `gstatic.com`, and `ytimg.com`.

The userscript manager may separately check jsDelivr URLs embedded in the
userscript header for updates. YouTube, Google, browser vendors, and installed
userscript managers have their own privacy policies.

## Translation

When enabled, translation uses the browser's built-in Translator and Language
Detector APIs. The project does not send chat text to an external translation
API. The browser may download language models or language packs and controls
their storage and processing. Feature and language-pair availability varies by
browser and device.

## Contact

Use [GitHub Issues](https://github.com/PiesP/yt-live-chat-overlay/issues) for
privacy questions that do not expose sensitive information. Report suspected
vulnerabilities through the [security policy](./.github/SECURITY.md).
