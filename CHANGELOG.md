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

### Fixed

- **Tab visibility handling**: `handleBackgroundTab()` now properly pauses animations and trims queue; `handleForegroundTab()` resumes them — previously animations kept running in background and weren't resumed on return
- **Stale animation sweep**: Replaced `Set.forEach` deletion during iteration with safe `for-of` + collect-to-remove pattern
- **Defaults updated to optimized values**: `speedPxPerSec` 280→250, `maxConcurrentMessages` 40→50, `maxMessagesPerSecond` 6→8, `durationMax` 12000→30000ms

### Refactored

- **Removed dynamic queue sizing** — Fixed capacity (50) replaces exponential growth/hysteresis shrinkage system (~100 lines removed)
- **Removed density-based speed multiplier** → chat speed is now consistent and fully user-controlled
- **Removed progressive overwrite** — Lane allocator no longer has force-overwrite threshold; deep queue drops oldest instead
- **Simplified batch/retry logic** — Fixed batch size (8) and fixed retry delay (4ms) replace 5-level dynamic scaling
- **Removed unreachable priority cases** — `getMessagePriority()` only handles actual parser output kinds
- **Removed duplicate `focus` listener** — `visibilitychange` + `pageshow` are sufficient for tab-switch detection
- **Simplified settings-schema limit resolution** — `ROOT_NUMERIC_FIELDS`/`OUTLINE_NUMERIC_FIELDS` maps replaced with single `resolveLimits()` helper
- **Moved `outlineFormName`** from `settings-schema.ts` to `settings-ui-form.ts` (internal helper)
- **Simplified bootstrap HTML caching** closure in `bootstrapChatSession()`
- **Removed 4 unused `speedDensity*` constants** from design-tokens

## [0.22.0] - 2026-05-07

### Added

- **ObservabilityReporter**: Session metrics tracking, drop rate warnings, and debug overlay for monitoring chat rendering health
- **BurstDetector**: 4-level burst detection (normal/elevated/high/extreme) with progressive queue management
- **ProgressiveOverwriteManager**: Queue-depth-based linear force-overwrite (replaces binary on/off behavior)
- **PerAuthorRateLimiter**: Per-author sliding window rate limiting with priority exemptions and burst awareness
- **BacklogInjectionController**: Throttled initial backlog injection with statistical sampling, temporal compression, and progress indicator
- **Settings**: Debug overlay, rate limiting, and backlog control configuration options

### Changed

- `forceOverwriteMs` now scales progressively with queue depth (5→200ms to 20→0ms) instead of binary on/off
- Retry delay dynamically adjusts based on burst level
- `MessageCallback` signature updated to support `isInitialSeed` flag for backlog detection

## [0.21.2] - 2026-05-07

### Refactored

- **Unified source code comments to English** — Translated JSDoc comments in `src/core/design-tokens.ts` from Korean to English for codebase-wide language consistency.

## [0.21.1] - 2026-05-06

### Refactored

- **`authorType` made required on `ChatMessage`** — The field was declared optional but every code path always set it (parser defaults to `'normal'`). Making it required eliminates 5 `NonNullable<>` wrappers and the `|| 'normal'` fallback in `getAuthorType()`.

- **Removed dead code and redundant checks** — Removed unreachable `if (!chosen)` guard in lane allocator (pool is always non-empty), deleted duplicate `activeMessages.clear()` after remove-message loop, eliminated unused `_scope` parameter from `applyNumberInputAttributes`.

- **Inlined `TupleValue` utility type** — The one-line abstraction was used only in `types/index.ts`. Inlined all 5 usages to direct indexed-access patterns.

- **Simplified fetch signal passing** — Replaced conditional object spread `...(signal ? { signal } : {})` with direct `signal: signal ?? null` in both `fetchWatchHtml` and `fetchChatEndpoint`.

- **Optimized `sweepStaleAnimations` early-exit** — Moved the `activeMessages.size === 0` check before the counter modulo to avoid unnecessary integer ops when no messages are active.

## [0.21.0] - 2026-05-05

### Added
- **Save confirmation feedback on apply button** — Settings apply button now shows visual feedback on successful save.

### Fixed
- **Replay buffer binary insertion and emoji detection** — Fixed binary insertion ordering for replay buffer continuity and broadened emoji detection patterns to catch more unicode emoji variants.
- **Image error listener once-flag, float-tolerance comparison, RGBA hex support** — Added `{ once: true }` to image error listeners to prevent duplicate callbacks, applied epsilon-based float comparison for precision-safe operations, and added RGBA hex color format (`#RRGGBBAA`) support.
- **Set iteration safety and apply button persistence** — Fixed `Set.prototype.entries()` iteration during mutation (converted to snapshot iteration) and prevented apply button from persisting across settings UI re-create cycles.
- **Abort error, health snapshot, replay fetch critical bugs** — Corrected `isAbortError` type guard to properly detect DOMException-based aborts, fixed health snapshot stale reference in recovery flow, and resolved replay continuation fetch error handling.
- **Idle marker clearing before health check** — Cleared idle markers before running health checks in `handleRuntimeResume` to prevent false-positive recovery triggers.
- **Circular dependency causing RENDERER_LAYOUT undefined** — Resolved import cycle between renderer and layout modules.
- **Stale queuePreview timer in settings** — Guarded `queuePreview` timer against stale callback execution after settings UI destruction.
- **Render queue timestamp sorting** — Messages in render queue are now sorted by timestamp for correct chronological chat order.
- **Rate limit check moved to render time** — Moved rate limiting from enqueue time to actual render time for accurate throttle measurement.
- **Stale animation cleanup sweep in processQueue** — Added cleanup sweep for orphaned animations during queue processing.
- **Replay dedup key limit increased** — Raised `seenMessageIds` limit from 2000 to 10000 to prevent premature dedup key eviction in long replay sessions.
- **Renderer resetState clears seenMessageIds** — `resetState()` now properly clears message dedup tracking to prevent stale dedup keys after re-sync.

