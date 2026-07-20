// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

// ── Field & pane type definitions ─────────────────────────────────────────────

interface BaseField {
  label: string;
  key: string;
  title?: string;
  modifier?: string;
}

interface NumberField extends BaseField {
  type: 'number';
}
interface CheckboxField extends BaseField {
  type: 'checkbox';
}
interface SelectField extends BaseField {
  type: 'select';
  options: ReadonlyArray<[string, string]>;
}
interface TextField extends BaseField {
  type: 'text';
  placeholder?: string;
  /** Datalist suggestions for autocomplete (e.g., font family names). */
  suggestions?: string[];
}
export interface FontPreviewField {
  type: 'font-preview';
}
export interface WeightToggleField extends BaseField {
  type: 'weight-toggle';
  options: ReadonlyArray<[string, string]>;
}
export interface FontChipsField extends BaseField {
  type: 'font-chips';
  /** Font family suggestions as clickable chips. */
  suggestions: string[];
}
interface EnabledField {
  type: 'enabled';
  title?: string;
}
export interface AuthorGridField {
  type: 'author-grid';
}
interface RangeField extends BaseField {
  type: 'range';
}

export type FieldDef =
  | NumberField
  | CheckboxField
  | SelectField
  | TextField
  | FontPreviewField
  | WeightToggleField
  | FontChipsField
  | EnabledField
  | AuthorGridField
  | RangeField;

type SectionDef = {
  title: string;
  fields: FieldDef[];
};

export interface PaneDef {
  id: string;
  label: string;
  sections: SectionDef[];
}

// ── Shorthand constructors ──────────────────────────────────────────────────

const num = (label: string, key: string, title?: string, modifier?: string): NumberField => ({
  type: 'number',
  label,
  key,
  ...(title !== undefined ? { title } : {}),
  ...(modifier !== undefined ? { modifier } : {}),
});
const chk = (label: string, key: string, title?: string, modifier?: string): CheckboxField => ({
  type: 'checkbox',
  label,
  key,
  ...(title !== undefined ? { title } : {}),
  ...(modifier !== undefined ? { modifier } : {}),
});
const sel = (
  label: string,
  key: string,
  options: ReadonlyArray<[string, string]>,
  title?: string
): SelectField => ({
  type: 'select' as const,
  label,
  key,
  options,
  ...(title !== undefined ? { title } : {}),
});
const range = (label: string, key: string, title?: string, modifier?: string): RangeField => ({
  type: 'range' as const,
  label,
  key,
  ...(title !== undefined ? { title } : {}),
  ...(modifier !== undefined ? { modifier } : {}),
});
const fontPreview = (): FontPreviewField => ({
  type: 'font-preview' as const,
});

const weightToggle = (
  label: string,
  key: string,
  options: ReadonlyArray<[string, string]>,
  title?: string
): WeightToggleField => ({
  type: 'weight-toggle' as const,
  label,
  key,
  options,
  ...(title !== undefined ? { title } : {}),
});

const fontChips = (
  label: string,
  key: string,
  suggestions: string[],
  title?: string
): FontChipsField => ({
  type: 'font-chips' as const,
  label,
  key,
  suggestions,
  ...(title !== undefined ? { title } : {}),
});

// ── Declarative field schemas ────────────────────────────────────────────────

