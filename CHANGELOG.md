# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- **Half-cell lane density during burst traffic** — When comments flood, the lane grid subdivides to finer resolution, doubling placement opportunities.
  - Normal/elevated burst: `laneDensityFactor = 1.0` (full-cell, no change)
  - High burst: 0.75 (transitional, 33% more lanes)
  - Extreme burst: 0.5 (half-cell, 2× lane count)
  - Effective lane height = `rawLaneHeight × laneDensityFactor`, applied in both main-thread `LaneAllocator` and Worker renderer
  - Density transitions are burst-driven and automatic; active messages survive unchanged
  - Worker synced via `laneDensity` protocol message

## [0.42.0] - 2026-07-04

### Added

- **Native `<dialog>` for settings modal** — Replaced custom backdrop div, focus trap, ESC handler, scroll lock, and `body.inert` with browser-native `showModal()`. Added `commandfor` progressive enhancement for declarative dialog control (Chrome 134+).
- **Ignore Reduced Motion setting** — Advanced → Developer checkbox that overrides OS-level `prefers-reduced-motion: reduce`, forcing scroll animations regardless of system accessibility settings.
- **Native Popover API for tooltips** — Replaced `title` attribute tooltips with `popover=hint` elements for better positioning and accessibility.
- **Modern CSS features** — `field-sizing: content` for auto-sizing inputs, `@starting-style` for dialog entry animations, anchor positioning helpers, `mask-image` scroll fade indicators.
- **Canvas live region mirroring** — Offscreen `aria-live` region updated with visible message snippets so screen readers, find-in-page, and translation tools can discover canvas-rendered text.
- **Font settings redesign** — Live preview text, font family chips with visual samples, weight toggle pills, datalist autocomplete for font selection.
- **`scheduler.yield()` + `scheduler.postTask()`** — Cooperative scheduling during heavy drain operations with Safari fallback.
- **INP monitoring** — `PerformanceObserver` tracking Interaction to Next Paint for settings UI responsiveness.
- **`aria-invalid` bridge and `aria-required`** — Real-time validation feedback on number inputs, screen-reader error announcements.
- **i18n parity check in quality gate** — `check-i18n-parity.ts` consolidated from 3 duplicate scripts, wired into `prebuild`.

### Fixed

- **Dialog permanent display bug** — CSS specificity conflict where `dialog { display: flex }` (0,2,1) overrode UA `dialog:not([open]) { display: none }` (0,1,1). Scoped all dialog rules to `[open]` attribute.
- **Settings pane bottom fade overlap** — `mask-image` gradient shifted from 90% to 94%, added `padding-bottom` so last items clear the fade zone.
- **Canvas invisible with `content-visibility: auto`** — Overlay container's `content-visibility: auto` caused browser to skip canvas rendering. Removed from permanently-visible overlay.
- **Reduced-motion messages permanently invisible** — When `prefers-reduced-motion: reduce` was active, scroll/reverse mode messages stayed at off-screen `startX` position. Now placed at fixed center position when reduced motion is active.
- **i18n completeness** — Added missing `Chat messages`, `Ignore Reduced Motion`, and tooltip keys to all 5 non-English locales. Fixed `Chat overlay` case mismatch (lowercase 'o' → uppercase 'O'). Added Arabic `CSS font-family` tooltip.

### Refactored

- **Script consolidation** — Removed 5 orphan/duplicate scripts across all 3 projects. Converted `check-i18n-parity.mjs` to `.ts`, wired into quality gate.

## [0.41.0] - 2026-06-28

### Added

- **URLPattern for YouTube URL matching** — Introduced `URLPattern` with fallback regex for robust YouTube URL detection; supports `youtube.com` without `www` subdomain.
- **scheduler.yield() in SDF atlas generation** — Replaced `setTimeout(fn, 0)` with `scheduler.yield()` for cooperative scheduling during atlas build.
- **Arabic translation and BCP-47 normalization** — Added Arabic (`ar`) locale, normalized Chinese to `zh-CN`.
- **Translation completeness verification script** — Automated i18n key parity validation across all locales.
- **WCAG 2.2 AA accessibility improvements** — Comprehensive settings UI audit (3 phases): native `<dialog>`, form labels, ARIA, `prefers-reduced-motion`, 44px touch targets, semantic headings, fieldset/legend, focus management.
- **Comment overlap fix on tab return** — Replay buffer accumulated during hidden tab period is now drained through the backlog controller for gradual Poisson-distributed emission instead of bursting.

### Fixed

- **Regex escaping bugs** — Fixed `EMOJI_ALIAS_PATTERN` double-backslash and URLPattern `*.example.com` not matching bare domain.
- **body.inert removed from settings dialog** — Use native `<dialog>` inertness to avoid freezing rAF and IntersectionObserver.
- **ImageFetchManager interval leak** — Added `isDestroyed` guard to prevent interval recreation on config update.
- **RendererWebGL2 constructor throw after DOM insertion** — Guard against post-insertion race conditions.
- **BacklogController author grid CSS override** — Use inline styles/`!important` to prevent page CSS from breaking grid layout.
- **i18n edge cases** — `mapBcp47` `zh` → `zh-CN`, binary insertion in translate queue, `t()` for localized `aria-label`.
- **Settings UI layout** — Increased modal width, restored horizontal range layout, fixed checkbox sizing.

### Refactored

- **Replay buffer drain API** — Consolidated `getPendingDrainCount`/`drainPendingMessages`/`resetPendingDrainCount` into a single `drainPendingMessages()` method.
- **Priority queue overflow logic** — Extracted to shared `enqueueWithOverflow` utility.

## [0.40.0] - 2026-06-26

### Added

- **Accessibility & web standards overhaul** — Comprehensive WCAG 2.1/2.2 AA compliance: native `<dialog>`, form labels, ARIA attributes, toast `aria-live`, canvas `aria-hidden`, tab arrow keys, `prefers-reduced-motion`, 44px touch targets, semantic headings, fieldset/legend for grids, inert modal overlay.
- **Stryker mutation testing infrastructure** — Mutation testing with `@stryker-mutator/vitest-runner` for `test/` workspace.
- **i18n barrel export** — `TRANSLATION_MAPS` exported for test and introspection.

### Fixed

- **DOM watcher duplicate observe on visibilitychange re-entry** — Added `observer.disconnect()` before re-observe to prevent MutationRecord duplication.
- **Settings UI `inert` not restored on error** — Changed `catch` to `finally` to guarantee `document.body.inert = false` even if `focusInitialElement()` throws.
- **BacklogController indicator fade rAF glitch** — Cancel pending fade-in rAF in `hideIndicator()` to prevent opacity override.
- **Per-frame measureTextWidth callback allocation** — Replaced per-frame arrow function with pre-bound `_boundMeasureTextWidth` method.
- **pendingTranslations slice allocation per drain** — Replaced `slice()` + `for...of` with index-based `for` loop.
- **cleanupExpiredMessages spread overhead** — Replaced `push(...newMessages)` with `Array.prototype.push.apply()`.
- **Settings async save not awaited in destroy()** — Made `destroy()` async, `await flushSave()` before teardown.
- **ImageFetchManager interval recreation on config update** — Only create cleanup interval if one doesn't exist.
- **fetchInterceptor unnecessary clone for non-chat URLs** — Added fast-path URL guard before regex test.
- **Overlay updateDimensionsFromRect unnecessary guard** — Removed redundant null check.
- **estimateDimensions getFontString duplication** — Compute once at function start, reuse.
- **Hostname guards** — Added hostname checks to prevent execution on non-YouTube pages.
- **ImageFetchManager interval timer leak on renderer reset** — Track and clear interval on reset.
- **youtubei-json Array.isArray check** — Added `Array.isArray` check to `isRecord` guard.
- **updateSettings source-change detection** — Fixed always-false condition.
- **Promise leak / code duplication / type safety** — Resolved 3 high-severity issues from audit.
- **Dependency updates** — nanoid 3.3.15, smol-toml 1.7.0, oxc-parser, knip.

### Refactored

- **Code structure** — Deduplicated `desaturateColor`/`siftDown`, cleaned unused imports, unified WebGL2 worker lane allocation, removed text measurement duplication.
- **Dead code removal** — Removed unused `bootstrap.ts`, cleaned unused exports.
- **Firefox manifest** — Cleaned and synchronized with Chrome manifest.

## [0.39.1] - 2026-07-28

### Fixed

- **MV3 best-practice improvements** — URL whitelist for content script injection, correct build target for extension bundles, and API consistency across platform adapters.
- **Resource management for long-running sessions** — Fix cleanup of pending callbacks and worker references to prevent memory leaks during extended YouTube live sessions.
- **Biome config migration** — Migrate biome.json to preset format, remove deprecated `recommended` field.

### Changed

- **Dependency updates** — @types/node 26.0.0, vitest 4.1.9, knip 6.17.1, oxc-parser 0.135.0, oxc-resolver 11.21.3, Node.js 26.3.1.

## [0.39.0] - 2026-06-18

### Fixed

- **Worker Phase 3 backlog lane competition** — Added `speedTier !== SPEED_TIER.BACKLOG` guard to worker `allocateSingleLane` Phase 3, matching main thread `laneAllocator` behavior. Prevents backlog messages from competing with real-time messages on busy lanes.
- **Worker anti-block utilization always reporting 100%** — Changed from `laneHeap.length / numLanes` (always ~1.0) to counting lanes where `availableAt > now`, matching main thread `getUtilization()` semantics. Anti-block gate now activates correctly.
- **WebGL2 worker restart `setTimeout` not tracked** — Added `restartTimerId` field to track the restart timer handle. `destroy()` now clears the timer to prevent post-destruction restart attempts.
- **`languageDetector.initialize()` silent failure** — Added `.catch()` error logging to prevent unhandled promise rejection when auto-source detection fails.
- **`translationService.configure()` silent failure** — Added `.catch()` error logging in constructor and `updateSettings()`. Wrapped `performSourceDetection()` in try/catch.
- **`onDestroy()` missing cleanup** — Clear `pendingTranslations` array and null out `onBacklogPauseChange`/`onStatusBarClick` callbacks to prevent post-destruction callback invocation.
- **WebGL2 worker-manager `destroy()` not releasing callbacks** — Delete all callback references in `destroy()` to prevent late worker messages from invoking stale callbacks.
- **DOM chat watcher rAF not cancelled on unsubscribe** — Track `mutationRafId` and cancel in unsubscribe function to prevent post-unsubscribe callback execution.