### Performance
- **Reduced sweepStaleAnimations frequency** — Counter-based throttling added to reduce expensive DOM queries during idle cleanup sweeps.
- **Batch-process ready messages in single pass** — Messages ready for rendering are now processed in one batch pass instead of individually, reducing per-message overhead.

### Refactored
- **ChatSource split into LiveChatSource and ReplayChatSource** — Separated live and replay chat source implementations for clearer responsibility boundaries and reduced branching.
- **OverlayView interface removed** — Inlined the `OverlayView` interface directly into `Overlay`, removing an unnecessary abstraction layer.
- **RENDERER_LAYOUT merged into design-tokens** — Consolidated layout tokens into `design-tokens.ts` and removed the standalone `renderer-layout.ts` module.
- **Settings modules consolidated** — Reduced settings module count through consolidation of closely related modules.
- **Duplicate patterns consolidated** — Consolidated duplicate patterns across `MessageIdRegistry`, fetch payload construction, and settings schema validation.
- **Round-robin lane selection** — Replaced `Math.random` lane selection with deterministic round-robin distribution for more consistent message placement across lanes.
- **Excessive nullable fallbacks and defensive code removed** — Simplified code by removing unnecessary null checks and defensive patterns across core modules.
- **renderer-layout.ts merged into renderer.ts** — Consolidated remaining layout logic directly into `Renderer`.
- **Unused exports, redundant types, and trivial helpers removed** — General dead code cleanup across the codebase.

### Dependencies
- **devDependencies updated** — `@biomejs/biome`, `@types/node`, `knip`, `vite`, `typescript` updated to latest compatible versions.

### Tooling
- **build: replaced rimraf with native rm -rf** — Removed `rimraf` dev dependency in favor of native `rm -rf` shell command.
- **chore: replaced npx with pnpm dlx** — Updated circular dependency check script to use `pnpm dlx` instead of `npx`.

## [0.20.0] - 2026-05-04

### Added
- **SuperChat/membership card enhanced visuals** — improved styling for SuperChat, membership, and sticker messages with distinct backgrounds, icons, and metadata layout.
- **Backdrop overlay and modal open animations** — settings UI now features a dimmed backdrop and smooth open/close transitions with responsive sizing.
- **Live preview mode** — all numeric and toggle settings now apply immediately on change without requiring manual save, providing instant visual feedback.
- **Reset confirmation dialog** — clicking "Reset to defaults" now shows a confirmation dialog before clearing all settings.

### Fixed
- **Replay fetch busy-loop** — `ChatSource` now applies consecutive-failure exponential backoff to prevent infinite retry loops when replay continuations consistently fail.
- **Overlay container DOM leak** — `Overlay.destroy()` now removes the container from DOM and prevents duplicate `ResizeObserver` instances on repeated create/destroy cycles.

### Performance
- **Watchdog health check while paused** — `RuntimeSession` now skips chat source health checks when the video is paused, reducing unnecessary polling and CPU usage.

### Refactored
- **Settings UI tab reorganization** — settings form reorganized into logical tab groups (General, Appearance, Layout) for better usability.
- **Settings button repositioned** — moved from top-right to top-left with improved visibility and reduced overlap with YouTube UI.

### Dependencies
- **devDependencies updated** — `@biomejs/biome`, `@types/node`, `knip`, `vite` updated to latest compatible versions.

## [0.19.1] - 2026-05-03

### Fixed
- **Long pause timeline skew** — `Renderer` lane collision and rate limiter now cap timeline shifts at 60 seconds, preventing messages from being blocked after the user returns from a long idle (e.g., tab hidden for 30+ minutes).

### Refactored
- **UI formatting extracted** — moved `formatRootNumericSettingForInput`, `normalizeRootNumericInputValue`, `getRootNumericInputAttributes` and outline equivalents from `settings-schema.ts` into a new `settings-ui-format.ts` module. `settings-schema.ts` now focuses on pure data validation/sanitization.
- **Runtime session restart logic simplified** — removed optional `details` parameter from `requestManagedRestart()`; health snapshot is computed inline instead of being passed around by callers, eliminating duplicate health calculations.
- **Replay continuation catch-up inlined** — merged `catchUpFallbackReplay` logic directly into `pollContinuationReplay`; removed `REPLAY_FALLBACK_CATCHUP_BATCH_LIMIT` and `REPLAY_BUFFER_REFILL_THRESHOLD` constants.
- **Dead code removed** — unused `@/` path alias removed from `vite.config.ts`, `tsconfig.json`, and `knip.json`.

