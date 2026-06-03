# AGENTS.md

AI coding guidance for **YouTube Live Chat Overlay**.

This repository produces three distribution targets from a single shared codebase:
- **Userscript** (Tampermonkey/Violentmonkey)
- **Chrome MV3 Extension** (also Edge, Brave, Vivaldi)
- **Firefox MV3 Extension**

All processing is done locally in the browser. Core business logic is platform-agnostic.

## Stack

- TypeScript 6.0.x
- Vite 8.x
- Biome 2.x
- pnpm 11.x
- Node.js 26.x

## Repository Structure

- `src/` — shared source code
  - `src/core/` — platform-agnostic business logic (renderers, lane allocator, chat parser, settings)
  - `src/platform/` — platform abstraction layer (adapter interfaces + implementations)
  - `src/types/` — shared type definitions
- `extension/` — extension-specific files (manifests, background SW, content script entry)
- `dist/` — userscript build artifacts (gitignored)
- `dist-extension/` — Chrome extension build artifacts (gitignored)
- `dist-extension-firefox/` — Firefox extension build artifacts (gitignored)

## Platform Abstraction

All platform-specific code is isolated in `src/platform/` behind adapter interfaces. Core modules (`src/core/`) never reference `GM_*`, `chrome.*`, or `browser.*` directly.

| Capability | Interface | Userscript impl | Extension impl |
|---|---|---|---|
| Storage | `StorageAdapter` | `GmStorageAdapter` | `ChromeStorageAdapter` |
| Worker URL | `WorkerFactory` | `ViteWorkerFactory` | `ChromeExtensionWorkerFactory` |
| Menu commands | `MenuAdapter` | `GmMenuAdapter` | contextMenus via background SW |
| Cross-tab sync | (inline in Settings) | `GM_addValueChangeListener` | `chrome.storage.onChanged` |

When adding a new platform-dependent feature, add an adapter interface in `src/platform/types.ts`, create implementations in a new `src/platform/*-adapters.ts`, and wire through `src/platform/bootstrap.ts`.

## Language Policy

- **Communication language**: The user may give instructions in Korean during chat. AI agents should respond to questions and discuss tasks in Korean when the user writes in Korean.
- **File content language**: All file content — source code, comments, documentation, commit messages, PR descriptions, changelogs, plans, specs, and any written artifact committed to the repository — must be **English only**. Korean is never written into files.
- This means: chat in Korean, write in English.

## Core Constraints

- **No external runtime dependencies**: zero runtime dependencies, 100% local processing.
- **No server involvement**: all comment overlay logic runs in the user's browser.
- **Greasy Fork rules**: scripts must not be minified/obfuscated.
- Commit messages: **English**, conventional commits.

## Commands

```bash
# Userscript
pnpm build           # prod bundle (runs quality via prebuild)
pnpm build:dev       # dev bundle with source maps

# Extensions
pnpm build:extension          # Chrome extension (output: dist-extension/)
pnpm build:extension:firefox  # Firefox extension (output: dist-extension-firefox/)

# Quality
pnpm check           # TypeScript type check (no emit)
pnpm lint            # Biome lint
pnpm lint:fix        # Biome lint --write
pnpm fmt             # Biome format check
pnpm fmt:fix         # Biome format --write
pnpm knip            # Unused dependency scan (dependencies only)
pnpm knip:full       # Full unused files/exports/deps scan
pnpm circular        # Detect circular dependencies
pnpm quality         # fmt + lint + check + circular + knip
pnpm quality:fix     # quality with auto-fix
pnpm clean           # rm -rf dist
```

**Important**: The main `tsconfig.json` excludes `extension/` because extension code makes different assumptions (e.g., `chrome` is always defined in service workers). Extension code is type-checked at build time by Vite.

## Extension-Specific Rules

- **Content script is IIFE**: The extension content script must be built as `iife` format (via `build.lib` in `vite.config.extension.cs.ts`) because MAIN world scripts are injected as classic `<script>` elements and cannot use ES module syntax.
- **Workers in `web_accessible_resources`**: All worker bundles must be listed in `manifest.json`'s `web_accessible_resources` so the content script can spawn them via `chrome.runtime.getURL()`.
- **`chrome` type declarations**: Minimal type declarations live in `src/platform/chrome-types.d.ts` — no `@types/chrome` dependency. All `chrome.*` accesses are guarded with `typeof chrome !== 'undefined'` checks.
- **Firefox differences**: Firefox manifest uses `menus` permission (vs `contextMenus`), `browser_specific_settings.gecko.id`, and `background.scripts` (vs `service_worker`). No `self.Translator` API support — translation auto-disables.

## Code Rules

- Follow `CODE_STANDARDS.md` for detailed conventions.
- Keep the bundle small and efficient.
- Use `MutationObserver` for DOM change detection where applicable.
- Use `createLogger('[ModuleName]')` from `@core/logging` for structured runtime logging.

## Code Architecture

### Lane Allocation (3-Phase Speed-Isolated)

The `LaneAllocator` uses a three-phase speed-isolated allocation that naturally groups same-speed messages together:

**Phase 1 — zero-wait with speed filter**: lanes scanned 0→N. Real-time messages skip lanes with active backlog content (`backlogLanesUntil`); backlog messages skip lanes with active real-time content (`realTimeLanesUntil`). First completely free compatible lane wins (epsilon-greedy 5% skip for variety).

**Phase 2 — speed-matched busy lane**: when all lanes busy, prefer lanes already running at the same speed profile (real-time likes real-time, backlog likes backlog). Shortest wait wins.

**Phase 3 — fastest-free (real-time only)**: fallback to topmost busy lane regardless of speed. Backlog messages return null here — they don't compete with real-time on busy lanes.

