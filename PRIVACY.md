# Privacy Policy for YouTube Live Chat Overlay

**Last updated:** June 3, 2026

## Overview

YouTube Live Chat Overlay is a browser extension that displays YouTube live chat comments as flowing text over the video player. This policy explains what data the extension handles and how.

## Data Collection

**The extension does not collect, transmit, or store any personal information.**

- No user accounts or authentication are required
- No analytics, telemetry, or crash reporting is implemented
- No usage data is tracked or sent to any server
- No chat content, video metadata, or browsing history is recorded or transmitted

## Local Storage

The extension stores only your UI preferences locally in your browser's built-in storage (`chrome.storage.local`). This includes settings such as:

- Font family, size, and color preferences
- Comment display speed and direction
- Opacity, outline, and safe zone configuration
- Language preference for the settings UI

This data never leaves your device. It is used solely to persist your customization choices between browser sessions.

## Network Requests

The extension makes network requests only to:

- **`youtube.com` and related Google domains** — to read live chat data from the YouTube page you are viewing

No data is sent to any third-party servers. All chat processing (parsing, rendering, translation) happens entirely within your browser.

## Translation

When translation is enabled, the extension uses Chrome's built-in Translator API (`self.Translator`). Translation requests are processed by Chrome's native translation service. The extension does not use any external translation API or service.

## Third-Party Services

This extension does not integrate with or transmit data to any third-party analytics, advertising, or tracking services.

## Children's Privacy

This extension does not knowingly collect personal information from anyone, including children under the age of 13.

## Changes to This Policy

If this policy changes, the updated version will be posted on the extension's GitHub repository. Continued use of the extension after changes constitutes acceptance of the updated policy.

## Contact

For questions about this privacy policy, please open an issue on GitHub:
[https://github.com/PiesP/yt-live-chat-overlay/issues](https://github.com/PiesP/yt-live-chat-overlay/issues)