## [0.19.0] - 2026-05-03

### Refactored
- **Settings layer consolidation** — reduced from 6 files to 3 files (-50%)
  - Merged `settings-form.ts` into `settings-schema.ts` (UI input formatting unified with schema)
  - Merged `settings-storage.ts` into `settings.ts` (localStorage I/O inlined)
  - Removed unused `tsconfig.build.json`
  - Removed duplicate script aliases (`typecheck`, `fmt:check`, `quality:ci`)
- **Utility files merged** — 3 standalone utility files eliminated
  - `abort.ts` → `dom.ts` (isAbortError, combineAbortSignals)
  - `json.ts` → `youtubei-chat.ts` (JSON helper types/functions)
  - `image-url.ts` → `youtubei-chat.ts` (normalizeYouTubeImageUrl)
- **SettingsUi split** — 851-line file reduced to 298 lines (-65%)
  - Extracted DOM factory and form data methods into new `SettingsUiForm` class (`settings-ui-form.ts`, 601 lines)
  - `SettingsUi` now owns only lifecycle (attach/open/close/destroy) and event binding
- **Perfomance**: `Settings.get()` no longer deep-clones the settings object on every read
- **Cleanup**: Removed unused `MessageIdRegistry.release()` method
- **Bug fix**: Removed `removeLeftoverOverlays()` dead null-safe check (`overlay` always null at call site)
- **Bug fix**: Fixed circular dependency `logging.ts` ↔ `settings.ts` by moving `readStoredLogLevel` to `settings-definitions.ts`

## [0.18.1] - 2026-05-03

### Changed
- **Codebase simplification** — reduced total code size by ~220 lines
  - Removed `VideoSync` MutationObserver, periodic detection, and reinitialization timer (~211 lines removed); element replacement handling is now fully delegated to `RuntimeManager`'s session restart
  - Simplified `Settings.loadSettings()` double-fallback (moved fallback into catch block)
  - Unified import paths: replaced relative imports (`./design-tokens.js`, `./overlay`) with `@core/` alias across `renderer.ts` and `settings-ui-styles.ts`
  - Removed dead CSS rule `input[type="text"]:disabled` from `settings-ui-styles.ts`
  - Simplified `Renderer.forEachAnimation` by removing per-operation warn log (individual animation failures are negligible)
  - Removed unused `export` from `normalizeSettings` and `createDefaultSettings` in `settings-schema.ts`

## [0.18.0] - 2026-05-01

### Changed
- **Codebase simplification** — reduced total code size by ~120 lines
  - Removed `timers.ts` wrapper module, use `clearTimeout`/`clearInterval` directly
  - Simplified `abort.ts` `combineAbortSignals` (removed redundant length checks)
  - Rewrote `settings-schema.ts`: removed `SettingDefinition` type system, `normalizeSettingValue`/`assignNormalizedSetting` abstractions → direct `clampNumber` calls
  - Rewrote `settings-form.ts`: removed `SettingDefinition` indirect refs, dead `getOutlineNumericInputOptions` → direct mapping tables
  - Simplified `settings-ui.ts`: removed `ROOT_SETTING_DEFINITIONS`/`OUTLINE_SETTING_DEFINITIONS` dependencies → direct key checks
  - Reduced `Renderer` queue size 150→30, lookahead 20→10, `MessageIdRegistry` 1000→200
  - Removed duplicate `isRecord` from `settings-schema.ts` (use `@core/json`)
  - Removed `@biomejs/cli-linux-x64` (bundled in `biome`), `pnpm.overrides`
  - Tightened `ImageAsset.candidateUrls` from array to single `candidateUrl` to reflect max one fallback retry

### Fixed
- **ChatSource poll loop race condition** — increment `pollGeneration` in `start()` before creating new `AbortController` to prevent stale poll loops from doing extra work after restart
- **VideoSync interval leak** — assign `setInterval` result to local variable first, then to `detectInterval` to eliminate re-entry window
- **Emoji text message filter** — `isSubstantialMessage` now also checks `body.text` for unicode emoji pattern, preventing emoji-only messages from being filtered when emoji arrives as plain text
- **Overlay animations during seeking** — `VideoSync.handleSeeking` now also fires `onPause` callback, preventing messages from flowing while user is scrubbing
- **Overlay flicker on re-creation** — `Overlay.destroy()` hides container (`display:none`) instead of removing from DOM; `create()` reuses existing container if available
## [0.17.0] - 2026-04-30

### Changed
- **Dependency updates**
  - Updated `@biomejs/biome` to the latest version
  - Maintenance updates for `typescript`, `vite`, and other key dev dependencies

### Tooling
- **Project configuration modernization**
  - Bump `package.json` version to 0.17.0
  - Update Biome config schema version
  - Verify TypeScript path aliases and build configuration

## [0.16.0] - 2026-04-19

### Added
- **Multi-candidate image asset URLs and text fallback support**
  - Preserve multiple candidate URLs for emoji/sticker thumbnails to enable sequential retry at render stage
  - If an image ultimately fails to load, fall back to human-readable text to preserve message meaning

