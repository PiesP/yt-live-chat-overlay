# Privacy

Last updated: 2026-11-03

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

Chat request bodies include only the YouTube protocol client name/version, page
language, continuation and page-provided click-tracking context, plus replay
position when needed. The application does not copy arbitrary page client fields
or add device details, region, time zone or UTC offset to that client context.
YouTube session cookies and visitor identifiers still accompany functional
requests. Chat API requests limit the referrer to the page origin. Normal browser
network headers remain under the browser's control.

The userscript manager may separately check GitHub release URLs embedded in the
userscript header for updates. YouTube, Google, GitHub, browser vendors, and
installed userscript managers have their own privacy policies.

## Firefox data consent

The Firefox extension requires Firefox 140 or later so installation can use
[Firefox's built-in data consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/).
Its [manifest](./extension/manifest.firefox.json) declares the data used in functional
requests to YouTube and Google media hosts:

- `authenticationInfo`: YouTube session cookies and visitor/session context.
- `browsingActivity`: watch-page, chat and media addresses used by requests.
- `websiteContent`: page-derived client context and chat continuation/request data.
- `websiteActivity`: replay playback position and page-provided click-tracking context.

These categories describe requests to the original service, including authenticated
requests. They do not represent a project-operated collection endpoint. Chat message
bodies stay in the browser; there is no optional telemetry collection. Firefox
shows the required data permissions when installing the extension. The userscript
and Chromium builds use their existing browser or manager permissions.

## Translation

When enabled, translation uses the browser's built-in Translator API. Automatic
source-language detection uses the Language Detector API when available and
otherwise falls back to in-browser Unicode heuristics. The project does not send
chat text to an external translation API. The browser may download language
models or language packs and controls their storage and processing. Feature and
language-pair availability varies by browser and device.

## Contact

Use [GitHub Issues](https://github.com/PiesP/yt-live-chat-overlay/issues) for
privacy questions that do not expose sensitive information. Report suspected
vulnerabilities through the [security policy](./.github/SECURITY.md).
