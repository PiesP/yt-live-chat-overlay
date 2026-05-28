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
      { title: '', fields: [{ type: 'enabled' }] },
      {
        title: '',
        fields: [
          sel('Danmaku Mode', 'danmakuMode', [
            ['scroll', 'Scroll (RTL)'],
            ['reverse', 'Reverse (LTR)'],
            ['top', 'Top Fixed'],
            ['bottom', 'Bottom Fixed'],
          ]),
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
          range('Text Opacity (%)', 'opacity'),
          num(
            'Lane Gap (px)',
            'laneSpacing',
            'Vertical gap between comment rows (negative = overlap)'
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
            'Preserve User Colors',
            'preserveUserColor',
            "Use author's chosen text color from YouTube chat instead of overlay defaults"
          ),
        ],
      },
      {
        title: 'Text Outline',
        fields: [
          chk('Enabled', 'enabled', undefined, 'outline'),
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
        title: 'Safe Zone',
        fields: [
          range('Top Clear Zone (%)', 'safeTop', 'Keep top N% of video free of comments'),
          range('Bottom Clear Zone (%)', 'safeBottom', 'Keep bottom N% of video free of comments'),
        ],
      },
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
          sel('Backlog Mode', 'backlogMode', [
            ['playback', 'Playback-based (recommended)'],
            ['recent', 'Recent only'],
            ['full', 'Full (show all)'],
            ['none', 'None (skip backlog)'],
          ]),
          range(
            'Backlog Opacity (%)',
            'backlogOpacityMultiplier',
            'Opacity of past messages relative to real-time messages'
          ),
          num(
            'Max Rate (msg/s)',
            'backlogMaxRate',
            'Maximum backlog message injection rate per second (0-50)'
          ),
          num(
            'Speed Multiplier',
            'backlogSpeedMultiplier',
            'Animation speed multiplier for backlog messages (1-5)'
          ),
          num(
            'Window (min)',
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
            'Max Messages',
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
        title: '',
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
          sel('Display Mode', 'translationMode', [
            ['dual', 'Dual (original + translation)'],
            ['replace', 'Replace (translation only)'],
          ]),
        ],
      },
    ],
  },
];