### Changed
- **Runtime session restart/recovery flow restructured**
  - Unified foreground return, playback resume, seeking, and watchdog into a managed restart contract for `RuntimeSession`/`RuntimeManager`
  - Instead of in-place reconnect after long hidden/paused periods, recreate the session to reduce stale state accumulation
- **Emoji/badge normalization improvements**
  - Cleaned up alias-form emoji shortcuts into human-readable visible fallback text
  - Expanded membership / verified / moderator / owner badge classification priority and detection scope to improve author type display accuracy

### Fixed
- **Video/chat state inconsistency recovery stability**
  - Adjusted watchdog to request session restart when overlay/video/chat surfaces are not renderable or observer is inactive
  - Reduced lingering old session state issues during foreground return / playback resume
- **Mitigated message loss on image load failure**
  - Added candidate retry and fallback text for image-based emoji and stickers so they are not lost on first URL failure

### Tooling
- **Dependency maintenance**
  - Include maintenance changes for `@napi-rs/wasm-runtime`, `postcss`, `@biomejs/biome` in this release scope

## [0.15.0] - 2026-04-18

### Added
- **Unified rich-content based chat display path**
  - Normalized plain text, emoji, and membership-only image emoticons into the same `ContentSegment[]` path to standardize rendering criteria
  - Added support for `liveChatPaidStickerRenderer` and membership `headerSubtext` fallback to include previously missing chat types

### Changed
- **Image asset normalization and render measurement stabilization**
  - Normalize protocol-relative / permitted-host `http` image URLs to `https` at parse stage for more consistent paid sticker and other image asset handling
  - Changed emoji/sticker dimension metadata to be used directly by renderer for more stable measurement and lane placement before image load
- **Message model cleanup**
  - Fixed `ChatMessage.content` as the canonical source for actual display; `text` is now a derived plain text field for dedup/logging/fallback

### Fixed
- **Mitigated emoji and image-based chat omission**
  - Adjusted content-aware visible length criteria to prevent short plain-text filter from discarding image-centric messages
  - Added alt text fallback on image load failure so message meaning is not completely lost

### Tooling
- **Security/CI automation maintenance**
  - Include security, CI, release, version-check, Dependabot, stale PR workflow, and repository settings maintenance changes in this release scope

## [0.14.0] - 2026-04-18

### Added
- **youtubei-based chat collection path introduced**
  - Restructured to bootstrap/poll chat directly from watch page / youtubei endpoint instead of relying on visible live chat panel DOM
  - Handle live and replay through the same chat runtime; add continuation / payload extraction paths needed for resynchronization
- **Seek-specific recovery reason added**
  - Distinguish seeking events as a separate recovery reason to more clearly express the intent of chat resynchronization immediately after seeking

### Changed
- **Chat session and recovery lifecycle redesigned**
  - Abort signal combination, polling replacement, and generation management to prevent stale work from polluting current session state during reconnect/restart
  - Removed live edge DOM threshold dependency; simplified recovery flow with observer/activity-centric health assessment
- **Settings definition/input normalization structure cleanup**
  - Separated default settings, numeric limits, input format / normalization logic into distinct modules; clearly delineated responsibilities among settings UI / schema / storage

### Fixed
- **Reconnection/resynchronization race stability improved**
  - Reduced possibility of duplicate work and state entanglement during recovery through resume sync serialization, replay buffer management, and poll loop replacement

### Tooling
- **Development tool updates**
  - Updated `@biomejs/biome` to `2.4.12`

## [0.13.0] - 2026-04-17

### Added
- **Live edge resynchronization introduced**
  - Added synchronization flow to realign to live edge after chat reconnect/reopen, strengthening recovery based on latest chat timeline
  - Combined scroll correction and live edge tracking for more stable message flow after panel state changes

### Changed
- **Chat surface detection scope expanded**
  - Expanded selector surface to include watch page `#chat` host, `ytd-live-chat-frame`, and secondary column toggle button
  - Refined toggle button detection with aria/text-based heuristics to better accommodate layout and localization differences

### Fixed
- **Mitigated backlog contamination on disconnect/recovery**
  - Clean up stale queued messages on disconnect to reduce delayed old message injection after reconnection
  - Refined chat host/iframe transition and scroll restoration paths for more stable container reacquisition and recovery

### Refactored
- **Code cleanup and fallback reduction**
  - Removed dead code and redundant fallbacks around `renderer`, `chat-source`, `video-sync`, `runtime-manager`, `settings-schema`, `settings-ui`
  - Simplified selector/settings schema structure to reduce maintenance overhead

## [0.12.2] - 2026-04-17

### Changed
- **Comment flow continuity improved**
  - Added cross-lane stagger so chat bursts don't synchronize and leave blank screens
  - Changed recovery/resume resynchronization to keep active comments intact and only clean up the queued backlog, preventing in-flight comments from disappearing entirely

### Fixed
- **Mitigated duplicates and omissions on reconnect/resync**
  - Use chat DOM-based message id as dedup key to reduce duplicate display of the same comment after reconnect/resume
  - Allow re-injection of recently removed latest comments during recovery when needed, for a more natural flow after recovery
