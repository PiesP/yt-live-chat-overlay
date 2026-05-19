import type {
  CheckboxField,
  NumberField,
  PaneDef,
  SelectField,
  TextField,
} from '@core/settings-ui-types';

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
          num('Font Size (px)', 'fontSize'),
          num('Text Opacity', 'opacity'),
          num('Scroll Speed (px/s)', 'speedPxPerSec'),
          num(
            'Lane Gap (px)',
            'laneSpacing',
            'Vertical gap between comment rows (negative = overlap)'
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
        ],
      },
      {
        title: 'Text Outline',
        fields: [
          chk('Enabled', 'enabled', undefined, 'outline'),
          num('Width (px)', 'widthPx', undefined, 'outline'),
          num('Opacity', 'opacity', undefined, 'outline'),
        ],
      },
    ],
  },
  {
    id: 'colors',
    label: 'Colors',
    sections: [
      {
        title: '',
        fields: [
          num(
            'SuperChat Opacity (%)',
            'superChatOpacity',
            'Background opacity of Super Chat cards'
          ),
          chk(
            'Preserve User Colors',
            'preserveUserColor',
            "Use author's chosen text color from YouTube chat instead of overlay defaults"
          ),
        ],
      },
      { title: 'Author Colors & Visibility', fields: [] },
    ],
  },
  {
    id: 'advanced',
    label: 'Advanced',
    sections: [
      {
        title: 'Safe Zone',
        fields: [
          num('Top Clear Zone (%)', 'safeTop', 'Keep top N% of video free of comments'),
          num('Bottom Clear Zone (%)', 'safeBottom', 'Keep bottom N% of video free of comments'),
        ],
      },
      {
        title: 'Message Rate',
        fields: [
          chk(
            'Show Short Messages',
            'allowShortTextMessages',
            'Show messages shorter than Min Length'
          ),
          num('Min Length (chars)', 'minTextLength', 'Minimum character count'),
        ],
      },
      {
        title: 'Performance',
        fields: [
          num(
            'Max Visible',
            'maxConcurrentMessages',
            'Performance warning threshold for simultaneous comments'
          ),
          chk(
            'Anti-block (density guard)',
            'antiBlockEnabled',
            'Pause new comments when screen is too crowded (keeps ~15% visible area clear)'
          ),
          num(
            'Free ratio',
            'antiBlockFreeRatio',
            'Minimum fraction of lanes that must remain free (0.15 = 15%). Lower = denser'
          ),
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
          num(
            'Max backlog rate (msg/s)',
            'backlogMaxRate',
            'Maximum messages per second during backlog injection'
          ),
          num(
            'Backlog speed multiplier',
            'backlogSpeedMultiplier',
            'Speed multiplier for backlog message animations'
          ),
          num(
            'Recent minutes',
            'backlogRecentMinutes',
            'Show past chat from last N minutes (only for Recent mode)'
          ),
          chk(
            'Show backlog loading indicator',
            'showBacklogIndicator',
            'Show loading indicator during backlog injection'
          ),
        ],
      },
      {
        title: 'Rate Limiting',
        fields: [
          chk(
            'Enable author rate limiting',
            'authorRateLimitEnabled',
            'Limit messages per author per time window'
          ),
          num(
            'Window (ms)',
            'authorRateLimitWindowMs',
            'Time window for rate limiting in milliseconds'
          ),
          num(
            'Max per window',
            'authorRateLimitMaxMessages',
            'Maximum messages per author per window'
          ),
        ],
      },
      {
        title: 'Debug',
        fields: [
          sel('Log Level', 'logLevel', [
            ['warn', 'Warn'],
            ['info', 'Info'],
            ['debug', 'Debug'],
          ]),
          chk('Show debug overlay', 'showDebugOverlay', 'Display real-time metrics overlay'),
        ],
      },
    ],
  },
];