/** Common font families suggested in the font picker autocomplete list. */
const FONT_SUGGESTIONS: string[] = [
  // System defaults
  'system-ui, -apple-system, sans-serif',
  // Windows
  '"Segoe UI", system-ui, sans-serif',
  // macOS / iOS
  '"-apple-system", "Helvetica Neue", sans-serif',
  // Android / ChromeOS
  '"Roboto", system-ui, sans-serif',
  // CJK fonts
  '"Noto Sans KR", sans-serif',
  '"Noto Sans JP", sans-serif',
  '"Noto Sans SC", sans-serif',
  '"Noto Sans TC", sans-serif',
  '"Malgun Gothic", sans-serif',
  '"Microsoft YaHei", sans-serif',
  '"Meiryo", sans-serif',
  // Monospace
  '"Cascadia Code", "Fira Code", monospace',
  '"JetBrains Mono", monospace',
  '"Source Code Pro", monospace',
  'monospace',
  // Sans-serif
  'Arial, sans-serif',
  '"Helvetica Neue", Arial, sans-serif',
  'Verdana, sans-serif',
  '"Trebuchet MS", sans-serif',
  'sans-serif',
  // Serif
  'Georgia, serif',
  '"Times New Roman", serif',
  'serif',
  // Cursive / decorative
  '"Comic Sans MS", cursive',
  'Impact, sans-serif',
  '"Arial Black", sans-serif',
];