- **Chat panel acquisition stability improved**
  - Added polling to the panel open path to more reliably acquire the live chat surface even when YouTube DOM reflection is delayed

### Refactored
- **Logging API unified**
  - Consolidated overlay logging call paths to a `createLogger`-based approach for more consistent diagnostics

## [0.12.1] - 2026-04-17

### Refactored
- **Settings/logging path cleanup**
  - Simplified `RuntimeSession` / `Settings` / `logging` flows to reduce redundant branching and maintenance burden
- **Removed unnecessary code**
  - Cleaned up unused helpers and legacy paths around `chat-dom` / `chat-source` / `renderer` / `overlay`

### Tooling
- **Runtime environment updated**
  - Aligned Node.js baseline version to 24.15.0 and reflected libc support in pnpm lockfile

## [0.12.0] - 2026-04-16

### Added
- **Explicit chat start/resolution state contract introduced**
  - Structured `ChatSource` / `RuntimeSession` / `RuntimeManager` to share `started` / `retryable` / `unavailable` results, preventing infinite restart loops when a chat surface exists but cannot be started
- **Chat selector metadata structured**
  - Reorganized frame / iframe / container / toggle selectors in `chat-dom.ts` into descriptors with purpose, priority, and surface information for clearer detection order and diagnostic logging

### Changed
- **Navigation and reconfiguration flow simplified**
  - `PageWatcher` now integrates history hook, `yt-navigate-finish`, and URL polling into a single deduped signal contract
  - URL polling is reduced to a fallback / watchdog role instead of the default path, lowering the chance of duplicate reconfiguration during SPA navigation
- **Runtime/renderer setting application stabilized**
  - Session now determines whether a renderer reset/resync is needed when settings change
  - Removed startup delay and added partial cleanup on failed initialization for more predictable app lifecycle
- **Video/settings storage logic cleaned up**
  - Serialized `VideoSync` initialization / re-initialization to prevent races on video replacement
  - Unified legacy `debugLogging` → `logLevel` migration into the settings module

### Fixed
- **Settings UI not opening under YouTube Trusted Types environment**
  - Changed settings modal HTML generation to use Trusted Types policy for compatibility with YouTube document policy
- **UI remnant after navigating to non-target pages**
  - Destroy settings button when navigating to non-watch/live pages to prevent leftover buttons
- **Infinite retry on unsupported live chat iframe fixed**
  - When live chat iframe returns an "older browser" notice instead of actual chat, settle as `unavailable` to eliminate unnecessary retry churn

### Tooling
- **Release note compare tag selection fixed**
  - Changed release workflow to select the nearest lower semver tag rather than the current version, preventing incorrect compare links caused by malformed tags like `v7.0.0` / `vv7.0.0`
- **Workflow/quality tool maintenance**
  - Include security / CI workflow cleanup and dev dependency maintenance changes in this release scope

## [0.11.0] - 2026-04-15

### Added
- **Background return/chat health recovery flow strengthened**
  - Added runtime session recovery path that performs resync/restore based on chat source survival, recent activity, and live edge status after visibility return
  - Re-check chat panel state before reconnecting the chat observer; orchestrate latest message sync more reliably during recovery

### Changed
- **Runtime restart and session management restructured**
  - Serialized page transition, setting application, restart, and recovery flows more clearly around `RuntimeManager`/`RuntimeSession`
  - Simplified navigation settle/retry handling and start failure state management for more predictable restart behavior
- **Log/DOM utility cleanup**
  - Adjusted chat DOM validation logging to debug level to reduce console noise
  - Consolidated video/player selectors and timer cleanup utilities into shared modules for unified DOM query/cleanup responsibility

### Refactored
- **Settings/video sync implementation simplified**
  - Split setting normalization into small helpers to reduce repetitive code while retaining `localStorage`-based runtime validation
  - Cleaned up internal listener/observer connection code in `VideoSync` to eliminate unnecessary null-checks

### Fixed
- **Reduced recovery race and state contamination possibility**
  - Lowered the chance of stale work polluting current session state during background return, chat health recovery, and observer reconnection
  - Unified timer/listener cleanup paths to further reduce the possibility of missed cleanup

### Tooling
- Aligned Biome/Knip schema paths with latest tool versions

## [0.10.0] - 2026-04-14

### Added
- **Chat DOM responsibility separation module added**
  - New `src/core/chat-dom.ts`: separates frame/iframe/container selectors, container validation, debug DOM scanning, and chat frame visibility detection logic

### Changed
- **Logging structure switched from global patch to explicit wrapper**
  - Introduced `overlayLog.debug/info/warn/error` API
  - Removed global `console.log` monkey patch
  - Maintained existing log level (`warn`/`info`/`debug`) and info-level verbose suppression policy
- **Chat observer recovery strategy improved**
  - Added duplicate execution guard and bounded burst retry (3 attempts) to `ChatSource.reconnect()`
  - Clarified chat panel state check procedure before reconnect

### Refactored
- **`ChatSource` class simplified**
  - Extracted internal constants/helpers for DOM navigation/validation into modules to clarify responsibility boundaries
  - Chat source now focuses on message parsing/observation/reconnection orchestration

