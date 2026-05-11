# Changelog

All notable changes to this project will be documented in this file.

## [0.25.0] - 2026-05-11

### Fixed

- **Timer leak in BacklogInjectionController** — `notifyRealTimeActivity()` timers are now tracked and cleared on `destroy()`, preventing callback execution on a destroyed instance.
- **BurstDetector stale state on restart** — `stop()` now resets `samplesSinceLastCheck` to 0, preventing stale sample counts from corrupting burst level classification after rapid start/stop cycles.
- **ObservabilityReporter duplicate intervals** — `scheduleDebugUpdate()` now guards against creating multiple intervals when called repeatedly.
- **SettingsUi preview timer leak** — `destroy()` now cancels any pending preview timer, preventing callback execution on a destroyed instance.
- **Prototype pollution in localStorage parsing** — `readStoredSettingsRaw()` now rejects arrays, `__proto__`, and `constructor` keys in parsed localStorage data.

### Refactored

- **Replaced `window.confirm` with custom modal dialog** — Settings reset confirmation now uses an in-modal dialog consistent with the settings UI design system, instead of a blocking native browser dialog.
- **Simplified `getNumber()` in youtubei-chat.ts** — Merged two-branch type check into a single expression.
- **Replaced `Object.assign` with spread** — `BacklogInjectionController.updateConfig()` now uses immutable config replacement.
- **Added `unload` fallback cleanup to PageWatcher** — History method patches are now restored on page unload as a safety net.
- **Added `dangerHover` color token** — Consistent danger button hover state across the settings UI.

### Performance

- **Author rate limiter cutoff hoisting** — Moved cutoff computation outside the branch to avoid redundant computation; persist filtered timestamps even when rate-limited to keep the map clean.

## [0.24.4] - 2026-05-10

### Added

- **Video pause/play comment flow control** — Comments now pause when the video is paused and resume when playback starts. Previously, only tab visibility changes were handled; video pause left comments flowing and queueing up, causing a flood of stale messages on resume.
  - `Renderer.pauseForVideo()` / `resumeForVideo()` — Distinct from tab-visibility pause, these methods track an `isVideoPaused` flag that drops incoming messages during pause (preventing queue overflow) while keeping animations frozen in place.
  - `RuntimeSession.startVideoPauseListeners()` — Listens for `pause`/`play` events on the `<video>` element and routes them to the renderer. Cleanup is handled on session dispose.

## [0.24.3] - 2026-05-10

### Refactored

- **`createAbortError` simplified** — 3-branch if/else reduced to ternary expression in `dom.ts`.
- **`sleep` signal argument deduplicated** — Removed redundant optional chain after abort guard in `dom.ts`.
- **`PageWatcher` history restorers** — Replaced `Array<() => void>` + loop with two nullable closure variables (`restorePushState`/`restoreReplaceState`), simplifying destroy logic.
- **`ChatSource.start` abort guard** — Removed redundant `isPollAbort()` check; `isAbortError` alone is sufficient since the combined signal already covers both external and internal aborts.
- **`getMessagePriority` switch → lookup table** — Replaced 5-line switch statement with a 3-line `Record<ChatMessage['kind'], number>` in `Renderer`.
- **`normalizeSettings` boolean guards** — Extracted `pickBool` helper to eliminate 5 repetitive `typeof x === 'boolean' ? x : default` patterns in `settings-schema.ts`.
- **`applyRootSettingsTo` checkbox collection** — Extracted local `cb` helper to remove 5 duplicate `this.getCheckbox(name, fallback)` call sites in `SettingsUiForm`.
- **`collectShowAuthorSettings` simplified** — Removed unnecessary intermediate variable and blank lines in `SettingsUiForm`.
- **`populateRootSetting` branching** — Replaced 5-way OR chain + 2-way OR chain with `Set.has()` lookups (`BOOLEAN_ROOT_KEYS`, `SELECT_ROOT_KEYS`) for O(1) dispatch.
- **`findFirstNestedStringByKey` body** — Converted block body to expression body in `youtubei-chat.ts`.

## [0.24.2] - 2026-05-09

### Refactored

- **Deduplicated `getPlaybackSnapshot()`** — Hoisted identical private method from both `LiveChatSource` and `ReplayChatSource` to the abstract `ChatSource` base class.
- **Consolidated outline key maps** — Replaced duplicate `OUTLINE_LIMITS_KEY` in settings UI with a single exported source of truth from `settings-schema.ts`.
- **Removed unused `burstEnabled` code path** — The `AuthorRateLimiter.burstEnabled` field was never configured from outside. Removed the field, its guard, and the `updateConfig` parameter.
- **Consolidated bootstrap backoff logic** — Two copies of identical exponential backoff in `resolveBootstrap()` merged into a single shared path.
- **Reduced redundant opacity computation** — `effectiveOpacity` was computed twice per rendered message. Now computed once and passed to both `applyCommonMessageStyles()` and `setupMessageAnimation()`.
- **Removed unused type fields** — `SuperChatInfo.currency` and `EmojiInfo.id` were set during parsing but never read by the renderer. Removed the type definitions and parsing code.