export const PANES: PaneDef[] = [
  {
    id: 'comments',
    label: 'pane.comments',
    sections: [
      {
        title: '',
        fields: [
          {
            type: 'enabled',
            title: 'Globally enable or disable the chat overlay on YouTube live streams',
          },
        ],
      },
      {
        title: '',
        fields: [
          sel(
            'danmaku.mode',
            'danmakuMode',
            [
              ['scroll', 'Scroll (RTL)'],
              ['reverse', 'Reverse (LTR)'],
              ['top', 'Top Fixed'],
              ['bottom', 'Bottom Fixed'],
            ],
            'danmaku.modeDesc'
          ),
          num(
            'danmaku.scrollSpeed',
            'speedPxPerSec',
            'How fast comments scroll across the screen in pixels per second'
          ),
          range('danmaku.textOpacity', 'opacity', 'Overall opacity of comment text (50-100%)'),
          range(
            'danmaku.laneGap',
            'laneSpacing',
            'Vertical gap between comment rows (0 = adjacent rows)'
          ),
          num(
            'danmaku.exitPadding',
            'exitPaddingPx',
            'Extra pixels a message scrolls past the screen edge before being removed (20-400, default 100)'
          ),
          num(
            'danmaku.durationMul',
            'modOwnerDurationMultiplier',
            'How much longer moderator and owner messages stay visible (1.0 = same as regular, 2.0 = twice as long)'
          ),
        ],
      },
      {
        title: 'danmaku.timing',
        fields: [
          num(
            'danmaku.minScrollDuration',
            'scrollDurationMinMs',
            'Minimum scroll animation duration — prevents very short messages from zipping across (1000-15000ms, default 5000)'
          ),
          num(
            'danmaku.maxScrollDuration',
            'scrollDurationMaxMs',
            'Maximum scroll animation duration — prevents very long messages from crawling (5-120s, default 30000ms)'
          ),
          num(
            'danmaku.topBottomDuration',
            'topBottomDurationMs',
            'Fixed display duration for top/bottom mode messages (1000-30000ms, default 4000)'
          ),
        ],
      },
      {
        title: 'danmaku.safeZone',
        fields: [
          range('danmaku.topClearZone', 'safeTop', 'Keep top N% of video free of comments'),
          range(
            'danmaku.bottomClearZone',
            'safeBottom',
            'Keep bottom N% of video free of comments'
          ),
        ],
      },
      {
        title: 'danmaku.font',
        fields: [
          fontPreview(),
          num('danmaku.fontSize', 'fontSize', 'Text size in pixels (14-50)'),
          weightToggle(
            'Weight',
            'fontWeight',
            [
              ['bold', 'Bold'],
              ['normal', 'Regular'],
            ],
            'Bold is more readable, Regular uses less GPU memory'
          ),
          fontChips('Family', 'fontFamily', FONT_SUGGESTIONS, 'Font family for comment text'),
        ],
      },
    ],
  },
  {
    id: 'colors',
    label: 'pane.appearance',
    sections: [
      {
        title: 'appearance.cards',
        fields: [
          range(
            'appearance.superchatOpacity',
            'superChatOpacity',
            'Background opacity of Super Chat cards'
          ),
          num(
            'appearance.superchatMaxLines',
            'superChatMaxBodyLines',
            'Max body text lines before truncation (2-10)'
          ),
          num(
            'appearance.membershipMaxLines',
            'membershipMaxBodyLines',
            'Max body text lines for membership messages (1-5)'
          ),
          chk(
            'appearance.showSuperchatAmount',
            'showSuperChatAmount',
            'Display the purchase amount badge on Super Chat cards'
          ),
          chk(
            'appearance.preserveUserappearance.authorsColors',
            'preserveUserappearance.authorsColor',
            "Use author's chosen text color from YouTube chat instead of overlay defaults"
          ),
        ],
      },
      {
        title: 'appearance.outline',
        fields: [
          chk(
            'appearance.outlineEnabled',
            'enabled',
            'Add a dark outline stroke around text for better readability',
            'outline'
          ),
          num(
            'appearance.outlineWidth',
            'widthPx',
            'Text outline stroke width in pixels (0-8)',
            'outline'
          ),
          range(
            'appearance.outlineOpacity',
            'opacity',
            'Text outline stroke opacity (0-100%)',
            'outline'
          ),
        ],
      },
      { title: 'appearance.authors', fields: [{ type: 'author-grid' as const }] },
    ],
  },
  {
    id: 'advanced',
    label: 'pane.advanced',
    sections: [
      {
        title: 'advanced.messageRate',
        fields: [
          chk(
            'advanced.ignoreMinLength',
            'allowShortTextMessages',
            'Show all messages regardless of minimum character length'
          ),
          num('advanced.minLength', 'minTextLength', 'Minimum character count'),
          sel(
            'advanced.authorRateLimit',
            'authorRateLimit',
            [
              ['off', 'Off'],
              ['normal', 'Normal (5 msg / 5s)'],
              ['strict', 'Strict (2 msg / 5s)'],
            ],
            'Limits how frequently messages from the same author appear'
          ),
        ],
      },
      {
        title: 'advanced.backlog',
        fields: [
          sel(
            'advanced.backlogMode',
            'backlogMode',
            [
              ['playback', 'Playback-based (recommended)'],
              ['recent', 'Recent only'],
              ['full', 'Full (show all)'],
              ['none', 'None (skip backlog)'],
            ],
            'How past chat messages are displayed relative to live playback'
          ),
          range(
            'advanced.backlogOpacity',
            'backlogOpacityMultiplier',
            'Opacity of past messages relative to real-time messages'
          ),
          num(
            'advanced.backlogInjectionRate',
            'backlogMaxRate',
            'Maximum backlog message injection rate per second (0-50)'
          ),
          num(
            'advanced.backlogSpeed',
            'backlogSpeedMultiplier',
            'Animation speed multiplier for backlog messages (1-5)'
          ),
          num(
            'advanced.backlogRecentWindow',
            'backlogRecentMinutes',
            'Time window in minutes for recent-only backlog mode (1-30)'
          ),
        ],
      },
      {
        title: 'advanced.depthLayers',
        fields: [
          chk(
            'appearance.outlineEnabled',
            'depthLayersEnabled',
            'Speed-based depth perception: fast messages appear near, slow messages appear far'
          ),
          range(
            'advanced.depthNearSpeed',
            'depthNearSpeedMul',
            'Speed boost for near-layer messages'
          ),
          range(
            'advanced.depthFarSpeed',
            'depthFarSpeedMul',
            'Speed reduction for far-layer messages'
          ),
          range(
            'advanced.depthFarOpacity',
            'depthFarOpacityMul',
            'Opacity dimming for far-layer messages'
          ),
        ],
      },
      {
        title: 'advanced.performance',
        fields: [
          num(
            'advanced.maxConcurrent',
            'maxConcurrentMessages',
            'Maximum number of messages visible on screen at once (30-300)'
          ),
          num(
            'advanced.fadeDuration',
            'fadeDurationMs',
            'How long messages take to fade out (0 = instant, 50-1000)'
          ),
          num(
            'advanced.minPollInterval',
            'minPollIntervalMs',
            'Minimum chat polling interval in milliseconds (50-5000)'
          ),
          num(
            'advanced.maxPollInterval',
            'maxPollIntervalMs',
            'Maximum chat polling interval in milliseconds (1000-30000)'
          ),
          num(
            'advanced.maxQueueDepth',
            'queueMaxSize',
            'Maximum pending queue depth before messages are dropped (50-1000, default 200)'
          ),
          num(
            'advanced.tabTrimTarget',
            'backgroundQueueMax',
            'Target active message count when trimming background tab (10-500, default 50)'
          ),
          num(
            'advanced.maxMessageAge',
            'maxMessageAgeMs',
            'Maximum message age before fade-out removal (10-300s, default 60000ms)'
          ),
          range(
            'danmaku.messageSpacing',
            'headwayGapRatio',
            'Gap between consecutive messages as percentage of message width (2-30%, default 8)'
          ),
          num(
            'advanced.translationBatchSize',
            'translationBatchSize',
            'Max translations applied per frame to avoid spikes (1-20, default 5)'
          ),
        ],
      },
      {
        title: 'advanced.cache',
        fields: [
          num(
            'advanced.emojiCache',
            'emojiCacheMb',
            'Max memory for emoji image cache (1-20 MB, default 3)'
          ),
          num(
            'advanced.photoCache',
            'photoCacheMb',
            'Max memory for author photo cache (1-20 MB, default 2)'
          ),
          num(
            'advanced.stickerCache',
            'stickerCacheMb',
            'Max memory for sticker image cache (1-20 MB, default 1)'
          ),
          num(
            'advanced.textCache',
            'textCacheMb',
            'Max memory for text bitmap cache (1-20 MB, default 4)'
          ),
          num(
            'advanced.emojiFetchLimit',
            'emojiFetchLimit',
            'Max concurrent emoji fetch operations (1-20, default 6)'
          ),
          num(
            'advanced.emojiRetryMin',
            'failedEmojiRetryMins',
            'How long to wait before retrying failed emoji fetches (1-60 min, default 5)'
          ),
        ],
      },
      {
        title: 'advanced.burst',
        fields: [
          num('advanced.burstSampleWindow', 'burstSampleWindow', 'Burst rate sample window size'),
          num(
            'advanced.burstElevated',
            'burstElevatedThreshold',
            'Messages per second threshold for elevated burst level'
          ),
          num(
            'advanced.burstHigh',
            'burstHighThreshold',
            'Messages per second threshold for high burst level'
          ),
          num(
            'advanced.burstExtreme',
            'burstExtremeThreshold',
            'Messages per second threshold for extreme burst level'
          ),
        ],
      },
      {
        title: 'advanced.tuning',
        fields: [
          num(
            'advanced.tuningBacklogInjectionMax',
            'backlogInjectionMax',
            'Maximum backlog injection rate cap'
          ),
          num(
            'advanced.tuningDensityRamp',
            'backlogDensityRampMs',
            'Density ramp duration for backlog injection in milliseconds'
          ),
          num(
            'advanced.tuningPollFallback',
            'livePollFallbackMs',
            'Live poll fallback delay in milliseconds'
          ),
          num(
            'advanced.tuningPollFailureLimit',
            'livePollFailureLimit',
            'Consecutive poll failures before circuit breaker trips'
          ),
          num(
            'advanced.tuningSpeedBoostThreshold',
            'speedBoostThreshold',
            'Pending messages to trigger speed boost'
          ),
          range(
            'advanced.tuningBacklogPause',
            'backlogPauseThreshold',
            'Lane utilization ratio to pause backlog injection'
          ),
          range(
            'advanced.tuningBacklogResume',
            'backlogResumeThreshold',
            'Lane utilization ratio to resume backlog injection'
          ),
          num(
            'advanced.tuningActivityTimeout',
            'activityTimeoutMs',
            'Chat activity timeout in milliseconds'
          ),
          num(
            'advanced.tuningStaggerMax',
            'staggerMaxDelayMs',
            'Max stagger delay for messages in same batch'
          ),
          num(
            'advanced.tuningStaggerMedium',
            'staggerMediumDelayMs',
            'Medium stagger delay when queue depth is medium'
          ),
          num(
            'advanced.tuningEmojiTimeout',
            'emojiFetchTimeoutMs',
            'Timeout for emoji fetch operations'
          ),
          num(
            'advanced.tuningDensityRampMax',
            'backlogDensityRampMaxMs',
            'Max density ramp duration for backlog injection'
          ),
          num(
            'advanced.tuningInjectionRateMin',
            'backlogInjectionRateMin',
            'Minimum backlog injection rate (msg/s)'
          ),
          num(
            'advanced.tuningSpeedBoostMax',
            'speedBoostMax',
            'Max speed boost factor for burst compensation'
          ),
          num(
            'advanced.tuningSpeedBoostDenom',
            'speedBoostDenom',
            'Speed boost denominator for EMA rate scaling'
          ),
          num(
            'advanced.tuningToggleCooldown',
            'backlogToggleCooldownMs',
            'Cooldown between backlog pause toggles'
          ),
          num(
            'advanced.replayPrefetchPages',
            'replayPrefetchPages',
            'Max pages to prefetch in replay mode'
          ),
          num(
            'advanced.replayBatchLimit',
            'replayBatchLimit',
            'Max batches to fetch in replay initialization'
          ),
        ],
      },
      {
        title: 'advanced.developer',
        fields: [
          sel(
            'advanced.logLevel',
            'logLevel',
            [
              ['warn', 'Warnings only'],
              ['info', 'Info'],
              ['debug', 'Debug (verbose)'],
            ],
            'Console diagnostic output verbosity'
          ),
          chk(
            'advanced.debugOverlay',
            'showDebugOverlay',
            'Show performance debug overlay on the video player'
          ),
          chk(
            'advanced.ignoreReducedMotion',
            'ignoreReducedMotion',
            'Force scroll animations even when OS reduced-motion is enabled (requires page refresh)'
          ),
        ],
      },
    ],
  },
  {
    id: 'translation',
    label: 'pane.translation',
    sections: [
      {
        title: 'translation.interface',
        fields: [
          sel(
            'translation.language',
            'language',
            [
              ['auto', 'Auto (Browser)'],
              ['en', 'English'],
              ['ko', '한국어'],
              ['ja', '日本語'],
              ['es', 'Español'],
              ['zh-CN', '中文'],
              ['ar', 'العربية'],
            ],
            'translation.languageDesc'
          ),
        ],
      },
      {
        title: 'translation.chat',
        fields: [
          chk('translation.enable', 'translationEnabled', 'translation.enableDesc'),
          sel(
            'translation.service',
            'translationService',
            [['auto', 'Auto (Chrome built-in)']],
            'translation.serviceDesc'
          ),
          sel(
            'translation.source',
            'translationSource',
            [
              ['auto', 'Auto-detect'],
              ['en', 'English'],
              ['ko', '한국어'],
              ['ja', '日本語'],
              ['es', 'Español'],
              ['zh-CN', '中文'],
              ['ar', 'العربية'],
            ],
            "Language of the incoming chat messages. Auto-detect uses Chrome's built-in language detection."
          ),
          sel(
            'translation.target',
            'translationTarget',
            [
              ['auto', 'Auto (Browser)'],
              ['ko', '한국어'],
              ['en', 'English'],
              ['ja', '日本語'],
              ['es', 'Español'],
              ['zh-CN', '中文'],
              ['ar', 'العربية'],
            ],
            'translation.sourceDesc'
          ),
          sel(
            'translation.displayMode',
            'translationMode',
            [
              ['dual', 'Dual (original + translation)'],
              ['replace', 'Replace (translation only)'],
            ],
            'translation.displayModeDesc'
          ),
        ],
      },
    ],
  },
];