### Fixed
- **Stability improved by removing aggressive fallback**
  - Removed path that directly removed `collapsed`/`hidden` attributes on chat panel open failure
  - Reduced possibility of unexpected state contamination from direct YouTube DOM manipulation

## [0.9.0] - 2026-04-13

### Added
- **Playback resume chat snapshot sync API added**
  - Added `ChatSource.getLatestMessages(limit)`: collects latest valid messages from current chat container in reverse order and returns them chronologically

### Changed
- **Pause→play resume flow redesigned as consistent resync approach**
  - Instead of simple `resume()` on play event, perform resync orchestration
  - Clear old backlog accumulated during pause, then reinject latest chat state for instant comment refresh

### Refactored
- **Renderer resync initialization method introduced**
  - Added `Renderer.resetForResync()`: clears active animations/queues and reinitializes lane state
  - Added duplicate resync guard (`resumeSyncInProgress`) to `App` for improved race stability on play events

## [0.8.0] - 2026-04-12

### Added
- **Background tab handling improved (Page Visibility API)**
  - Automatically pause renderer when tab is hidden to prevent message burst on return due to browser timer throttling
  - Resume renderer on tab return only if video is playing (respecting pause state)
- **Chat MutationObserver monitoring and reconnection**
  - Added monitoring loop checking observer survival every 15 seconds
  - Automatically reconnect observer when YouTube unmounts the chat `#items` container
- **Message queue initialization on Seek**
  - Clear pending message queue on video seek events to prevent stale messages after seeking

### Fixed
- **Prevent infinite message queue growth**
  - Cap pending queue at 150 items; remove oldest entries when exceeded
- **Prevent lane leak on animation cancellation**
  - Also handle `cancel` event alongside `finish` event to properly clean up elements from `activeMessages` when animation is externally interrupted

### Changed
- **Settings UI redesigned with tabs**
  - Categorized settings into 4 tabs: Display / Style / Authors / Filter
  - Improved item names for intuitiveness (e.g., "Safe top/bottom" → "Top/Bottom Clear Zone", "Speed (px/s)" → "Scroll Speed (px/s)")
  - Persist last active tab on tab re-entry
  - Prevent hidden tab panel input elements from being included in focus trap

## [0.7.2] - 2026-04-01

### Fixed
- **SPA navigation restart stability improved**
  - Added protection to skip stale restart when URL changes again while waiting for settle during navigation restart
  - Applied generation-based guard (`startGeneration`) and ownership check (`this.chatSource !== chatSource`) in `startChatSource()` to prevent previous instance from injecting messages or polluting state during async start races
  - Explicitly clean `this.chatSource` reference on chat source start failure for more consistent cleanup/restart paths

### Dependencies
- Dev dependency adjustment: downgraded `@biomejs/biome`, `@biomejs/cli-linux-x64` to `2.4.9`

## [0.7.1] - 2026-03-31

### Fixed
- **Comment diagonal placement pattern fixed**
  - Replaced `findLanePlacement` algorithm from deterministic sequential selection to random selection: diagonal staircase pattern caused by messages always being assigned top→bottom (lane 0→1→2→...) during chat bursts
  - When multiple lanes are immediately available, randomly select from the full candidate pool for uniform distribution across the screen
  - Replaced lane delay from deterministic value proportional to lane index (`(index % 3) × 15ms`) with 0–45ms random jitter to remove visual alignment patterns for simultaneous entry messages

## [0.7.0] - 2026-03-31

### Changed
- **Message display density improved**
  - Reduced lane height multiplier (`BASE_LANE_HEIGHT_MULTIPLIER`) from 1.3 to 1.2 for approximately 8% more available lanes
  - Reduced horizontal safe distance (`SAFE_DISTANCE_SCALE`) from 0.5 to 0.3, minimum from 10px to 6px for denser message packing within lanes
  - Shortened vertical clear time from 40–160ms to 20–80ms for faster lane reuse
  - Explicitly apply `line-height: 1.1` to message elements — ensures single-line messages fit exactly in one lane across all supported font sizes (18–40px)
- **Default setting adjustments**
  - `safeTop` default 0.1 → 0 (removed top safe zone, display from video top edge)
  - `safeBottom` default 0.15 → 0.4 (keep bottom 40% clear for full player control protection)
  - `maxConcurrentMessages` default 30 → 40 (raised to match additional lanes)
  - `maxMessagesPerSecond` default 4 → 6 (raised throughput to match density improvement)
  - `safeBottom` setting upper limit 0.25 → 0.5 (adjustable up to 50% in settings UI)

### Refactored
- **Removed common utility duplication**
  - Extracted `parseRgbColor()` function to `design-tokens.ts` — eliminated inline RGB parsing duplication in `renderer.ts`·`chat-source.ts`
  - Moved `findPlayerContainerElement()`·`ensurePlayerPositioning()` to `dom.ts` — unified duplicate implementations in `overlay.ts`·`settings-ui.ts`
  - Consolidated `PLAYER_CONTAINER_SELECTORS` into `dom.ts` — replaced 2 independently defined selectors in `video-sync.ts` with a shared array of 4 selectors
  - Exported `STORAGE_KEY` from `settings.ts` and removed duplicate constant in `logging.ts`