## [0.24.1] - 2026-05-09

### Fixed

- **SPA navigation chat bootstrap reliability** — Chat now reliably initializes after YouTube SPA navigation (switching between videos without page reload). Previously, `window.ytInitialData` and `window.ytcfg` could still reference the previous video, causing bootstrap to fail with `unavailable` and give up. Now retries up to 8 times with exponential backoff (800ms → 8s cap), detects stale cached HTML, and retries on `unavailable` status.

## [0.24.0] - 2026-05-09

### Added

- **Width-proportional collision threshold** — Lane allocator now scales safe distance based on comment width relative to screen width (inspired by danmaku2ass's thresholdTime formula). Wider comments naturally receive more trailing gap, while narrow comments pack tighter, improving screen utilization.
- **Adaptive scroll speed based on burst level** — BurstDetector level changes now propagate to LaneAllocator, automatically increasing scroll speed during high-traffic periods (1.1x elevated, 1.2x high, 1.35x extreme). Per-author rate limiter still keeps individual authors in check.
- **Deterministic entry offset distribution** — Messages arriving at the same time now spread evenly across the right edge of the screen (0–200px range) instead of clustering at 3 fixed positions, with 30px random jitter preserved.
- **Relaxed collision check for single-lane messages** — Adjacent lanes that have already scrolled past the screen midpoint no longer block placement for single-lane messages. CSS `overflow:hidden` clips them, so only the target lane's full collision check applies.

### Fixed

- **Animation resume after pause** — When resuming from pause, active animations now recalculate remaining duration and reset from their current visual position instead of jumping to where they would be if they had been running during the pause.

## [0.23.0] - 2026-05-08

Tab visibility handling fix, stale animation sweep safe iteration, defaults optimized (speed 280→250, maxConcurrent 40→50, maxPerSec 6→8, durationMax 12s→30s). Removed dynamic queue sizing, density-based speed multiplier, progressive overwrite, and simplified batch/retry logic.

## [0.22.0] - 2026-05-07

Added ObservabilityReporter (session metrics/debug overlay), BurstDetector (4-level burst detection), ProgressiveOverwriteManager (linear force-overwrite), PerAuthorRateLimiter (sliding window + burst awareness), BacklogInjectionController (throttled backlog injection with sampling). Metrics/extensibility configuration options added.

## [0.21.2] - 2026-05-07

Unified source code comments to English.

## [0.21.1] - 2026-05-06

Made `authorType` required on `ChatMessage`; removed dead code, redundant checks, inlined TupleValue utility, simplified fetch signal passing, optimized sweepStaleAnimations early-exit.

## [0.21.0] - 2026-05-05

Various fixes: replay buffer ordering/emoji detection, image listener once-flag, RGBA hex support, set iteration safety, abort error detection, circular dep fix, rate limiting moved to render time. Performance: throttled sweepStaleAnimations, batch-ready messages in single pass. Refactored: ChatSource split into Live/Replay, OverlayView inlined, settings consolidated, round-robin lane selection. Dependencies/tooling updates.

## [0.20.0] - 2026-05-04

SuperChat/membership enhanced visuals, backdrop overlay and modal animations, live preview mode, reset confirmation dialog. Fixed replay fetch busy-loop and overlay container DOM leak. Performance: skip health checks when paused. UI tab reorganization (General/Appearance/Layout).

## [0.19.1] - 2026-05-03

Fixed long pause timeline skew — lane collision/rate limiter cap timeline shifts at 60 seconds to prevent message blocking after long idle.

## [0.19.0] - 2026-05-03

Settings layer consolidation (6→3 files, -50%), utility files merged (abort→dom, json→youtubei-chat, image-url→youtubei-chat), SettingsUi split (851→298 lines). Fixed circular dependency logging↔settings.

## [0.18.1] - 2026-05-03

Codebase simplification (-220 lines): removed VideoSync MutationObserver/periodic detection, delegated to RuntimeManager session restart; unified import paths to `@core/` alias.

## [0.18.0] - 2026-05-01

Codebase simplification (-120 lines): removed timers.ts wrapper, simplified abort/settings code, reduced queue sizes, removed duplicate isRecord and @biomejs/cli-linux-x64. Fixed poll loop race condition, VideoSync interval leak, emoji text filter, overlay seeking behavior, DOM flicker on re-creation.

## [0.17.0] - 2026-04-30

Dependency updates and project configuration modernization (Biome, TypeScript, Vite).

## [0.16.0] - 2026-04-19

Multi-candidate image asset URLs with text fallback; runtime session restart/recovery restructured (unified managed restart contract); emoji/badge normalization improvements; watchdog stability fixes.

## [0.15.0] - 2026-04-18

Unified rich-content chat display path (ContentSegment[] normalization), paid sticker/membership support, protocol-relative URL normalization at parse stage, message model cleanup (ChatMessage.content canonical).

## [0.14.0] - 2026-04-18

youtubei-based chat collection path introduced (bootstrap/poll from watch page endpoint), seek-specific recovery reason, lifecycle redesigned with abort signal combination and generation management, settings definition structure cleanup.

## [0.13.0] - 2026-04-17

Live edge resynchronization added, chat surface detection expanded (watch page #chat, ytd-live-chat-frame), stale queue cleanup on disconnect, dead code removal.

## [0.12.2] - 2026-04-17

Cross-lane stagger for burst smoothness, recovery resync preserves active comments, chat DOM-based dedup keys, panel acquisition polling, unified logging API.

## [0.12.1] - 2026-04-17

Settings/logging path cleanup, removed unused helpers, Node.js baseline aligned to 24.15.0.

## [0.12.0] - 2026-04-16

Explicit chat start/resolution state contract, structured chat selector metadata, page navigation flow simplified, Trusted Types support for settings UI, infinite retry fix for unsupported chat iframes.

## [0.11.0] - 2026-04-15

Background return/chat health recovery strengthened, runtime restart/session management restructured, log/DOM utility cleanup, reduced recovery race conditions.

## [0.10.0] - 2026-04-14

Chat DOM responsibility separation (new `chat-dom.ts` module), logging switched from global patch to explicit wrapper, chat observer recovery with bounded burst retry.

## [0.9.0] - 2026-04-13

Playback resume chat snapshot sync API (`getLatestMessages(limit)`), pause→play resume redesigned as consistent resync approach, Renderer resetForResync method, duplicate resync guard.

## [0.8.0] - 2026-04-12

Background tab handling via Page Visibility API, chat MutationObserver monitoring/reconnection (15s loop), message queue cleared on seek, queue capped at 150, lane cleanup on animation cancel, settings UI redesigned with 4 tabs.

## [0.7.2] - 2026-04-01

SPA navigation restart stability with generation-based guard and ownership check; Biome downgraded to 2.4.9.

## [0.7.1] - 2026-03-31

Fixed diagonal comment placement (random lane selection replaces deterministic sequential), 0–45ms random jitter replaces fixed lane delay.

## [0.7.0] - 2026-03-31

Message density improved (lane height 1.3→1.2, safe distance 0.5→0.3, min 10→6px, clear time shortened). Defaults adjusted (safeTop 0.1→0, safeBottom 0.15→0.4, maxConcurrent 30→40, maxPerSec 4→6). Common utilities extracted (parseRgbColor, findPlayerContainerElement, selectors consolidated).

## [0.6.0] - 2026-03-06

Lane spacing setting added. Core-wide refactoring for consistency (chat-source, overlay, page-watcher, renderer, settings). Build/deploy metadata generation improved. Tooling quality gate alignment.

## [0.5.1] - 2026-03-05

Fixed double comment display (cancel flag, generation-based token, WeakSet DOM-level dedup). Dev dependency updates (Node 24.14, pnpm 10.27). CI security improvements.

## [0.5.0] - 2026-02-20

Settings UI expansion (log level, short text filter, author display/color). Log control module, image URL validation. Chat detection/panel open stability improved. Settings migration legacy compatibility.

## [0.4.2] - 2026-02-18

Message filtering improvements (Super Sticker, system message filtering, membership items), renderer lane optimization (faster delay, tighter packing, LRU tie-breaking), default values readjusted.

## [0.4.1] - 2026-02-16

Memory leak prevention across all components (PageWatcher, Overlay, Renderer, ChatSource, SettingsUi). Unified destroy() pattern, consistent log prefixes.

## [0.4.0] - 2026-02-14

Super Chat parsing/rendering with dynamic color/gradient, author profile images, Super Chat opacity option, design tokens module. Multiline message handling, lane height optimization.

## [0.3.1] - 2026-02-10

Unified version management baseline to package.json.

## [0.3.0] - 2026-02-09

Video playback synchronization (pause/resume), message queuing, playback rate sync (0.25x–2x), video element replacement detection, system message filtering, new VideoSync module.

## [0.2.0] - 2026-02-08

Emoji support with advanced rendering, XSS security validation, enhanced text sanitization, Dependabot/GitHub workflow automation.

## [0.1.1] - 2026-02-07

Release distribution via jsDelivr with .meta.js, GitHub workflows/CI, comment lane spacing/timing adjustments.

## [0.1.0] - 2026-02-06

Initial release: Nico-nico style live chat overlay for YouTube, settings panel, SPA navigation handling, collision-aware lane rendering, local-only processing.