### Developer

- **Codebase audit (2026-06-18)** — Bug/stability-focused 3-lens parallel audit (Render Pipeline / Chat Sources & Session / Platform & Infrastructure) found 7 MEDIUM + 12 LOW issues. 8 issues fixed in this release. All quality gates pass (`pnpm quality` + `pnpm test` — 26 files, 640 tests).

## [0.38.0] - 2026-06-12

### Added

- **WebGL2 worker lane allocator** — Ported the 3-phase speed-isolated lane allocator to the WebGL2 worker path, enabling proper speed-isolated lane assignment for GPU-rendered messages.

### Fixed

- **`GmStorageAdapter.setItem` missing try/catch** — Added error handling to match `LocalStorageAdapter` and `ChromeStorageAdapter` patterns.
- **WebGL2 worker `slotCount` hardcoded to 1** — Now computed from message height (`Math.max(1, Math.ceil(msg.height / laneHeight))`), matching Canvas2D worker behavior. Prevents potential overlap for multi-slot cards (SuperChat/Membership).
- **`RenderWorkerManagerWebGL2.restart` doesn't reset `restartAttempts`** — Manual restart now resets the retry counter, preventing permanent failure after 3 auto-retry attempts.
- **`PriorityBucketQueue.dropLowest` wrong FIFO semantics** — Changed from `pop()` (removes newest) to `splice(entry.offset, 1)` (removes oldest unconsumed), matching documented intent.
- **WebGL2 main-thread `renderFrame` missing try/catch** — Added error boundary to prevent single message render failure from breaking the entire frame.
- **WebGL2 main-thread expired message accumulation** — Added `cleanupExpiredMessages()` to prevent unbounded `this.messages` array growth on long streams.
- **`countCodePoints` missing export** — Added `export` keyword to `countCodePoints` function (renamed from `countGraphemes` in 0.37.x).

### Changed

- **Extracted magic number constants** — `COMPACTION_THRESHOLD_RATIO` (0.5), `BACKLOG_QUEUE_COMPACT_THRESHOLD` (64), `FAILED_EMOJI_FETCH_CAP` (500), `FAILED_EMOJI_FETCH_EVICT_COUNT` (250), `RELOAD_FEEDBACK_DURATION_MS` (1500).
- **Replaced raw `console.debug` with `createLogger`** in WebGL2 worker for structured logging consistency.
- **Fixed relative import** in `design-tokens.ts` to use `@core/` path alias.
- **Renamed `countGraphemes` to `countCodePoints`** — More accurate name (counts Unicode code points, not grapheme clusters).

### Developer

- **Codebase audit (2026-06-12)** — Comprehensive 4-lens parallel audit (Structural/Bugs/Style/Renderer Parity) found and fixed 75 issues. All quality gates pass (`pnpm quality` + `pnpm test` — 26 files, 631 tests).

## [0.37.0] - 2026-06-03

### Added

- **Browser extension distribution** — The overlay is now available as a Chrome MV3 and Firefox MV3 browser extension, in addition to the existing userscript.
- **Platform abstraction layer** (`src/platform/`) — Adapter interfaces for storage, cross-tab sync, menu commands, and worker URL resolution isolate all platform-specific code behind clean interfaces. Core modules remain unchanged.
  - `StorageAdapter` — chrome.storage.local, GM_setValue/GM_getValue, or localStorage fallback
  - `WorkerFactory` — `chrome.runtime.getURL()` for extensions, `import.meta.url` for userscripts
  - `MenuAdapter` — `chrome.contextMenus` for extensions, `GM_registerMenuCommand` for userscripts
  - `CrossTabSyncAdapter` — `chrome.storage.onChanged`, `GM_addValueChangeListener`, or `window 'storage'` event
- **Extension background service worker** — Registers context menu commands and forwards clicks to the content script.
- **Content script in MAIN world** — Extension content script runs in the page's JavaScript context, enabling `window.fetch` interception identical to the userscript.
- **IIFE-bundled content script** — Content script is built as a self-executing function (IIFE) to avoid ES module syntax in classic `<script>` injection.
- **Firefox extension support** — Separate manifest with `browser_specific_settings`, `menus` permission, and Firefox-specific build config.
- **CI/CD for extensions** — `ci.yaml` builds and uploads all three targets (userscript + Chrome + Firefox). `release.yaml` creates signed extension ZIPs and attaches them to GitHub Releases.
- **Platform detection** — `detectPlatform()` identifies the runtime environment (userscript, chrome-extension, firefox-extension, or plain browser) and selects appropriate adapters.

### Changed

- **`Settings.initialize()` is now async** — Storage adapter reads are async to support `chrome.storage.local`. All callers already use `await`.
- **Updated default settings** — `maxConcurrentMessages` (120→300), `logLevel` (warn→debug), `backlogRecentMinutes` (5→1), `translationSource` (en→ja), `speedBoostMax` (0.35→0.05), `outline.widthPx` (1.5→2), `outline.opacity` (0.8→0.7) to match user-preferred configuration.
- **Refactored `settings-storage.ts`** — Now delegates to platform adapter factory. GM adapter, LocalStorage adapter, and Chrome adapter live in `src/platform/storage-adapters.ts`.

### Developer

- Build commands: `pnpm build:extension` (Chrome), `pnpm build:extension:firefox` (Firefox)
- Output directories: `dist-extension/`, `dist-extension-firefox/`
- Documentation: `extension/README.md`, updated `AGENTS.md` and `README.md`

## [0.36.0] - 2026-06-03

### Added

- **WebGL2 SDF rendering pipeline** — New `RendererWebGL2` + `RendererWebGL2Worker` with GPU-accelerated signed-distance-field text rendering, instanced quad batching, opacity-bucketed draw calls, and texture-based emoji/author photo support. Worker-first strategy with automatic fallback to Canvas2D.
- **Translation priority queue** — SuperChat (priority 200) and Membership (priority 100) messages are now translated before normal text messages (priority 0) during chat bursts, preventing paid message translation delays.
- **Adaptive stagger in worker** — Worker renderer now reduces stagger delay when the pending queue exceeds 10/30 messages, matching main-thread queue-depth adaptation.

### Fixed

- **Worker translation Y position** — Translation text was rendered inside the message card (at `msg.height * 0.75`) instead of below it (`msg.height`). Now matches main-thread layout.
- **`disposeSession()` memory leak** — `sessionDedup` was not cleared on session dispose, causing stale message IDs to survive into new sessions and silently drop legitimate messages.
- **Worker text measurement divergence** — Worker used `ctx.measureText().width` (advance width) instead of `actualBoundingBoxLeft + actualBoundingBoxRight` (bounding-box), and hardcoded `fontSize * 1.1` line-height instead of measured font metrics. Now aligned with main thread.
- **Worker translation kind filter** — Worker skipped translation rendering for SuperChat/Membership messages in dual mode. Now renders for all message kinds, matching main-thread behavior.
- **Opacity config non-null assertion** — Replaced `opacityConfig!` with null guard for lint compliance.

### Changed

- **Opacity pipeline SSOT** — Worker renderer now imports and uses `computeMessageOpacity()` from `renderer-shared.ts`, eliminating 29 inline opacity lines with a different operation ordering.
- **Font token consolidation** — Settings UI CSS and backlog indicator now reference `DEFAULT_FONT_FAMILY` design token instead of hardcoded font stacks.

### Refactored

- **`buildWrappedLines` SSOT** — Extracted shared line-breaking function into `canvas-rendering-shared.ts` with parameterized measurement callback, removing 178 lines of duplication between main-thread and worker.
- **`drawAuthorSection` SSOT** — Extracted shared author section renderer with generic photo validation callbacks, removing 165 lines of duplication.
- **`renderRegularMessage` SSOT** — Extracted shared regular message renderer with config object pattern, removing 175 lines of duplication.
- **Dedup layer unification** — `ChatSource.seenMessageIds` now uses `MessageIdRegistry` (FIFO O(1) eviction) instead of raw `Set` with O(n) bulk-delete overflow handling.
- **Type deduplication** — Consolidated `ChatBootstrapResolution` into `ChatBootstrapResult` from youtubei-chat module.
- **WebGL2 worker shared module** — Worker WebGL2 renderer now imports from `renderer-webgl2-shared.ts`, eliminating ~300 lines of duplicated shaders, context setup, and rendering utilities.

### Removed

- **Dead `rendererLayout` fields** — Removed `exitPaddingMin`, `durationMin`, `durationMax`, `topBottomDurationMs` (superseded by settings system).
- **`computeSuperChatOpacities`** — Dead export with zero consumers, removed from `color-utils.ts` and `design-tokens.ts`.

### Fixed

- **OffscreenCanvas fallback** — `cacheTextBitmap()` now guards `new OffscreenCanvas()` with a `typeof` check and falls back to `document.createElement('canvas')` for environments without `OffscreenCanvas` support (e.g. Firefox ESR, old Chromium).

### Changed

- **Worker text measurement cache** — The Worker renderer's `buildWrappedLines()` now uses the existing `measureTextCached()` LRU cache (500 entries) instead of raw `ctx.measureText()`, matching the main thread's cached `measureTextWidth()` behavior. Reduces redundant measurements for repeated words in SuperChat messages.
- **Bitmap cache threshold** — `renderSegment()` now skips the text bitmap cache for strings shorter than 3 characters. Tiny strings ("ㅋ", "w", "草") render directly via `fillText()`/`strokeText()`, avoiding `OffscreenCanvas` creation overhead where raw rendering cost is lower. Reduces cache thrashing in emoji-heavy channels.

## [0.35.2] - 2026-05-30

### Changed

- **Frame timing instrumentation** — Added per-frame `performance.now()`-based metrics (render, drain, collision check, text measure) to the debug overlay and `SessionMetrics`. Zero overhead when `showDebug` is disabled via callback pattern.
- **Settings save debounced** — Settings are now persisted via `requestIdleCallback` instead of writing to storage on every `set()` call, eliminating redundant `JSON.stringify` during slider drags.

### Refactored