- **Other code quality improvements**
  - Added condition to only execute `debugLogChatElements()` when `logLevel === 'debug'`
  - Cleaned up field name `_renderer` → `renderer` in `main.ts`, removed empty `handleVideoSeeking` handler
  - Removed `@ts-expect-error` in `renderer.ts`
  - Removed unused `animation` tokens from `design-tokens.ts`

### Dependencies
- Updated dev dependencies: knip ^6.1.0, Biome, Vite, TypeScript, @types/node, etc.

## [0.6.0] - 2026-03-06

### Added
- **Lane spacing setting added**
  - Introduced `laneSpacing` option to allow adjusting vertical gap between message lanes
  - Added input item and range limit in settings UI for direct lane spacing adjustment

### Changed
- **Core-wide refactoring for consistency and maintainability**
  - Enhanced responsibility separation in `chat-source`, `overlay`, `page-watcher`, `renderer`, `settings`, `settings-ui`, `video-sync`, `main`; consolidated redundant logic into helpers/constants
  - Standardized app initialization/restart/cleanup flow for more stable handling of SPA navigation and async re-initialization scenarios
  - Cleaned up `types/index.ts`, `globals.d.ts` for clearer expression of shared types, default settings, and debug handle contracts
- **Build/deploy metadata generation improved**
  - Restructured `tooling/userscript-header.ts` around constants and format helpers for concise userscript header generation

### Fixed
- **Image/DOM/state management stability improved**
  - Strengthened image URL permitted host validation for safer profile/emoji/sticker processing paths
  - Improved type/state handling consistency for video reacquisition, overlay re-creation, setting merging, and element waiting
  - Reinforced existing instance cleanup and global debug handle initialization flow to reduce collision potential on reinjection/restart

### Tooling
- Performed type/format/dead code cleanup aligned with quality gate (`pnpm quality`) and passed full workspace validation

## [0.5.1] - 2026-03-05

### Fixed
- **Double comment display on initial page load fixed**
  - Added cancel flag (`stopped`) to `ChatSource.start()`: prevented MutationObserver from being reconnected after `stop()` call while async loop continued. Check cancel status after every `await` to prevent cleaned-up instances from polluting state
  - Added generation-based cancel token (`startGeneration`) to `App.start()`: fixed race condition where stale async tasks completing after `cleanup()` would incorrectly set `isInitialized`·`lastStartedUrl` and other app state
  - Removed `forceNotify` from `yt-navigate-finish` event handler: fixed issue where YouTube generated an event with the same URL during initial page setup, causing unnecessary cleanup+restart cycles. URL change detection is handled by existing `pushState`/`replaceState` patches and `popstate` listener
  - Added `WeakSet`-based DOM-level message dedup: if YouTube inserts the same DOM node into `#items` twice (history replay, chat panel reset, etc.), prevent duplicate display
  - Pre-clean existing App instance in `initApp()`: fully release resources via `.stop()` before creating new instance to prevent observer nesting

### Dependencies
- Updated devDependencies: pinned Node.js 24.14.0·pnpm 10.27.0, `@types/node` ^25.3.3, `@biomejs/biome` ^2.4.4, `knip` ^5.85.0, `vite` ^7.3.1, `typescript` ^5.9.3

### CI
- Added Rollup transitive dependency security vulnerability override
- Improved CI security audit gate and OSV scan conditions
- Refined workflow triggers and annotations

## [0.5.0] - 2026-02-20

### Added
- **Settings UI expansion**
  - Added log level selection (`warn`/`info`/`debug`) option
  - Added short text message filter options (`allowShortTextMessages`, `minTextLength`)
  - Enhanced author-type display and color control options
- **Log control module added**: level-based output filtering support for overlay logs
- **Image URL validation module added**: common domain validation for author profile/emoji/sticker images

### Changed
- **Chat detection and panel open stability improved**
  - Strengthened iframe/in-page chat container detection and validation logic
  - Improved auto-open attempt logic when chat panel is closed
- **Settings UI input validation/sanitization enhanced**
  - Clamp numeric inputs to valid range
  - Unified UI input units for some percentage-based settings
- **Renderer image processing unified**
  - Consolidated emoji/sticker/author image generation paths into common helper

### Fixed
- **Settings migration improved**
  - Safely map legacy `debugLogging` setting to new `logLevel`
- **Settings modal accessibility improved**
  - ESC close, focus trap, initial focus/focus return handling enhanced

### Dependencies
- Updated Biome and Biome CLI to `2.4.2` (`@biomejs/biome`, `@biomejs/cli-linux-x64`)

## [0.4.2] - 2026-02-18

### Fixed
- **Message filtering improved**: Changed `parseMessage()` to first determine message kind by tag name, then parse content
  - Explicitly filter Super Sticker (image-only, `yt-live-chat-paid-sticker-renderer`)
  - Strengthened system message filtering (`viewer-engagement`, `banner`, `placeholder`, etc.)
  - Always display membership items even without `#message` (support for textless membership events)
  - Always display Super Chat regardless of text body presence
  - Removed unnecessary `'other'` type from `ChatMessage.kind`