**Speed-isolated lane tracking**: `realTimeLanesUntil` / `backlogLanesUntil` are tracked for the full message duration (not just right-edge-pass time). This ensures the speed-isolated filter remains active while the message is visible on screen, structurally preventing cross-speed overtaking. A faster backlog message can never enter a lane where a slower real-time message is still visible.

**Speed-aware headway**: the bounding-box check in `checkPlacement()` scales the entry headway by `backlogSpeedMultiplier` for cross-speed scenarios. This is a safety net — the duration-based speed-isolated filter already prevents cross-speed lane sharing in the normal case.

**Collision feedback**: `checkPlacement()` calls `markCollision(laneIndex)` on collision. Subsequent `findPlacement()` in same batch skip that lane.

No rotation or hard-coded partitions — lanes self-organize into visual speed zones naturally.

### Multi-Message Lane Sharing

- **Lane height**: `textHeight + paddingV*2 + laneSpacing` (author section excluded; author-shown messages get `slotCount>=2` via multi-slot allocator).
- **Adaptive headway**: `headwayPx = clamp(msgWidth × 0.08, 16px, 60px)`. Speed-aware variant multiplies by speed ratio when cross-speed.
- **Right-edge exit**: lanes freed when message's right edge passes `screenWidth - headwayPx` (not the left edge).
- **Vertical centering**: tall messages centered within multi-slot block via `verticalOffset = floor((slotCount * laneHeight - msgHeight) / 2)`.

### Backlog Injection

- **Poisson-distributed spacing**: intervals sampled from exponential distribution with adaptive floor (`max(32, meanInterval × 0.6)`). Prevents temporal clustering from sub-32ms back-to-back injections.
- **Density ramp**: injection rate ramps from 25%→100% over 2.5s (up to 4s for large backlogs).
- **Utilization-aware throttling**: injection slows when lanes are full.

### Settings System

- **SSOT defaults**: `DEFAULT_FONT_FAMILY` in `design-tokens.ts` — consumed by settings-schema, renderer-shared, text-measure.
- **On-preview / on-persist split**: live preview uses memory-only `preview()`, storage write only on explicit dialog close. `destroy()` does NOT persist.
- **Cross-tab sync**: `Settings.subscribe()` + `SettingsUi.syncForm()` keeps form in sync on cross-tab changes.
- **Async storage**: `Settings.initialize()` is async to support `chrome.storage.local`. All callers use `await`.

### Message Lifecycle & Observability

```
YouTube API → ChatSource (poll loop with AbortSignal check in waitWhilePaused)
  ↕                              ↕
FetchInterceptor + DOM watcher   BacklogController (if batch > 50)
  ↕
addMessage → isMessageAllowed (onMessageReceived first, always)
  → pendingQueue (priority sorted) → drainQueue
    → findPlacement → checkPlacement (speed-aware headway)
    → markCollision on collision → push back for retry
    → enqueueMessageWithPlacement → commitPlacement
      (tracks realTimeLanesUntil + backlogLanesUntil for speed isolation)
```

- **Drop rate warning**: includes reason (`video_paused`, `rate_limited`, `queue_full`, `no_lane`). `video_paused` drops suppressed from warning.
- **Emoji loading**: `prefetchImages()` writes directly to `emojiCache` (no double HTTP request). Triggers immediate rAF restart on load.
- **Text rendering**: extracted to `canvas-text-renderer.ts` (renderSegment, renderContentSegments, renderWrappedText, strokeTextOutline, plus card renderers: renderRegularMessage, renderSuperChatCard, renderMembershipCard, drawAuthorSection, drawRoundRect).

### Code Modules

| Module | Responsibility |
|---|---|
| `lane-allocator.ts` | 3-phase speed-isolated allocation, 4-ary min-heap, collision feedback, dual speed-profile tracking |
| `canvas-text-renderer.ts` | Text/emoji/bitmap rendering + message card renderers extracted from renderer-canvas |
| `renderer-canvas.ts` | Render loop, queue drain, opacity pipeline, speed-aware headway, image caching (770 lines; extracted ~340 lines of render methods) |
| `backlog-controller.ts` | Poisson-distributed injection, density ramp, utilization throttling, sampling |
| `chat-source-base.ts` | Poll loop foundation, `waitWhilePaused()` with AbortSignal check |
| `chat-source-live.ts` | Live YouTube chat polling with adaptive delay |
| `chat-source-replay.ts` | Replay chat fetching via continuation |
| `observability.ts` | Drop rate tracking with reason tagging |
| `runtime-session.ts` | Session lifecycle, foreground listeners, health watchdog |
| `design-tokens.ts` | SSOT constants: colors, layout, DEFAULT_FONT_FAMILY, compute* helpers |
| `platform/` | Adapter interfaces + implementations for storage, workers, menus, cross-tab sync |

### Danmaku Modes

Four display modes share the same lane allocator, queue, and opacity pipeline:

| Mode | Direction | Position | Occupancy model |
|---|---|---|---|
| `scroll` | RTL (right→left) | Per-frame `msg.x = startX - progress × travel` | Precision exit-time |
| `reverse` | LTR (left→right) | Per-frame `msg.x = startX + progress × travel` | Precision exit-time |
| `top` | Fixed, top-aligned | Centered `(dims.w − msgW) / 2`, no movement | Cooldown (4000ms + 15%) |
| `bottom` | Fixed, bottom-aligned | Centered `(dims.w − msgW) / 2`, no movement | Cooldown (4000ms + 15%) |

**Critical rule**: Any change to Scroll mode formulas MUST be verified across all 4 modes (scroll, reverse, top, bottom) at all 3 code sites (duration/position/collision). Verify with cross-mode grep and test suite.