- **Opacity-batched rendering** — `renderFrame()` now pre-scans active messages, computes opacity once per frame, and groups messages by 0.05 opacity buckets. Each group renders with a single `ctx.globalAlpha` set, reducing per-message `save()`/`restore()` pairs by ~70%.
- **CanvasMessage object pool** — Expired message objects are now released to a free list and recycled via `acquireMessage()` + `Object.assign()`, eliminating per-activation allocations and reducing GC pressure by 40–60%.
- **Array compaction threshold** — `cleanupExpiredMessages()` replaces the array via `.slice()` when more than 50% of slots are expired, avoiding garbage-collectible tail references.
- **Byte-limited image caches** — `emojiCache` and `textBitmapCache` now use a new `ByteLimitedCache<'T>` wrapper with estimated byte tracking (3MB emoji, 2MB text bitmap) instead of entry-count FIFO eviction. Author photo and sticker caches remain plain `Map`.
- **Worker text bitmap cache** — The Worker renderer now pre-renders text+outline to an `OffscreenCanvas` bitmap and draws via `drawImage()` instead of per-frame `fillText()`/`strokeText()`, matching main-thread text rendering quality.

## [0.35.1] - 2026-05-28

### Fixed

- **Import button border asymmetry** — Left-only 2px yellow `border-left` caused visual misalignment with other outline buttons. Removed per-side overrides; import now uses uniform 1px border matching Reset/Export.
- **Import button hardcoded yellow** — Raw `#ffc107` and `rgba(255, 193, 7, ...)` values in 3 CSS rules extracted to `uiColors.warning` SSOT token in `settings-ui-tokens.ts`.
- **Import button hover background inconsistency** — Import was the only outline button that changed background on hover. Removed hover background; now uses border+text color change only, consistent with Reset and Export.

### Changed

- **Action button CSS test coverage expanded** — `test/consistency/action-button-css.test.ts` grew from 4 to 13 tests, adding border symmetry guards (no `border-left`/`border-right`/`border-left-color` per-side overrides), token verification (import hover uses `uiColors.warning`, normal state has no yellow tint), and hover consistency checks (no outline button sets background on hover).

## [0.35.0] - 2026-05-28

### Fixed

