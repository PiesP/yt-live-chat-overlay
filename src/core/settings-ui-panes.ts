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
}
interface EnabledField {
  type: 'enabled';
  title?: string;
}
export interface AuthorGridField {
  type: 'author-grid';
}
export interface RangeField extends BaseField {
  type: 'range';
}

export type FieldDef =
  | NumberField
  | CheckboxField
  | SelectField
  | TextField
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
const txt = (label: string, key: string, title?: string, placeholder?: string): TextField => ({
  type: 'text' as const,
  label,
  key,
  ...(title !== undefined ? { title } : {}),
  ...(placeholder !== undefined ? { placeholder } : {}),
});
const range = (label: string, key: string, title?: string, modifier?: string): RangeField => ({
  type: 'range' as const,
  label,
  key,
  ...(title !== undefined ? { title } : {}),
  ...(modifier !== undefined ? { modifier } : {}),
});

// ── Declarative field schemas ────────────────────────────────────────────────

export const PANES: PaneDef[] = [
  {
    id: 'comments',
    label: 'Comments',
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
            'Danmaku Mode',
            'danmakuMode',
            [
              ['scroll', 'Scroll (RTL)'],
              ['reverse', 'Reverse (LTR)'],
              ['top', 'Top Fixed'],
              ['bottom', 'Bottom Fixed'],
            ],
            'Comment display direction and behavior'
          ),
          num('Font Size (px)', 'fontSize', 'Text size in pixels (14-50)'),
          num(
            'Scroll Speed (px/s)',
            'speedPxPerSec',
            'How fast comments scroll across the screen in pixels per second'
          ),
          sel(
            'Font Weight',
            'fontWeight',
            [
              ['bold', 'Bold (700)'],
              ['normal', 'Normal (400)'],
            ],
            'Text weight: Bold is more readable, Normal uses less GPU memory'
          ),
          txt(
            'Font Family',
            'fontFamily',
            'CSS font-family value, e.g. "Noto Sans KR", sans-serif. Falls back to system default if not found.'
          ),
          range('Text Opacity (%)', 'opacity', 'Overall opacity of comment text (50-100%)'),
          num(
            'Lane Gap (px)',
            'laneSpacing',
            'Vertical gap between comment rows (negative = overlap)'
          ),
          num(
            'Exit Padding (px)',
            'exitPaddingPx',
            'Extra pixels a message scrolls past the screen edge before being removed (20-400, default 100)'
          ),
        ],
      },
      {
        title: 'Moderator and Owner',
        fields: [
          num(
            'Duration Multiplier (×)',
            'modOwnerDurationMultiplier',
            'How much longer moderator and owner messages stay visible (1.0 = same as regular, 2.0 = twice as long)'
          ),
        ],
      },
      {
        title: 'Timing',
        fields: [
          num(
            'Min Scroll Duration (ms)',
            'scrollDurationMinMs',
            'Minimum scroll animation duration — prevents very short messages from zipping across (1000-15000ms, default 5000)'
          ),
          num(
            'Max Scroll Duration (ms)',
            'scrollDurationMaxMs',
            'Maximum scroll animation duration — prevents very long messages from crawling (5-120s, default 30000ms)'
          ),
          num(
            'Top/Bottom Duration (ms)',
            'topBottomDurationMs',
            'Fixed display duration for top/bottom mode messages (1000-30000ms, default 4000)'
          ),
        ],
      },
      {
        title: 'Safe Zone',
        fields: [
          range('Top Clear Zone (%)', 'safeTop', 'Keep top N% of video free of comments'),
          range('Bottom Clear Zone (%)', 'safeBottom', 'Keep bottom N% of video free of comments'),
        ],
      },
    ],
  },
  {
    id: 'colors',
    label: 'Cards & Colors',
    sections: [
      {
        title: '',
        fields: [
          range(
            'SuperChat Opacity (%)',
            'superChatOpacity',
            'Background opacity of Super Chat cards'
          ),
          num(
            'SuperChat Max Lines',
            'superChatMaxBodyLines',
            'Max body text lines before truncation (2-10)'
          ),
          num(
            'Membership Max Lines',
            'membershipMaxBodyLines',
            'Max body text lines for membership messages (1-5)'
          ),
          chk(
            'Show SuperChat Amount',
            'showSuperChatAmount',
            'Display the purchase amount badge on Super Chat cards'
          ),
          chk(
            'Preserve User Colors',
            'preserveUserColor',
            "Use author's chosen text color from YouTube chat instead of overlay defaults"
          ),
        ],
      },
      {
        title: 'Text Outline',
        fields: [
          chk(
            'Enabled',
            'enabled',
            'Add a dark outline stroke around text for better readability',
            'outline'
          ),
          num(
            'Outline Width (px)',
            'widthPx',
            'Text outline stroke width in pixels (0-8)',
            'outline'
          ),
          range(
            'Outline Opacity (%)',
            'opacity',
            'Text outline stroke opacity (0-100%)',
            'outline'
          ),
        ],
      },
      { title: 'Author Colors & Visibility', fields: [{ type: 'author-grid' as const }] },
    ],
  },
  {
    id: 'advanced',
    label: 'Advanced',
    sections: [
      {
        title: 'Message Rate',
        fields: [
          chk(
            'Ignore Min Length',
            'allowShortTextMessages',
            'Show all messages regardless of minimum character length'
          ),
          num('Min Length (chars)', 'minTextLength', 'Minimum character count'),
        ],
      },
      {
        title: 'Backlog',
        fields: [
          sel(
            'Backlog Mode',
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
            'Backlog Opacity (%)',
            'backlogOpacityMultiplier',
            'Opacity of past messages relative to real-time messages'
          ),
          num(
            'Max Injection Rate (msg/s)',
            'backlogMaxRate',
            'Maximum backlog message injection rate per second (0-50)'
          ),
          num(
            'Backlog Speed (×)',
            'backlogSpeedMultiplier',
            'Animation speed multiplier for backlog messages (1-5)'
          ),
          num(
            'Recent Window (min)',
            'backlogRecentMinutes',
            'Time window in minutes for recent-only backlog mode (1-30)'
          ),
        ],
      },
      {
        title: 'Depth Layers',
        fields: [
          chk(
            'Enabled',
            'depthLayersEnabled',
            'Speed-based depth perception: fast messages appear near, slow messages appear far'
          ),
          range('Near Speed (%)', 'depthNearSpeedMul', 'Speed boost for near-layer messages'),
          range('Far Speed (%)', 'depthFarSpeedMul', 'Speed reduction for far-layer messages'),
          range('Far Opacity (%)', 'depthFarOpacityMul', 'Opacity dimming for far-layer messages'),
        ],
      },
      {
        title: 'Rate Limiting',
        fields: [
          sel(
            'Author Rate Limit',
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
        title: 'Performance',
        fields: [
          num(
            'Max Concurrent Messages',
            'maxConcurrentMessages',
            'Maximum number of messages visible on screen at once (30-300)'
          ),
          num(
            'Fade Duration (ms)',
            'fadeDurationMs',
            'How long messages take to fade out (0 = instant, 50-1000)'
          ),
          num(
            'Min Poll Interval (ms)',
            'minPollIntervalMs',
            'Minimum chat polling interval in milliseconds (50-5000)'
          ),
          num(
            'Max Poll Interval (ms)',
            'maxPollIntervalMs',
            'Maximum chat polling interval in milliseconds (1000-30000)'
          ),
          num(
            'Max Queue Depth',
            'queueMaxSize',
            'Maximum pending queue depth before messages are dropped (50-1000, default 200)'
          ),
          num(
            'Tab Trim Target',
            'backgroundQueueMax',
            'Target active message count when trimming background tab (10-500, default 50)'
          ),
          num(
            'Max Message Age (ms)',
            'maxMessageAgeMs',
            'Maximum message age before fade-out removal (10-300s, default 60000ms)'
          ),
          range(
            'Message Spacing (%)',
            'headwayGapRatio',
            'Gap between consecutive messages as percentage of message width (2-30%, default 8)'
          ),
          num(
            'Emoji Cache (MB)',
            'emojiCacheMb',
            'Max memory for emoji image cache (1-20 MB, default 3)'
          ),
          num(
            'Photo Cache (MB)',
            'photoCacheMb',
            'Max memory for author photo cache (1-20 MB, default 2)'
          ),
          num(
            'Sticker Cache (MB)',
            'stickerCacheMb',
            'Max memory for sticker image cache (1-20 MB, default 1)'
          ),
          num(
            'Text Cache (MB)',
            'textCacheMb',
            'Max memory for text bitmap cache (1-20 MB, default 4)'
          ),
          num(
            'Translation Batch Size',
            'translationBatchSize',
            'Max translations applied per frame to avoid spikes (1-20, default 5)'
          ),
          num(
            'Emoji Fetch Limit',
            'emojiFetchLimit',
            'Max concurrent emoji fetch operations (1-20, default 6)'
          ),
          num(
            'Failed Emoji Retry (min)',
            'failedEmojiRetryMins',
            'How long to wait before retrying failed emoji fetches (1-60 min, default 5)'
          ),
        ],
      },
      {
        title: 'Thresholds',
        fields: [
          num('Burst Sample Window', 'burstSampleWindow', 'Burst rate sample window size'),
          num(
            'Elevated Burst (msg/s)',
            'burstElevatedThreshold',
            'Messages per second threshold for elevated burst level'
          ),
          num(
            'High Burst (msg/s)',
            'burstHighThreshold',
            'Messages per second threshold for high burst level'
          ),
          num(
            'Extreme Burst (msg/s)',
            'burstExtremeThreshold',
            'Messages per second threshold for extreme burst level'
          ),
          num('Backlog Injection Max', 'backlogInjectionMax', 'Maximum backlog injection rate cap'),
          num(
            'Backlog Density Ramp (ms)',
            'backlogDensityRampMs',
            'Density ramp duration for backlog injection in milliseconds'
          ),
          num(
            'Live Poll Fallback (ms)',
            'livePollFallbackMs',
            'Live poll fallback delay in milliseconds'
          ),
          num(
            'Poll Failure Limit',
            'livePollFailureLimit',
            'Consecutive poll failures before circuit breaker trips'
          ),
          num(
            'Speed Boost Threshold',
            'speedBoostThreshold',
            'Pending messages to trigger speed boost'
          ),
          num(
            'Backlog Pause (%)',
            'backlogPauseThreshold',
            'Lane utilization ratio to pause backlog injection'
          ),
          num(
            'Backlog Resume (%)',
            'backlogResumeThreshold',
            'Lane utilization ratio to resume backlog injection'
          ),
          num(
            'Activity Timeout (ms)',
            'activityTimeoutMs',
            'Chat activity timeout in milliseconds'
          ),
          num(
            'Stagger Max Delay (ms)',
            'staggerMaxDelayMs',
            'Max stagger delay for messages in same batch'
          ),
          num(
            'Stagger Medium Delay (ms)',
            'staggerMediumDelayMs',
            'Medium stagger delay when queue depth is medium'
          ),
          num(
            'Emoji Fetch Timeout (ms)',
            'emojiFetchTimeoutMs',
            'Timeout for emoji fetch operations'
          ),
          num(
            'Backlog Density Ramp Max (ms)',
            'backlogDensityRampMaxMs',
            'Max density ramp duration for backlog injection'
          ),
          num(
            'Backlog Injection Rate Min',
            'backlogInjectionRateMin',
            'Minimum backlog injection rate (msg/s)'
          ),
          num('Speed Boost Max', 'speedBoostMax', 'Max speed boost factor for burst compensation'),
          num(
            'Speed Boost Denominator',
            'speedBoostDenom',
            'Speed boost denominator for EMA rate scaling'
          ),
          num(
            'Backlog Toggle Cooldown (ms)',
            'backlogToggleCooldownMs',
            'Cooldown between backlog pause toggles'
          ),
          num(
            'Replay Prefetch Pages',
            'replayPrefetchPages',
            'Max pages to prefetch in replay mode'
          ),
          num(
            'Replay Batch Limit',
            'replayBatchLimit',
            'Max batches to fetch in replay initialization'
          ),
        ],
      },
      {
        title: 'Developer',
        fields: [
          sel(
            'Log Level',
            'logLevel',
            [
              ['warn', 'Warnings only'],
              ['info', 'Info'],
              ['debug', 'Debug (verbose)'],
            ],
            'Console diagnostic output verbosity'
          ),
          chk(
            'Debug Overlay',
            'showDebugOverlay',
            'Show performance debug overlay on the video player'
          ),
        ],
      },
    ],
  },
  {
    id: 'translation',
    label: 'Translation',
    sections: [
      {
        title: 'Interface',
        fields: [
          sel(
            'Language',
            'language',
            [
              ['auto', 'Auto (Browser)'],
              ['en', 'English'],
              ['ko', '한국어'],
              ['ja', '日本語'],
              ['es', 'Español'],
              ['zh', '中文'],
            ],
            'Sets the overlay user interface language (does not filter comments by language)'
          ),
        ],
      },
      {
        title: 'Chat Translation',
        fields: [
          chk(
            'Enable Translation',
            'translationEnabled',
            'Translate chat messages in real-time (requires Chrome 138+ for built-in translation)'
          ),
          sel('Service', 'translationService', [['auto', 'Auto (Chrome built-in)']]),
          sel(
            'Source Language',
            'translationSource',
            [
              ['en', 'English'],
              ['ko', '한국어'],
              ['ja', '日本語'],
              ['es', 'Español'],
              ['zh', '中文'],
            ],
            'Language of the incoming chat messages'
          ),
          sel(
            'Target Language',
            'translationTarget',
            [
              ['ko', '한국어'],
              ['en', 'English'],
              ['ja', '日本語'],
              ['es', 'Español'],
              ['zh', '中文'],
            ],
            'Language to translate chat messages into'
          ),
          sel(
            'Display Mode',
            'translationMode',
            [
              ['dual', 'Dual (original + translation)'],
              ['replace', 'Replace (translation only)'],
            ],
            'Dual shows original above translation, Replace shows translation only'
          ),
        ],
      },
    ],
  },
];
