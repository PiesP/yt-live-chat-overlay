# Testing Checklist – YouTube Live Chat Overlay

This checklist covers the userscript that overlays YouTube live chat as flowing Nico-nico comments.

## Pre-test setup

- `pnpm quality`
- `pnpm build` or `pnpm build:dev`
- Install the generated userscript in Tampermonkey or Violentmonkey
- Use a desktop browser with a YouTube live stream, premiere, or replay that has chat available

## Core overlay flow

- Overlay starts automatically on supported pages
- Settings button appears in the player UI
- Text messages animate right-to-left without blocking player controls
- Emoji, membership items, and Super Chats render without broken placeholders
- Overlay stops cleanly when the page is unsupported or chat is unavailable

## Settings and persistence

- Opening settings shows current values from saved preferences
- Changing speed, font size, opacity, or safe zones updates the overlay
- Reloading the page keeps settings intact
- Resetting settings restores defaults from `DEFAULT_SETTINGS`

## YouTube SPA lifecycle

- Navigating between supported YouTube pages reinitializes the overlay cleanly
- Leaving a supported page removes overlay UI and stops message rendering
- Reopening a supported page does not leave duplicate overlay instances behind

## Safety and diagnostics

- No raw HTML is injected into the overlay
- No unexpected console errors appear in the happy path
- Diagnostic logs remain prefixed with `[YT Chat Overlay]`
- No new external services are contacted beyond the existing YouTube/browser-local flow

## Production verification

- `pnpm quality` passes
- `pnpm build` succeeds
- `dist/yt-live-chat-overlay.user.js` is generated
- Runtime behavior still matches the README installation/usage flow