- **Fetch interceptor real-time messages incorrectly routed through backlog controller** — Live messages from fetch interceptor were treated as replay batches (>= 2 messages), causing unwanted Poisson delays, sampling, and 2× scroll speed. Now only batches > 50 messages trigger backlog injection. ([`d1a46e9`](https://github.com/PiesP/yt-live-chat-overlay/commit/d1a46e9))
- **Resume state machine stuck when tab hidden + video paused simultaneously** — `isPaused` flag was cleared after the `isVideoPaused` guard, leaving the render loop dead on tab return. Fixed by clearing `isPaused` before the guard and handling `resumeForVideo()` path. ([`d1a46e9`](https://github.com/PiesP/yt-live-chat-overlay/commit/d1a46e9))
- **Dispose ordering could skip listener cleanup** — `abortController.abort()` was called before `stopForegroundListeners()`; if abort handlers threw, cleanup never ran. Reordered to stop listeners first. ([`d1a46e9`](https://github.com/PiesP/yt-live-chat-overlay/commit/d1a46e9))
- **`resolveLimits('opacity')` collision returned root limits for outline opacity** — Root `opacity` (0.5–1) shadowed outline `opacity` (0–1), clamping outline opacity to 50% minimum. Added `resolveOutlineLimits()` to bypass root key collision. ([`78ab417`](https://github.com/PiesP/yt-live-chat-overlay/commit/78ab417))
- **Outline range slider not synced in `populateForm`** — Outline branch `continue` skipped the slider sync code that lived in the root scalar handler. Added local slider sync within the outline handler. ([`78ab417`](https://github.com/PiesP/yt-live-chat-overlay/commit/78ab417))
- **ReplayBuffer did not deduplicate by message ID** — `insert()` only maintained sort order; overlapping continuation chains could emit duplicates. Added `seenIds` Set. ([`8a2c4dd`](https://github.com/PiesP/yt-live-chat-overlay/commit/8a2c4dd))
- **`trimBackgroundQueue` sort could produce NaN** — `a.timestamp - b.timestamp` on undefined timestamp (replay messages with `videoOffsetMs`). Added `?? 0` null-coalescing guard. ([`8a2c4dd`](https://github.com/PiesP/yt-live-chat-overlay/commit/8a2c4dd))
- **`getRootDisplayMeta` falsy-check bug** — `if (meta?.displayScale)` treated `displayScale: 0` as undefined. Changed to `!== undefined`. ([`8a2c4dd`](https://github.com/PiesP/yt-live-chat-overlay/commit/8a2c4dd))
- **Range slider number inputs had no CSS styling** — CSS selector `.yt-chat-overlay-settings-field input[type="number"]` didn't match range companion inputs (sibling, not child). Added proper dark-theme styling to `.yt-chat-overlay-settings-range-number`. ([`62a8b7f`](https://github.com/PiesP/yt-live-chat-overlay/commit/62a8b7f))
- **Font Family text input had no CSS styling** — No CSS rule existed for `input[type="text"]`. Added matching dark-theme styles. ([`c6b7ecf`](https://github.com/PiesP/yt-live-chat-overlay/commit/c6b7ecf))
- **Export button had zero CSS rules** — Only base button styles applied. Added dark outlined style with primary blue hover, matching Reset button. ([`62a8b7f`](https://github.com/PiesP/yt-live-chat-overlay/commit/62a8b7f))
- **Import button left border accent too prominent** — Yellow `border-left` opacity reduced from 0.4 → 0.15 in base state. ([`c6b7ecf`](https://github.com/PiesP/yt-live-chat-overlay/commit/c6b7ecf))
- **Medium-severity bugs**: rAF restart during pause now guarded; epsilon-greedy lane skip keeps last zero-wait lane; active message array compaction nulls tail references; observability cooldown resets on recovery; `MessageIdRegistry` uses bulk eviction; `failedEmojiFetches` capped at 500; `BacklogController` guards against duplicate injection; lane allocator heap integrity asserts on mismatch. ([`ee755dc`](https://github.com/PiesP/yt-live-chat-overlay/commit/ee755dc), [`dec87bf`](https://github.com/PiesP/yt-live-chat-overlay/commit/dec87bf))
- **i18n**: Replaced stale `'Outline Opacity (0–1)'` key with `'Outline Opacity (%)'` in all 4 language maps. Removed dead `'Opacity'` key. Added missing translation keys for new tooltips and validation messages. Wrapped hardcoded validation error strings in `t()` calls. ([`78ab417`](https://github.com/PiesP/yt-live-chat-overlay/commit/78ab417))

### Added

- **Schema-Driven Consistency Guard** — 5 new validation tests (`test/consistency/`) that cross-reference the declarative schema (PANES, settings-schema) with runtime systems (CSS, i18n, form rendering). Catches CSS rule gaps, missing translations, unregistered settings limits, and dead translation keys at CI time. ([`7c9a04a`](https://github.com/PiesP/yt-live-chat-overlay/commit/7c9a04a))
- **Translation tab section grouping** — Split into "Interface" (language selector) and "Chat Translation" (translation settings) sections, matching the grouped layout of other tabs. ([`98163cf`](https://github.com/PiesP/yt-live-chat-overlay/commit/98163cf))
- **Outline opacity range slider** — Changed from plain number input to slider+number combo, consistent with all other percentage-based settings. Added tooltips to `fontSize`, `outline.widthPx`, and `outline.opacity`. ([`9c35ff9`](https://github.com/PiesP/yt-live-chat-overlay/commit/9c35ff9))
- **Save generation counter** — `Settings.save()` now uses a `saveGeneration` counter instead of a boolean `isSaving` flag, correctly handling both synchronous (Tampermonkey) and asynchronous (Violentmonkey) GM storage listener timing. ([`dec87bf`](https://github.com/PiesP/yt-live-chat-overlay/commit/dec87bf))
- **Orphaned canvas guard** — `renderFrame()` now checks `canvas.isConnected` before drawing, preventing wasted CPU on orphaned canvases. ([`261d835`](https://github.com/PiesP/yt-live-chat-overlay/commit/261d835))

### Changed

- **Outline opacity display unit aligned with all other opacity settings** — Display changed from raw 0–1 to percentage (0–100%) with `displayScale: 100`, matching text/superchat/backlog/far-layer opacity. ([`ae32cd1`](https://github.com/PiesP/yt-live-chat-overlay/commit/ae32cd1))
- **`getRuntimeHealthSnapshot` null-safe check** — Replaced fragile `!!()` pattern with explicit `(container?.isConnected ?? false) && dimensions != null`. ([`261d835`](https://github.com/PiesP/yt-live-chat-overlay/commit/261d835))
- **`getRootDisplayMeta`**: Changed falsy-check from `if (meta?.displayScale)` to `if (meta?.displayScale !== undefined)`. ([`8a2c4dd`](https://github.com/PiesP/yt-live-chat-overlay/commit/8a2c4dd))
- **`vite.config.ts` reads metadata from `package.json`** — Author, license, description, homepage, and repository URL are now read from `package.json` via `getPackageMeta()` instead of being hardcoded. ([`61748bb`](https://github.com/PiesP/yt-live-chat-overlay/commit/61748bb))

### Refactored

- **SSOT: `RgbColor` interface deduplicated** — Was defined in both `color-utils.ts` and `design-tokens.ts` with different modifiers. Moved to `types/index.ts` as canonical export. ([`df4bf7b`](https://github.com/PiesP/yt-live-chat-overlay/commit/df4bf7b))
- **SSOT: `FontWeight` type extracted** — `'normal' | 'bold'` inline union duplicated across 6 locations. Extracted as named type in `types/index.ts`. ([`df4bf7b`](https://github.com/PiesP/yt-live-chat-overlay/commit/df4bf7b))
- **SSOT: Magic numbers extracted as named constants** — Priority threshold (80), tier split ratio (0.3), desaturation factor (0.3), stagger batch/scale (3, 25), outline stroke scale (0.85). ([`df4bf7b`](https://github.com/PiesP/yt-live-chat-overlay/commit/df4bf7b))
- **SSOT: `STRING_VALIDATORS` uses const arrays** — 9 inline union literals replaced with `includes()` checks against `satisfies`-typed const arrays derived from canonical types. `isLogLevel()` also uses array-based check. ([`61748bb`](https://github.com/PiesP/yt-live-chat-overlay/commit/61748bb))
- **Architecture: `design-tokens.ts` split** — Extracted `color-utils.ts` (7 color functions) and `math-utils.ts` (`sampleExponential`) from the 304-line monolithic file. Added `BurstLevelObserver` interface for DI decoupling. ([`da176ab`](https://github.com/PiesP/yt-live-chat-overlay/commit/da176ab))
- **Headway-gap computation deduplicated** — Extracted `LaneAllocator.computeBaseHeadwayPx()` static method and reused in `CanvasRenderer.computeHeadwayPx()`. ([`8a2c4dd`](https://github.com/PiesP/yt-live-chat-overlay/commit/8a2c4dd))
- **Outline patching extracted to shared helper** — Duplicate `partial.outline` spread pattern in `settings-ui-form.ts` replaced with single `patchOutline()` function. ([`8a2c4dd`](https://github.com/PiesP/yt-live-chat-overlay/commit/8a2c4dd))
- **Action button list extracted as shared constant** — `createActions()` now iterates over exported `ACTIONS` const array instead of an inline list. ([`7c9a04a`](https://github.com/PiesP/yt-live-chat-overlay/commit/7c9a04a))

### Performance

- **O(1) queue dequeue** — `pendingQueue.shift()` (O(n) per element) replaced with index-based dequeue using `pendingQueueOffset` counter. Array compacted when offset exceeds 64 entries. ([`810b4c8`](https://github.com/PiesP/yt-live-chat-overlay/commit/810b4c8))
- **Pre-computed desaturated user color** — `desaturateColor()` call removed from per-frame Far-tier render hot path. Color pre-computed once on message activation. ([`810b4c8`](https://github.com/PiesP/yt-live-chat-overlay/commit/810b4c8))
- **Text wrapping now uses measurement cache** — `wrapTextLines()` was bypassing the 500-entry LRU cache and calling `ctx.measureText()` directly. Routed through `measureTextWidth()` cache. ([`d7c4775`](https://github.com/PiesP/yt-live-chat-overlay/commit/d7c4775))
- **Two-level Map text measurement cache** — Changed from `Map<string, number>` (template literal key allocation on every cache hit) to `Map<string, Map<string, number>>` (font → text → width), eliminating string allocation on cache hits. ([`d7c4775`](https://github.com/PiesP/yt-live-chat-overlay/commit/d7c4775))
- **Deduplicated `estimateDimensions` call** — Both `checkPlacement` and `enqueueMessageWithPlacement` computed dimensions; now computed once and passed through. ([`d7c4775`](https://github.com/PiesP/yt-live-chat-overlay/commit/d7c4775))

## [0.34.1] - 2026-05-26

### Fixed

- **`LaneAllocator` stale font options after settings change** — `LaneAllocatorOptions.fontSize`/`fontWeight`/`fontFamily`/`laneSpacing` were marked `readonly`, preventing settings changes from propagating. Added `updateFontMetrics()` method and wired it from `RendererBase.updateSettings()` when font or lane spacing changes are detected. ([`b922b1a`](https://github.com/PiesP/yt-live-chat-overlay/commit/b922b1a))
- **`Boolean(chat)` narrowing failure** — `Boolean(chat)` does not narrow TypeScript's nullable type. Replaced with `chat != null` to enable property access after the null check. ([`b81bc96`](https://github.com/PiesP/yt-live-chat-overlay/commit/b81bc96))

### Refactored

- **`resolveLimits()` outline key resolution** — Replaced hard-coded string comparisons (`key === 'widthPx'`) with explicit `OUTLINE_LIMIT_KEYS` map. Deduplicated return type by reusing `NumericSettingLimit`. ([`71d1fd2`](https://github.com/PiesP/yt-live-chat-overlay/commit/71d1fd2))

### Changed

- **Standardized catch blocks** — 22 `catch (error)` → `catch (error: unknown)` across 11 files for strict type safety. ([`dc3fec1`](https://github.com/PiesP/yt-live-chat-overlay/commit/dc3fec1))
- **Standardized `.cssText` and magic numbers** — `observability.ts` switched from `Array.join()` to string concatenation. `text-measure.ts` extracted `CSP_WIDTH_FACTOR` (0.6) and `HEIGHT_FALLBACK_FACTOR` (1.1) as named constants. ([`b097b07`](https://github.com/PiesP/yt-live-chat-overlay/commit/b097b07))
- **Standardized Boolean coercion to `Boolean()`** — Replaced 2 `!!` usages with `Boolean()` in `runtime-session.ts` and `chat-message-parser.ts`. ([`3a9f722`](https://github.com/PiesP/yt-live-chat-overlay/commit/3a9f722))
- **Standardized function style in `dom.ts` and `youtubei-json.ts`** — Converted remaining `export function` declarations (4 in dom, 1 in youtubei-json) to arrow functions for file-level consistency. ([`4bc257c`](https://github.com/PiesP/yt-live-chat-overlay/commit/4bc257c))
- **Added JSDoc to undocumented exports** — `setOverlayLogLevel`, `stripControlCharacters`, `normalizeInlineText`, `hasEmojiContent`. ([`0982047`](https://github.com/PiesP/yt-live-chat-overlay/commit/0982047))

## [0.34.0] - 2026-05-25

### Added

- **Multi-language i18n support** — Settings UI now supports 5 languages (English, 한국어, 日本語, Español, 中文). `src/core/i18n.ts` implements a lightweight gettext model with 82 translated strings per language. Language defaults to `'auto'` (browser detection), users can select manually. Language switching during preview rebuilds the settings modal in-place; on persist, the dialog reopens with translated strings. ([`ac2a2ad`](https://github.com/PiesP/yt-live-chat-overlay/commit/ac2a2ad), [`f5c1a25`](https://github.com/PiesP/yt-live-chat-overlay/commit/f5c1a25))

### Fixed

- **Settings dialog forced-close and infinite recursion from i18n** — `collectSettings()` always included `language` in the partial, causing `applySettingsSideEffects` to trigger `close()` on every setting change. Fixed by comparing `partial.language` with the previous value before acting, and removing the re-entrant `close()` call from `applySettings` (since `applySettings` is always called from `close`). ([`ac2a2ad`](https://github.com/PiesP/yt-live-chat-overlay/commit/ac2a2ad))

## [0.33.1] - 2026-05-25

### Fixed

- **`cachedUtilization` deadlock causing permanent anti-block stall** — `laneAllocator.resetBatch()` was called inside `drainQueue()` after the anti-block gate. When anti-block activated (utilization ≥95%), `drainQueue` returned immediately without calling `resetBatch()`, so `cachedUtilization` was never updated. This caused a permanent deadlock: messages scrolled off screen, `activeMessages` emptied, but lanes stuck at 100% — screen empty, queue piling up with `queue_priority` drops. `resetBatch()` now runs in `renderFrame()` before `drainQueue` regardless of anti-block state. ([`9c00617`](https://github.com/PiesP/yt-live-chat-overlay/commit/9c00617))
- **`no_lane` dropped highest-priority messages first during bursts** — `drainQueue` hard-dropped messages on `'no_lane'` from the front of the priority-sorted queue. Since the queue is sorted descending by priority, SuperChat (priority=100) was discarded before text (priority=0) when all lanes were saturated. Now pushes to `retryQueue` for next-frame retry. ([`1c628d5`](https://github.com/PiesP/yt-live-chat-overlay/commit/1c628d5))
- **`canvas.getContext('2d')` silent null → invisible renderer** — Context creation can fail (detached DOM, GPU exhaustion) but was never checked. rAF loop kept running with zero output. Now logs a warning and checks canvas connectivity. ([`1c628d5`](https://github.com/PiesP/yt-live-chat-overlay/commit/1c628d5))
- **Anti-block binary gate → on/off oscillation** — The 95% utilization threshold was a hard binary gate. At 94.9%: full drain. At 95.0%: zero drain. Now uses a gradual probabilistic throttle: acceptance probability = `(1-utilization) / 0.05`, producing smooth transitions. ([`e36d983`](https://github.com/PiesP/yt-live-chat-overlay/commit/e36d983))
- **Backlog messages permanently dropped during all-lanes-busy** — `LaneAllocator` Phase 3 returned null for backlog messages, causing hard drops when all lanes had real-time content. Backlog now passes through Phase 3 (fastest-free lane) same as real-time, with speed-isolated headway scaling preventing visual overtaking. ([`e36d983`](https://github.com/PiesP/yt-live-chat-overlay/commit/e36d983))
- **Burst detection delayed by poll interval** — `LiveChatSource.calculateAdaptiveDelay` needed ≥2 poll samples (2+ poll intervals) to detect bursts. `BurstDetector` EMA rate (per-message, instant) was never connected to the poll loop. Now wired via `burstRateProvider` for sub-poll-interval reactivity. ([`e36d983`](https://github.com/PiesP/yt-live-chat-overlay/commit/e36d983))
- **Live poll batches bypassed BacklogController during bursts** — Live poll responses (20-50 msgs) hit the renderer directly, flooding the pending queue. Now routes through `BacklogInjectionController` (Poisson spacing) when lane utilization ≥80% and batch size ≥5. ([`e36d983`](https://github.com/PiesP/yt-live-chat-overlay/commit/e36d983))
- **Player container lookup: 5s polling → instant MutationObserver** — Replaced polling `#movie_player` (up to 5s wait) with MutationObserver that detects the element immediately when it appears in DOM. Fast-path immediate lookup first; polling fallback if MutationObserver unavailable. ([`e36d983`](https://github.com/PiesP/yt-live-chat-overlay/commit/e36d983))
- **Retry queue priority inversion after collision** — Retried messages were `push()`ed to the end of `pendingQueue`, behind freshly-arrived lower-priority messages. Now re-inserted via priority-sorted `splice`. ([`2c0da32`](https://github.com/PiesP/yt-live-chat-overlay/commit/2c0da32))
- **Anti-block blocked SuperChat/Membership alongside text** — High-priority messages (SuperChat ≥100, Membership ≥80) now bypass the anti-block gate. Paid interactions are never blocked by lane saturation. ([`2c0da32`](https://github.com/PiesP/yt-live-chat-overlay/commit/2c0da32))
- **Bootstrap retries gave zero progress indication** — `BootstrapResolver` now logs at debug level on each retry attempt (`"Bootstrap attempt 3/5 — retryable: ..."`). ([`2c0da32`](https://github.com/PiesP/yt-live-chat-overlay/commit/2c0da32))
- **Post-burst cooldown fixed at 5s regardless of burst duration** — A 1-second surge and a 30-second surge both triggered 5s of elevated rate limiting. Cooldown is now proportional: `base 2s + 0.3 × burst_duration`, capped at 8s. A 1-second burst cools down in ~2.3s. ([`2c0da32`](https://github.com/PiesP/yt-live-chat-overlay/commit/2c0da32))

## [0.33.0] - 2026-05-24

### Added

- **Standby mode for pre-live pages** — The overlay now detects pre-live ("waiting") pages and renders a standby status message. `RuntimeManager` keeps the standby session alive and periodically rechecks for live status. ([`3738e4b`](https://github.com/PiesP/yt-live-chat-overlay/commit/3738e4b), [`4bcca4e`](https://github.com/PiesP/yt-live-chat-overlay/commit/4bcca4e), [`756f9a8`](https://github.com/PiesP/yt-live-chat-overlay/commit/756f9a8), [`51bab7b`](https://github.com/PiesP/yt-live-chat-overlay/commit/51bab7b))
- **`backlogOpacityMultiplier` setting** — Configurable opacity for backlog messages (default 0.85, was hardcoded 0.35). Added to settings UI with live preview. ([`f87f421`](https://github.com/PiesP/yt-live-chat-overlay/commit/f87f421))
- **rAF exact-timing replay flush** — Replaced the 250ms `setInterval` timer loop with `requestAnimationFrame`-based flush (±8ms precision). Background fetch interval runs independently at 100ms. ([`35dad04`](https://github.com/PiesP/yt-live-chat-overlay/commit/35dad04))
- **ReplayBuffer** — Time-indexed sorted buffer with binary-search insertion and deduplication. Guarantees replay messages are emitted in correct temporal order. ([`b8fbc3b`](https://github.com/PiesP/yt-live-chat-overlay/commit/b8fbc3b))
- **`videoOffsetMs` on ChatMessage** — YouTube's native `videoOffsetTimeMsec` now propagated through the full parse→buffer→flush pipeline, enabling exact replay timing. ([`190b99d`](https://github.com/PiesP/yt-live-chat-overlay/commit/190b99d))
- **Full-chat background prefetch** — `ReplayChatSource` walks the entire continuation chain at 1 req/s in the background, building a complete buffer for instant replay navigation. ([`12bd2d7`](https://github.com/PiesP/yt-live-chat-overlay/commit/12bd2d7))

### Fixed

- **Replay BacklogInjectionController bypass** — Replay messages with video timestamps now skip the Poisson-distributed backlog injection delay, routing directly to the renderer. Fetch interceptor also disabled for replay to prevent double-capture. ([`b6d97cf`](https://github.com/PiesP/yt-live-chat-overlay/commit/b6d97cf))
- **5 tab-switch pause/resume bugs** — Fixed `isPaused` reposition on resume, `resumeForVideo` guard, `trimBackgroundQueue` execution order, `ReplayChatSource` fetch starvation, and `BurstDetector` EMA re-initialization. ([`f003857`](https://github.com/PiesP/yt-live-chat-overlay/commit/f003857))
- **5 additional audit bugs** — rAF `chatPaused` guard, backlog batch drop on pause, fetch/prefetch pause, image retry after failure, and disposed-session guard in `handleSeeked`. ([`75104d8`](https://github.com/PiesP/yt-live-chat-overlay/commit/75104d8), [`512324c`](https://github.com/PiesP/yt-live-chat-overlay/commit/512324c))
- **SuperChat rendering SSOT fixes** — `alpha²` stacking bug (double-`globalAlpha`), showAuthor key mismatch between estimation and rendering, and card padding SSOT violations. ([`455728c`](https://github.com/PiesP/yt-live-chat-overlay/commit/455728c))
- **SuperChat text overflow** — First-word `maxWidth` check, line-height `Math.ceil` alignment between estimation and rendering, and `estimateSuperChatDimensions` showAuthor hardcoding. ([`f440093`](https://github.com/PiesP/yt-live-chat-overlay/commit/f440093))
- **Speed-isolation map shift on pause/resume** — `LaneAllocator.shiftAll()` now shifts both `realTimeLanesUntil` and `backlogLanesUntil` maps, preventing cross-speed overtaking after tab-switch resume. ([`a8ab645`](https://github.com/PiesP/yt-live-chat-overlay/commit/a8ab645))
- **Cross-speed overtaking prevention** — Speed-isolation tracking extended to full message duration (not just right-edge-pass). Faster backlog messages can no longer enter lanes where slower real-time messages are still visible. ([`110c554`](https://github.com/PiesP/yt-live-chat-overlay/commit/110c554))
- **Watchdog false restart on replay** — `ReplayChatSource` now correctly overrides `isObserverAlive()` to check rAF + background fetch, and `markActivity()` is called in the rAF flush loop. ([`304e02b`](https://github.com/PiesP/yt-live-chat-overlay/commit/304e02b), [`3c0ed12`](https://github.com/PiesP/yt-live-chat-overlay/commit/3c0ed12))
- **4 remaining bugs** — Dedup FIFO capacity, `shiftAll` cap, background-fetch guard on pause, and CSP safety for inline event handlers. ([`5507588`](https://github.com/PiesP/yt-live-chat-overlay/commit/5507588))
- **`videoOffsetMs` read location** — `ReplayBuffer.appendEvents` now reads `videoOffsetMs` from `ChatMessage` (not the removed `ChatEvent.offsetMs`), restoring replay message display. ([`a397957`](https://github.com/PiesP/yt-live-chat-overlay/commit/a397957))
- **Multi-slot collision detection & reverse duration** — Collision check now handles multi-slot messages correctly; reverse-mode scroll duration uses correct travel distance. ([`9029437`](https://github.com/PiesP/yt-live-chat-overlay/commit/9029437))
- **Replay batches through backlog controller** — Large replay batches (>50) now route through `BacklogInjectionController` to prevent `queue_priority` drops. ([`9a0ca61`](https://github.com/PiesP/yt-live-chat-overlay/commit/9a0ca61))
- **Emoji fetch timeout cleanup** — `emojiFetching` set now prunes stale entries via timeout to prevent silent accumulation. ([`3214e23`](https://github.com/PiesP/yt-live-chat-overlay/commit/3214e23))
- **Speed-aware headway in reverse mode** — Reverse-mode lane occupancy now uses speed-aware headway matching scroll-mode behavior. `watch subtree` on video pause controller. O(1) lane utilization metric. ([`e7b6528`](https://github.com/PiesP/yt-live-chat-overlay/commit/e7b6528))
- **Contiguous multi-slot allocation** — `allocateMultiSlot` Phase 2 now scans for contiguous busy blocks before falling back to single-lane placement. ([`ef2dc4d`](https://github.com/PiesP/yt-live-chat-overlay/commit/ef2dc4d))
- **Bitmap cache unbounded growth** — LRU eviction added to `textBitmapCache` to prevent memory leak during long sessions. ([`3f158a0`](https://github.com/PiesP/yt-live-chat-overlay/commit/3f158a0))

### Changed

- **`backlogOpacityMultiplier` default**: 0.75 → 0.85 for better readability of backlog messages. ([`87fd1ff`](https://github.com/PiesP/yt-live-chat-overlay/commit/87fd1ff))

### Refactored

- **Canvas text rendering extracted** — `renderSegment`, `renderContentSegments`, `renderWrappedText`, card renderers, and `strokeTextOutline` moved to `canvas-text-renderer.ts`. `renderer-canvas.ts` -340 lines with clear render/logic separation. ([`d394691`](https://github.com/PiesP/yt-live-chat-overlay/commit/d394691), etc.)
- **Emoji/image parsing extracted** — `chat-emoji-parser.ts` handles emoji alias resolution and image asset URL extraction from chat renderer data. ([`fd51c73`](https://github.com/PiesP/yt-live-chat-overlay/commit/fd51c73))
- **UI tokens extracted** — `settings-ui-tokens.ts` separated from `design-tokens.ts` for settings-specific CSS values. ([`52d7fe3`](https://github.com/PiesP/yt-live-chat-overlay/commit/52d7fe3))
- **CanvasMessage lifecycle inlined** — `canvas-message-lifecycle.ts` merged into `renderer-canvas.ts` (single consumer). ([`6333bad`](https://github.com/PiesP/yt-live-chat-overlay/commit/6333bad))
- **Defensive patterns** — Overlay, FetchInterceptor, and BacklogController hardened with null guards and error isolation. ([`e924b66`](https://github.com/PiesP/yt-live-chat-overlay/commit/e924b66))
- **Dead code / unused exports removed** — `ChatBootstrapResolution` de-exported, retry queue separated, settings-ui-types inlined, tooling config cleaned. ([`173f130`](https://github.com/PiesP/yt-live-chat-overlay/commit/173f130), [`3acb498`](https://github.com/PiesP/yt-live-chat-overlay/commit/3acb498), [`2d136b6`](https://github.com/PiesP/yt-live-chat-overlay/commit/2d136b6))
- **Magic numbers extracted** — Standby message tokens, card renderer padding/radius, and canvas constants consolidated into `design-tokens.ts`. ([`1691012`](https://github.com/PiesP/yt-live-chat-overlay/commit/1691012), [`d8eec15`](https://github.com/PiesP/yt-live-chat-overlay/commit/d8eec15))
- **Code style unification** — Hardcoded design tokens migrated, `!= null` consistency fixes, `computeDliosDuration` → `computeScrollDuration` rename, `clearSafeTimer` utility added. ([`96a18c1`](https://github.com/PiesP/yt-live-chat-overlay/commit/96a18c1), [`46df44a`](https://github.com/PiesP/yt-live-chat-overlay/commit/46df44a), [`d3fb294`](https://github.com/PiesP/yt-live-chat-overlay/commit/d3fb294))
- **JSDoc added** — All previously undocumented public/protected exports now have documentation. ([`547124c`](https://github.com/PiesP/yt-live-chat-overlay/commit/547124c), [`56d12f2`](https://github.com/PiesP/yt-live-chat-overlay/commit/56d12f2))

## [0.32.0] - 2026-05-23

### Fixed

- **Double bootstrap API call** — `createChatSource()` now returns bootstrap data alongside the ChatSource, and `seedBootstrapIfReady()` pre-seeds it before `start()`. Previously each session start fetched the ~200KB watch page HTML twice (once in the factory, once in `bootstrapResolver.resolve()`). ([`236f67a`](https://github.com/PiesP/yt-live-chat-overlay/commit/236f67a))
- **Replay messages inflating observability metrics** — `replayMessage()` bypasses `isMessageAllowed()` observability tracking. Previously `replayLatestMessages` called `addMessage()` which incremented `totalReceived`, skewing drop-rate calculations. ([`236f67a`](https://github.com/PiesP/yt-live-chat-overlay/commit/236f67a))
- **Fetch interceptor not handling Request objects** — URL resolution now handles `input instanceof Request` in addition to string and URL types. ([`236f67a`](https://github.com/PiesP/yt-live-chat-overlay/commit/236f67a))
- **Stale density data across sessions** — `recentMessageCounts` now cleared on `resetSessionState()`. Previously old message counts leaked into `calculateAdaptiveDelay()` in new sessions. ([`236f67a`](https://github.com/PiesP/yt-live-chat-overlay/commit/236f67a))
- **DPR change without canvas buffer resize** — `renderFrame()` now resizes `canvas.width`/`canvas.height` when `devicePixelRatio` changes (e.g. moving window between monitors). Previously only the transform was updated, leaving the buffer at the old physical resolution. ([`0a2e674`](https://github.com/PiesP/yt-live-chat-overlay/commit/0a2e674))
- **handleSeeked void promise chain** — Rewritten as async IIFEs with try/catch, ensuring `flushReplayBuffer` errors are properly caught alongside fetch errors. ([`0a2e674`](https://github.com/PiesP/yt-live-chat-overlay/commit/0a2e674))

### Refactored

- **Merged 4 small files into consumers** — `message-buffer.ts` + `poll-loop-manager.ts` → `chat-source-base.ts`, `youtubei-image.ts` → `chat-message-parser.ts`, `chat-source-factory.ts` → `runtime-session.ts`. Each had exactly 1 consumer. 4 files removed, navigation friction reduced. ([`e9bd899`](https://github.com/PiesP/yt-live-chat-overlay/commit/e9bd899))
- **`isLogLevel` moved to its sole consumer** — Runtime validation function extracted from `types/index.ts` to `settings-schema.ts`. Keeps the `@app-types` module purely for type exports. ([`e9bd899`](https://github.com/PiesP/yt-live-chat-overlay/commit/e9bd899))
- **`AUTHOR_TYPE_PRIORITY` moved to helpers** — Moved from `chat-message-parser.ts` to `chat-message-helpers.ts` where all other author-type utilities live. ([`e9bd899`](https://github.com/PiesP/yt-live-chat-overlay/commit/e9bd899))
- **`STYLE_ID` export simplified** — Changed from `const STYLE_ID = ...; export { STYLE_ID };` to `export const STYLE_ID = ...;` (matching `BUTTON_ID`/`BACKDROP_ID` pattern). ([`e9bd899`](https://github.com/PiesP/yt-live-chat-overlay/commit/e9bd899))
- **String concatenation modernized** — Replaced `+`-concatenated strings in `chat-source-live.ts` and `observability.ts` with template literals and `.join()` array literals. ([`0a2e674`](https://github.com/PiesP/yt-live-chat-overlay/commit/0a2e674))
- **`PREVIEW_DEBOUNCE_MS` made static** — Changed from `private readonly` to `private static readonly`, matching all other class-level constants in the project. ([`0a2e674`](https://github.com/PiesP/yt-live-chat-overlay/commit/0a2e674))

## [0.31.0] - 2026-07-20

### Added

- **Top-first lane allocation** — The lane scheduler now scans from the top of the screen down, picking the first zero-wait lane. Previously the composite scoring (weighted by density/count/temporal terms) dominated the DLIOS wait term (42:1 ratio), causing persistent downward drift and top-lane underutilization. ([`aab1263`](https://github.com/PiesP/yt-live-chat-overlay/commit/aab1263))
- **Collision feedback** — When `checkPlacement` detects a lane collision, `markCollision(laneIndex)` tells the allocator to skip that lane for the rest of the batch, allowing subsequent messages to fall through to the next free lane below. Previously every message in the same batch was assigned the same lane and rejected. ([`bb0ce52`](https://github.com/PiesP/yt-live-chat-overlay/commit/bb0ce52))
- **Backlog real-time lane preference** — Backlog messages prefer lanes that have no recent real-time traffic (`realTimeLanesUntil` map on the allocator). When zero-wait lanes exist without recent real-time messages, backlog uses those first, accepting a dropped message rather than mixing with real-time traffic on busy lanes. ([`aab1263`](https://github.com/PiesP/yt-live-chat-overlay/commit/aab1263))

### Fixed

- **Poll loop hang on dispose while paused** — `waitWhilePaused()` now checks the AbortSignal on each polling tick. Previously, when the session was disposed while chat was paused, the recursive `setTimeout` loop never resolved, blocking the entire start/restart chain. ([`30815bf`](https://github.com/PiesP/yt-live-chat-overlay/commit/30815bf))
- **text-measure widthCache not cleared on session destroy** — `clearTextMeasurementCaches()` added to `onDestroy()`. Stale entries from a previous session's font settings could return incorrect widths after a user changes font size. ([`30815bf`](https://github.com/PiesP/yt-live-chat-overlay/commit/30815bf))
- **Emitter frame-time spikes on mass expiry** — Replaced O(n²) `splice(i, 1)` reverse-iteration with an O(n) in-place filter pass in `renderFrame()`. ([`30815bf`](https://github.com/PiesP/yt-live-chat-overlay/commit/30815bf))
- **Drop-rate metric skew during video pause** — `onMessageReceived()` now called before the `isVideoPaused` check. Previously video-pause drops skipped `onMessageReceived()`, freezing the denominator and inflating the drop-rate ratio during video format transitions. ([`954b7b1`](https://github.com/PiesP/yt-live-chat-overlay/commit/954b7b1))
- **Emoji double HTTP request causing text→image flicker** — `prefetchImages()` created an Image whose `onload` called `loadImage()`, which created a second Image for the same URL. Emoji only appeared after the second request completed, doubling network latency. Now cached directly in `onload`. ([`be8d925`](https://github.com/PiesP/yt-live-chat-overlay/commit/be8d925))
- **Unhandled promise rejection in `pollContinuationReplay`** — Added `.catch()` guard to `void`-ed seek handler call. ([`eb3ea9a`](https://github.com/PiesP/yt-live-chat-overlay/commit/eb3ea9a))

### Refactored

- **Settings drop-rate warning** — Now includes the drop reason (`video_paused`, `rate_limited`, `queue_full`, `no_lane`) and suppresses warnings for expected video-pause drops. ([`954b7b1`](https://github.com/PiesP/yt-live-chat-overlay/commit/954b7b1))
- **Dead code removed** — `DropReason` type, `LaneState` 1-field interface (inlined into `laneIndex`), `setBacklogPartition`/`clearBacklogPartition` no-op methods, `onBacklogStateChange` no-op callback and all 3 call sites. 9 files changed, −94 lines. ([`3b61810`](https://github.com/PiesP/yt-live-chat-overlay/commit/3b61810), [`eb3ea9a`](https://github.com/PiesP/yt-live-chat-overlay/commit/eb3ea9a))
- **Barrel re-exports eliminated** — `youtubei-chat.ts` no longer re-exports types from sub-modules. Consumers import `InnertubeContinuationData`, `JsonObject`, etc. directly from `youtubei-continuation` or `youtubei-json`. ([`3b61810`](https://github.com/PiesP/yt-live-chat-overlay/commit/3b61810))
- **Async/promise hygiene** — Nested `.then()` in `fetch-interceptor` converted to async IIFE; `PollLoopManager` `.then/.catch/.finally` converted to async IIFE; `waitWhilePaused` rewritten to use `sleep()`+loop; 3 superfluous `async` keywords removed. ([`eb3ea9a`](https://github.com/PiesP/yt-live-chat-overlay/commit/eb3ea9a))
- **Text rendering extracted** — `renderSegment`, `renderContentSegments`, `renderWrappedText`, `cacheTextBitmap`, `strokeTextOutline` moved to `canvas-text-renderer.ts`. CanvasRenderer now -140 lines with clearer separation of concerns. ([`6e6aba2`](https://github.com/PiesP/yt-live-chat-overlay/commit/6e6aba2))

## [0.30.0] - 2026-05-22

### Added

- **Multi-message lane sharing** — Lanes are freed when a message's right edge passes the screen's RIGHT edge (plus headway gap), not the LEFT edge. Previously each lane held one message until it fully scrolled off-screen (~95% of duration). Now a new message can enter after only ~6% of duration, allowing ~16 messages to share the same lane simultaneously. Up to 120 concurrent messages on screen (up from 50). ([`6851be1`](https://github.com/PiesP/yt-live-chat-overlay/commit/6851be1))
- **Adaptive headway gap** — Gap between consecutive scrolling comments in the same lane is now proportional to message width: `clamp(msgWidth × 0.08, 16px, 60px)`. Short messages get 16px gap (vs fixed 40px, 60% reduction), long messages maintain 40px gap. ([`b351988`](https://github.com/PiesP/yt-live-chat-overlay/commit/b351988))
- **Velocity-aware durationMin** — `computeDliosDuration` now computes a speed-based floor: `max(3000, exitPaddingMin / velocity × 1000)`. At speedPxPerSec=500, short messages were previously clamped to 5000ms (capping effective speed at 307px/s). Now they run at the configured 500px/s. ([`7a04c1b`](https://github.com/PiesP/yt-live-chat-overlay/commit/7a04c1b))
- **Collision retry** — Messages that fail the bounding-box collision check are pushed to the back of the pending queue and retried next frame (instead of being permanently dropped). This significantly reduces drop rates during high-density bursts. ([`2789997`](https://github.com/PiesP/yt-live-chat-overlay/commit/2789997))
- **Large burst backlog routing** — `injectExternalMessages` (fetch interceptor / DOM watcher) and `flushReplayBuffer` now route batches >50 through the backlog controller instead of flooding the renderer directly. Eliminated the initial 90% drop spike on replay startup. ([`02d1ead`](https://github.com/PiesP/yt-live-chat-overlay/commit/02d1ead))
- **Height-aware lane allocation with vertical centering** — Messages with author shown (moderator, owner, superchat) are vertically centered within their multi-slot block via `LanePlacement.verticalOffset`, distributing empty space evenly. ([`f093f0b`](https://github.com/PiesP/yt-live-chat-overlay/commit/f093f0b))

### Fixed

- **Settings lost on page refresh** — `SettingsUi.close()` now only persists when the dialog is visible. `attach()` and `destroy()` no longer save unpopulated form values, which previously corrupted storage by clamping empty number inputs to minimum limits. ([`0ca39d6`](https://github.com/PiesP/yt-live-chat-overlay/commit/0ca39d6))
- **Settings X button not closing** — The header close button (X) was missing `data-action="close"` attribute, causing the delegated event handler to ignore it. ([`47a001b`](https://github.com/PiesP/yt-live-chat-overlay/commit/47a001b))
- **Multi-tab settings corruption** — Cross-tab `storage` event listener and `GM_addValueChangeListener` now trigger `SettingsUi.syncForm()` to update the open form, preventing stale form values from overwriting changes made in another tab. ([`f47c218`](https://github.com/PiesP/yt-live-chat-overlay/commit/f47c218))
- **GM storage returning `[object Object]`** — `settings-storage.ts` GM adapter now detects auto-parsed JSON objects from Violentmonkey/Greasemonkey 4+ and re-serializes them before returning. ([`ad54b58`](https://github.com/PiesP/yt-live-chat-overlay/commit/ad54b58))
- **Checkbox name collision** — Outline `enabled` and Overlay `enabled` checkboxes had the same HTML `name="enabled"`, causing one to overwrite the other on save. Fixed by using `resolveKey()` consistently in `buildField`. ([`973e5d8`](https://github.com/PiesP/yt-live-chat-overlay/commit/973e5d8))
- **Resume after tab switch with video paused** — `handleVisibility` no longer calls `renderer.resume()` when the video is paused. Previously it cleared `isPaused` while the video was still paused, causing `resumeForVideo()` → `resume()` to early-return when the user pressed play. ([`0ca15d3`](https://github.com/PiesP/yt-live-chat-overlay/commit/0ca15d3))
- **Gap between comments** — Lane height now excludes the author section (`authorSectionHeight + spacing.xs`). Most messages (`showAuthor.normal: false`) don't render an author, so the previous formula added ~31px of empty space between lanes. Author-shown messages auto-assign `slotCount=2` via the multi-slot allocator. ([`7cd805b`](https://github.com/PiesP/yt-live-chat-overlay/commit/7cd805b))
- **Safe zone not updating** — `RendererBase.updateSettings()` now calls `laneAllocator.updateSafeZone()` on every settings change. Previously safeTop/safeBottom changes only took effect on full renderer reset. ([`9d2b3d4`](https://github.com/PiesP/yt-live-chat-overlay/commit/9d2b3d4))

### Changed

- **maxConcurrentMessages default increased**: 50 → 120 (limit expanded to 300) to support multi-message lane sharing. ([`80f8ff3`](https://github.com/PiesP/yt-live-chat-overlay/commit/80f8ff3))
- **queueMaxSize increased**: 100 → 200 to prevent head-of-line blocking at higher concurrency. ([`80f8ff3`](https://github.com/PiesP/yt-live-chat-overlay/commit/80f8ff3))
- **backlogMaxRate default increased**: 10 → 20 msg/s to match higher lane throughput. ([`80f8ff3`](https://github.com/PiesP/yt-live-chat-overlay/commit/80f8ff3))

### Removed

- **"Timing Spread poll messages" setting** — `spreadEnabled` / `spreadFactor` settings and the SpreadEmitter class (168 lines) removed. Poll messages are now emitted as batches directly. ([`674544f`](https://github.com/PiesP/yt-live-chat-overlay/commit/674544f))
- **Over-engineered settings from UI** — Removed 6 settings that regular users don't need: `maxConcurrentMessages` (Performance), `backlogMaxRate` / `backlogSpeedMultiplier` / `backlogRecentMinutes` (Backlog technicals), `logLevel` / `showDebugOverlay` (Debug). Their defaults are sufficient. Backlog Mode selector remains. ([`c8ee4ce`](https://github.com/PiesP/yt-live-chat-overlay/commit/c8ee4ce))
- **Unused exports** — `RgbColor`, `MessageDimensions`, `SETTINGS_LIMITS`, `OUTLINE_SETTING_KEYS`, `VISUAL_ROOT_KEYS`, `SHOW_AUTHOR_KEYS`, `ChatHealthSnapshotOptions`, `MessageCallback`, `DropReason`, and 3 SuperChat opacity constants made internal. ([`95eb139`](https://github.com/PiesP/yt-live-chat-overlay/commit/95eb139))
- **No-op methods** — `updateSettings()` override in CanvasRenderer (pure pass-through), `apply()` wrapper in SettingsUi, `formatOutlineNumericSettingForInput` (pass-through), `emitBacklogMessage` wrapper, `rememberMessage` one-liner. ([`03b52b6`](https://github.com/PiesP/yt-live-chat-overlay/commit/03b52b6))
- **`HEADWAY_GAP_MS_MIN` / `HEADWAY_GAP_MS_MAX`** — No longer needed after multi-message lane sharing replaced the headway-time model with a pixel-gap model. ([`6851be1`](https://github.com/PiesP/yt-live-chat-overlay/commit/6851be1))

### Refactored

- **Codebase audit** — 5-phase refactoring across 47 source files: dead exports removed, import styles unified, no-op methods inlined, code complexity reduced, bug fixes applied. Net -96 lines across 20 files. ([`03b52b6`](https://github.com/PiesP/yt-live-chat-overlay/commit/03b52b6)..[`2e48d07`](https://github.com/PiesP/yt-live-chat-overlay/commit/2e48d07))
- **Lane allocator `computeOccupancyMs` simplified** — Removed separate `headwayMs` computation; the headway gap is now directly included in `rightEdgePassFraction`. ([`6851be1`](https://github.com/PiesP/yt-live-chat-overlay/commit/6851be1))
- **Player container selectors unified** — `PLAYER_CONTAINER_SELECTORS` exported from `dom.ts`, `video-pause-controller.ts` uses `findElementMatch()` instead of hardcoded selectors. ([`748dd8b`](https://github.com/PiesP/yt-live-chat-overlay/commit/748dd8b))

## [0.29.0] - 2026-05-19

### Added

- **Accurate SuperChat text wrapping** — New `measureWrappedLineCount()` in `text-measure.ts` uses Canvas `measureText` with a greedy word-wrapping algorithm to compute exact line counts. Handles explicit newlines and space-separated words correctly, replacing the previous `ceil(totalWidth / maxWidth)` approximation. ([`c462812`](https://github.com/PiesP/yt-live-chat-overlay/commit/c462812))
- **SuperChat-specific padding tokens** — `rendererLayout.superchat.paddingH` (24px) and `paddingV` (20px) added to `design-tokens.ts`, replacing inline `spacing.md * 2` / `spacing.sm + spacing.md` arithmetic in dimension estimation and rendering. ([`c462812`](https://github.com/PiesP/yt-live-chat-overlay/commit/c462812))

### Fixed

- **trapFocus visibility check** — `settings-ui.ts` used `backdrop.hidden` (HTML attribute) but `setDialogOpen` controls `display` CSS. Changed to `backdrop.style.display === 'none'` for correct state detection. ([`a16fef8`](https://github.com/PiesP/yt-live-chat-overlay/commit/a16fef8))
- **GM storage type safety** — `settings-storage.ts` `gmAdapter.getItem` now wraps return value in `String()` to ensure type safety when `GM_getValue` returns non-string values. ([`a16fef8`](https://github.com/PiesP/yt-live-chat-overlay/commit/a16fef8))
- **Unnecessary type casts removed** — `youtubei-chat.ts` removed redundant `window as unknown as { ytcfg?: unknown }` cast (already declared in `globals.d.ts`). `settings-schema.ts` replaced `as unknown as Record<string, unknown>` with explicit spread. `settings-ui-form.ts` replaced `as unknown as RootScalarSettingKey` with `as string as RootScalarSettingKey`. ([`d990151`](https://github.com/PiesP/yt-live-chat-overlay/commit/d990151))
- **SuperChat dimension estimation accuracy** — `estimateSuperChatDimensions` now uses `rendererLayout.authorSectionHeightPx` for author height (matching `drawAuthorSection` output) instead of recalculating from font metrics. Estimated height now exactly matches rendered height. ([`69db0d8`](https://github.com/PiesP/yt-live-chat-overlay/commit/69db0d8))

### Refactored

- **SuperChat badge-text-sticker layout** — Added `spacing.xs` gap between author section and badge (previously zero gap). Badge height uses `spacing.sm * 2` instead of hardcoded 8. Sticker positioned below actual text bottom instead of `fontSize * 1.4` approximation. All sub-element gaps unified to `spacing.xs`. ([`07ce8ef`](https://github.com/PiesP/yt-live-chat-overlay/commit/07ce8ef))
- **Color parser consolidation** — `parseRgbColor` and `parseHexColor` merged into single `parseAnyColor` function in `design-tokens.ts` (50 lines → 18 lines). All callers updated. ([`3a9a9c4`](https://github.com/PiesP/yt-live-chat-overlay/commit/3a9a9c4))
- **Image loading deduplication** — `renderer-canvas.ts` extracted `loadImage()` helper to eliminate duplicate image loading/caching logic across emoji, author photo, and sticker prefetch paths. ([`3a9a9c4`](https://github.com/PiesP/yt-live-chat-overlay/commit/3a9a9c4))
- **rgbaHex utility extraction** — Moved from `CanvasRenderer` static class method to module-level function in `renderer-canvas.ts` (not renderer-specific). ([`b923626`](https://github.com/PiesP/yt-live-chat-overlay/commit/b923626))
- **Toast styles moved to CSS** — `showToast` inline styles moved to `.yt-chat-overlay-settings-toast` CSS class in `settings-ui-styles.ts`. ([`df6804e`](https://github.com/PiesP/yt-live-chat-overlay/commit/df6804e))
- **Backlog sampling simplified** — `backlog-controller.ts` removed redundant ID-based deduplication Sets in `sampleMessages` tier partitioning. `isPriority` and `isSubstantialText` are already mutually exclusive. ([`fb85aa0`](https://github.com/PiesP/yt-live-chat-overlay/commit/fb85aa0))
- **Backlog controller initialization extracted** — `runtime-session.ts` extracted `ensureBacklogController()` from the 60-line `startChatSource` callback, reducing it to 15 lines. ([`e9f4971`](https://github.com/PiesP/yt-live-chat-overlay/commit/e9f4971))
- **Author section rendering deduplicated** — `renderer-canvas.ts` extracted `drawAuthorSection()` helper, eliminating ~30 lines of duplicate author photo+name rendering code shared between `renderRegular` and `renderSuperChat`. ([`a16fef8`](https://github.com/PiesP/yt-live-chat-overlay/commit/a16fef8))

### Removed

- **Unused `getDropBreakdown()`** — Removed from `ObservabilityReporter` (no callers). ([`fb85aa0`](https://github.com/PiesP/yt-live-chat-overlay/commit/fb85aa0))
- **Stale fix comments** — Removed BUG-1/BUG-4 fix comments from `renderer-canvas.ts` (already fixed). ([`b923626`](https://github.com/PiesP/yt-live-chat-overlay/commit/b923626))

## [0.28.0] - 2026-05-19

### Added

- **Backlog density ramp** — Injection rate linearly ramps from 25% to 100% over 4 seconds on startup, avoiding visual flooding. ([`63ad955`](https://github.com/PiesP/yt-live-chat-overlay/commit/63ad955))
- **Backlog/realtime lane partitioning** — Backlog messages use top half of lanes, realtime messages use bottom half during injection, preventing visual overlap. ([`5ed9e1c`](https://github.com/PiesP/yt-live-chat-overlay/commit/5ed9e1c))
- **Scroll mode fade-in for backlog** — Backlog messages fade in over 500ms in scroll/reverse modes to soften initial visual burst. Lane stagger on reset spreads messages evenly. ([`c328192`](https://github.com/PiesP/yt-live-chat-overlay/commit/c328192))
- **Negative lane spacing** — `laneSpacing` now supports negative values (-12 to 20) for tighter lane overlap. Default changed from 3 to -12. ([`9e7bcc8`](https://github.com/PiesP/yt-live-chat-overlay/commit/9e7bcc8), [`1e5e438`](https://github.com/PiesP/yt-live-chat-overlay/commit/1e5e438))

### Fixed

- **Diagonal entry patterns** — Removed per-lane `entryOffset` that caused different lanes to move at different speeds. All messages now start from the same vertical line. ([`668c933`](https://github.com/PiesP/yt-live-chat-overlay/commit/668c933))
- **Author photo offset and backlog sampling bug** — Fixed incorrect author photo Y offset and backlog sampling edge case. ([`3bc4949`](https://github.com/PiesP/yt-live-chat-overlay/commit/3bc4949))
- **Lane height computation** — `LaneAllocator` now computes `laneHeight` from actual font metrics instead of hardcoded multiplier, ensuring `msgHeight <= laneHeight` at `laneSpacing >= 0`. ([`e3b2a69`](https://github.com/PiesP/yt-live-chat-overlay/commit/e3b2a69))
- **Multi-slot allocation removed** — Messages always occupy exactly 1 lane slot. The 2-slot path was removed because it caused visible gaps when `laneHeight` dropped below `msgHeight`. ([`73f0668`](https://github.com/PiesP/yt-live-chat-overlay/commit/73f0668))

### Refactored

- **SuperChat dimension estimation unified** — `estimateSuperChatDimensions` now uses shared `computeSuperChatOpacities` and `resolveSuperChatRgb` from `design-tokens`. `VISUAL_ROOT_KEYS` derived from `ROOT_SETTING_META`. ([`a397a25`](https://github.com/PiesP/yt-live-chat-overlay/commit/a397a25))
- **Text measurement precision** — Switched from `TextMetrics.width` (advance width) to `actualBoundingBoxLeft + actualBoundingBoxRight` for glyph overshoot accuracy. ([`2e475fe`](https://github.com/PiesP/yt-live-chat-overlay/commit/2e475fe))
- **4-ary heap** — Lane allocator priority queue converted from binary to 4-ary heap for better cache locality. ([`83da2dc`](https://github.com/PiesP/yt-live-chat-overlay/commit/83da2dc))
- **Text bitmap cache** — Pre-rendered text with outline stored as offscreen canvas, replacing repeated `fillText()`/`strokeText()` calls in the hot path. ([`463540d`](https://github.com/PiesP/yt-live-chat-overlay/commit/463540d))
- **Priority queue binary search** — `findQueueInsertIndex` uses binary search for O(log n) insertion into the priority-sorted pending queue. ([`dbc321f`](https://github.com/PiesP/yt-live-chat-overlay/commit/dbc321f))
- **Weighted lane selection** — Lane selection now prefers lanes with fewer total messages for visual balance. ([`cc1d6cd`](https://github.com/PiesP/yt-live-chat-overlay/commit/cc1d6cd))
- **Top/bottom mode bypass** — Fixed modes bypass `LaneAllocator` entirely, using direct Y positioning. ([`5a2dfe3`](https://github.com/PiesP/yt-live-chat-overlay/commit/5a2dfe3))

### Performance

- **Canvas alpha disabled** — `alpha: false` on canvas context for GPU compositing savings (reverted in v0.28.0 due to black screen on some GPUs). ([`ab98dc6`](https://github.com/PiesP/yt-live-chat-overlay/commit/ab98dc6))

## [0.27.0] - 2026-05-19

### Refactored

- **Duplicate code consolidation** — Consolidated duplicate code patterns and fixed 4-ary heap build index. ([`d06a2e7`](https://github.com/PiesP/yt-live-chat-overlay/commit/d06a2e7))

## [0.26.0] - 2026-05-15

### Added

- **Cross-tab settings sync** — Settings changes in one tab propagate to other tabs via `StorageEvent` + `GM_addValueChangeListener`. Settings class subscribes to both channels and notifies registered callbacks. ([`cadd26f`](https://github.com/PiesP/yt-live-chat-overlay/commit/cadd26f))
- **Settings schema versioning** — `SETTINGS_VERSION=1` with `migrateSettings()` pipeline. Raw stored settings are migrated on load to support future breaking schema changes. ([`12b2b86`](https://github.com/PiesP/yt-live-chat-overlay/commit/12b2b86))
- **Settings preview/persistence separation** — `Settings.preview()` writes to memory only; `Settings.persist()` writes to storage. Settings UI now uses `onPreview` (slider drag) and `onPersist` (modal close) callbacks, reducing localStorage writes to once per settings dialog session. ([`6fc41c5`](https://github.com/PiesP/yt-live-chat-overlay/commit/6fc41c5))
- **Import feedback toast** — Visual confirmation when importing settings JSON, with sanitized prototype-pollution key rejection. ([`10b2ffa`](https://github.com/PiesP/yt-live-chat-overlay/commit/10b2ffa))
- **Auto outline color** — `renderSegment()` now computes outline color via `computeOutlineColor()` using WCAG 2.0 relative luminance, selecting black or white outline based on text color brightness. ([`e2ce29c`](https://github.com/PiesP/yt-live-chat-overlay/commit/e2ce29c), [`6b45103`](https://github.com/PiesP/yt-live-chat-overlay/commit/6b45103))

### Refactored

- **Display scale/precision moved to ROOT_SETTING_META (SSOT)** — `displayScale` and `displayPrecision` are now fields in `ROOT_SETTING_META` instead of a separate `ROOT_NUMERIC_OPTIONS` map. ([`0f09559`](https://github.com/PiesP/yt-live-chat-overlay/commit/0f09559))
- **Backlog tick timer** — `requestIdleCallback` replaced with simple `setTimeout` for broader compatibility and fewer edge cases. ([`f76554d`](https://github.com/PiesP/yt-live-chat-overlay/commit/f76554d))
- **BootstrapResolver retry logic simplified** — Single-loop implementation with exponential backoff, no nested counters. ([`113e787`](https://github.com/PiesP/yt-live-chat-overlay/commit/113e787))
- **`_paused` renamed to `chatPaused`** — Clarifies the flag applies to chat polling, not renderer animations. ([`2229be1`](https://github.com/PiesP/yt-live-chat-overlay/commit/2229be1))
- **Expired message removal** — `filter()` replaces swap-pop pattern for clarity. ([`f9cf5cb`](https://github.com/PiesP/yt-live-chat-overlay/commit/f9cf5cb))
- **Drop rate computation simplified** — `refreshDerivedMetrics()` streamlined. ([`5370e13`](https://github.com/PiesP/yt-live-chat-overlay/commit/5370e13))
- **`drawAuthorPhoto()` extracted** — Eliminates duplicate photo rendering in `renderSuperChat()` and `renderRegular()`. ([`dad08be`](https://github.com/PiesP/yt-live-chat-overlay/commit/dad08be))
- **Outline stroke logic deduplicated** via `strokeTextOutline()` helper. ([`ecdc1c1`](https://github.com/PiesP/yt-live-chat-overlay/commit/ecdc1c1))
- **FONT_FAMILY SSOT** — `DEFAULT_SETTINGS.fontFamily` is now the single source; `text-measure.ts` derives its default from it. ([`51d94cc`](https://github.com/PiesP/yt-live-chat-overlay/commit/51d94cc))
- **RendererBase JSDoc fixed** — Updated to match actual `isVideoPaused` architecture (video pause vs tab visibility). ([`4d8dd51`](https://github.com/PiesP/yt-live-chat-overlay/commit/4d8dd51))

### Removed

- **`pnpm-workspace.yaml`** — Single-package project; workspace config was unused. ([`f333aad`](https://github.com/PiesP/yt-live-chat-overlay/commit/f333aad))
- **`blurPx` from `OutlineSettings`** — Unused field; CSS renderer uses `text-shadow` blur, Canvas2D uses `strokeText` which has no blur parameter. ([`a32037c`](https://github.com/PiesP/yt-live-chat-overlay/commit/a32037c))

### Performance

- **Reduced `performance.now()` calls** — From 3 to 1 per render frame in the Canvas2D render loop. ([`8676b6b`](https://github.com/PiesP/yt-live-chat-overlay/commit/8676b6b))

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