- **Renderer lane placement optimization**: Improved message flow and spacing
  - `LANE_DELAY_MS` 40ms → 15ms (throughput improvement)
  - `SAFE_DISTANCE_SCALE` 0.7 → 0.5, `SAFE_DISTANCE_MIN` 16px → 10px (tighter horizontal packing)
  - `VERTICAL_CLEAR_TIME` 120/320ms → 40/160ms (reduced since horizontal readiness check is the primary factor)
  - `QUEUE_LOOKAHEAD_LIMIT` 14 → 20 (wider scheduling window)
  - Added LRU tie-breaking to `findLanePlacement()`: when wait times are equal, prioritize the least recently used block → even message distribution across screen

### Changed
- **Default setting values readjusted**: readability・screen occupancy balance improved
  - `speedPxPerSec`: 200 → 280 (faster scroll reduces screen occupancy time)
  - `fontSize`: 24 → 20 (reduced area per message)
  - `opacity`: 0.95 → 0.85 (better video visibility)
  - `superChatOpacity`: 0.4 → 0.35
  - `safeBottom`: 0.12 → 0.15 (prevent control bar occlusion)
  - `maxConcurrentMessages`: 50 → 30
  - `maxMessagesPerSecond`: 10 → 4 (protect screen readability during chat bursts)
- **DOM cleanup code simplified**: removed unnecessary branches, unified `element.remove()` pattern
- **Logging improved**: enhanced chat monitoring related log messages

### Dependencies
- Downgraded Biome and Biome CLI to stable versions (`@biomejs/biome`, `@biomejs/cli-linux-x64`)

## [0.4.1] - 2026-02-16

### Fixed
- **Memory leak prevention**: improved resource cleanup across all components
  - PageWatcher: fully clean history API wrappers, event listeners, intervals
  - Overlay: added fullscreenchange event listener removal
  - Renderer: explicitly clear overlay reference to prevent circular references
  - ChatSource: improved MutationObserver and reference cleanup
  - SettingsUi: complete removal of DOM elements and styles
- Improved resource release on page navigation and app restart

### Changed
- **Code consistency improvement**: unified all destroy() methods with standardized pattern
  - Cleanup order: timers/intervals → event listeners → Observer → DOM elements → references
  - Added section comments for readability
- **Logging unified**: applied consistent log prefixes per class (`[App]`, `[Overlay]`, `[Renderer]`, etc.)
- **Main.ts optimization**: simplified cleanup() flow and removed unnecessary try-catch
- Improved null check patterns using optional chaining

### Dependencies
- Updated `@types/node` to version 25.2.3
- Updated dev dependencies (quality group)

## [0.4.0] - 2026-02-14

### Added
- Super Chat parsing/rendering support (including dynamic color mapping and gradient background)
- Author profile image display and author-type display options
- Added Super Chat exclusive opacity option in settings UI
- Added design tokens module for renderer/settings UI style consistency

### Changed
- Refactored multiline message handling and lane placement logic for reduced collision
- Optimized lane height calculation and message element creation flow for rendering stability/performance
- Adjusted default Super Chat opacity value for improved readability

### Fixed
- Improved font size and animation time processing consistency between regular messages and Super Chat

### CI/Tooling
- Added Knip configuration and integrated dependency analysis into quality/CI pipeline
- Improved CI, release, Dependabot, repository automation workflow configuration

## [0.3.1] - 2026-02-10

### Changed
- Unified version management baseline to `package.json`

## [0.3.0] - 2026-02-09

### Added
- Video playback synchronization: animations pause when video pauses, resume when video plays
- Message queuing system: messages queue during pause and display when resumed
- Playback rate synchronization: animation speed matches video playback speed (0.25x - 2x)
- Video element replacement detection: auto-reinitialization during ad transitions
- System message filtering: blocks "Live chat replay" and other system notifications
- New VideoSync module for robust video element detection and monitoring

### Changed
- Refactored Renderer with forEachAnimation() helper method for cleaner code
- Extracted magic numbers to CONFIG constants in VideoSync
- Enhanced chat message parsing with isUserMessage() filtering logic

### Improved
- Periodic video detection with fallback strategy
- MutationObserver for handling dynamic video element changes
- Error handling for animation operations

## [0.2.0] - 2026-02-08

### Added
- Emoji support in chat messages with advanced rendering capabilities.
- Security validation for chat message content to prevent XSS and injection attacks.

### Fixed
- Regex pattern in meta.js generation for userscript header metadata.

### Changed
- Enhanced chat message processing with improved text sanitization.
- Updated Dependabot configuration and GitHub workflows for better automation.

## [0.1.1] - 2026-02-07

### Added
- Release distribution via release branch + jsDelivr with generated `.meta.js`.
- GitHub workflows and community health files for CI, security, and templates.

### Changed
- Comment lane spacing and timing to reduce overlap and ensure messages exit fully.
- README install links for stable and metadata update URLs.

### Fixed
- Prevent settings modal from opening during chat panel auto-open logic.

## [0.1.0] - 2026-02-06

### Added
- Nico-nico style live chat overlay for YouTube streams and premieres.
- Settings panel (⚙) to control speed, font size, opacity, safe zones, colors, and outline.
- Automatic handling of YouTube SPA navigation and chat panel detection.
- Collision-aware lane rendering to reduce comment overlap.
- Local-only processing with no chat data storage or transmission.
