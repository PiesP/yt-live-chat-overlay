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
            title: 'app.enabledDesc',
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
              ['scroll', 'danmaku.scroll'],
              ['reverse', 'danmaku.reverse'],
              ['top', 'danmaku.top'],
              ['bottom', 'danmaku.bottom'],
            ],
            'danmaku.modeDesc'
          ),
          num('danmaku.scrollSpeed', 'speedPxPerSec', 'danmaku.scrollSpeedDesc'),
          range('danmaku.textOpacity', 'opacity', 'danmaku.textOpacityDesc'),
          range('danmaku.laneGap', 'laneSpacing', 'danmaku.laneGapDesc'),
          num('danmaku.exitPadding', 'exitPaddingPx', 'danmaku.exitPaddingDesc'),
          num('danmaku.durationMul', 'modOwnerDurationMultiplier', 'danmaku.durationMulDesc'),
        ],
      },
      {
        title: 'danmaku.timing',
        fields: [
          num('danmaku.minScrollDuration', 'scrollDurationMinMs', 'danmaku.minScrollDurationDesc'),
          num('danmaku.maxScrollDuration', 'scrollDurationMaxMs', 'danmaku.maxScrollDurationDesc'),
          num('danmaku.topBottomDuration', 'topBottomDurationMs', 'danmaku.topBottomDurationDesc'),
        ],
      },
      {
        title: 'danmaku.safeZone',
        fields: [
          range('danmaku.topClearZone', 'safeTop', 'danmaku.topClearZoneDesc'),
          range('danmaku.bottomClearZone', 'safeBottom', 'danmaku.bottomClearZoneDesc'),
        ],
      },
      {
        title: 'danmaku.font',
        fields: [
          fontPreview(),
          num('danmaku.fontSize', 'fontSize', 'danmaku.fontSizeDesc'),
          weightToggle(
            'Weight',
            'fontWeight',
            [
              ['bold', 'Bold'],
              ['normal', 'Regular'],
            ],
            'danmaku.fontWeightDesc'
          ),
          fontChips('Family', 'fontFamily', FONT_SUGGESTIONS, 'danmaku.fontFamilyDesc'),
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
            'appearance.superchatOpacityDesc'
          ),
          num(
            'appearance.superchatMaxLines',
            'superChatMaxBodyLines',
            'appearance.superchatMaxLinesDesc'
          ),
          num(
            'appearance.membershipMaxLines',
            'membershipMaxBodyLines',
            'appearance.membershipMaxLinesDesc'
          ),
          chk(
            'appearance.showSuperchatAmount',
            'showSuperChatAmount',
            'appearance.showSuperchatAmountDesc'
          ),
          chk(
            'appearance.preserveUserColors',
            'preserveUserColor',
            "Use author's chosen text color from YouTube chat instead of overlay defaults"
          ),
        ],
      },
      {
        title: 'appearance.outline',
        fields: [
          chk('appearance.outlineEnabled', 'enabled', 'appearance.outlineEnabledDesc', 'outline'),
          num('appearance.outlineWidth', 'widthPx', 'appearance.outlineWidthDesc', 'outline'),
          range('appearance.outlineOpacity', 'opacity', 'appearance.outlineOpacityDesc', 'outline'),
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
          chk('advanced.ignoreMinLength', 'allowShortTextMessages', 'advanced.ignoreMinLengthDesc'),
          num('advanced.minLength', 'minTextLength', 'advanced.minLengthDesc'),
          sel(
            'advanced.authorRateLimit',
            'authorRateLimit',
            [
              ['off', 'advanced.authorRateLimitOff'],
              ['normal', 'advanced.authorRateLimitNormal'],
              ['strict', 'advanced.authorRateLimitStrict'],
            ],
            'advanced.authorRateLimitDesc'
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
              ['playback', 'advanced.backlogPlayback'],
              ['recent', 'advanced.backlogRecent'],
              ['full', 'advanced.backlogFull'],
              ['none', 'advanced.backlogNone'],
            ],
            'advanced.backlogModeDesc'
          ),
          range(
            'advanced.backlogOpacity',
            'backlogOpacityMultiplier',
            'advanced.backlogOpacityDesc'
          ),
          num(
            'advanced.backlogInjectionRate',
            'backlogMaxRate',
            'advanced.backlogInjectionRateDesc'
          ),
          num('advanced.backlogSpeed', 'backlogSpeedMultiplier', 'advanced.backlogSpeedDesc'),
          num(
            'advanced.backlogRecentWindow',
            'backlogRecentMinutes',
            'advanced.backlogRecentWindowDesc'
          ),
        ],
      },
      {
        title: 'advanced.depthLayers',
        fields: [
          chk('appearance.outlineEnabled', 'depthLayersEnabled', 'advanced.depthLayersDesc'),
          range('advanced.depthNearSpeed', 'depthNearSpeedMul', 'advanced.depthNearSpeedDesc'),
          range('advanced.depthFarSpeed', 'depthFarSpeedMul', 'advanced.depthFarSpeedDesc'),
          range('advanced.depthFarOpacity', 'depthFarOpacityMul', 'advanced.depthFarOpacityDesc'),
        ],
      },
      {
        title: 'advanced.performance',
        fields: [
          num('advanced.maxConcurrent', 'maxConcurrentMessages', 'advanced.maxConcurrentDesc'),
          num('advanced.fadeDuration', 'fadeDurationMs', 'advanced.fadeDurationDesc'),
          num('advanced.minPollInterval', 'minPollIntervalMs', 'advanced.minPollIntervalDesc'),
          num('advanced.maxPollInterval', 'maxPollIntervalMs', 'advanced.maxPollIntervalDesc'),
          num('advanced.maxQueueDepth', 'queueMaxSize', 'advanced.maxQueueDepthDesc'),
          num('advanced.tabTrimTarget', 'backgroundQueueMax', 'advanced.tabTrimTargetDesc'),
          num('advanced.maxMessageAge', 'maxMessageAgeMs', 'advanced.maxMessageAgeDesc'),
          range('danmaku.messageSpacing', 'headwayGapRatio', 'danmaku.messageSpacingDesc'),
          num(
            'advanced.translationBatchSize',
            'translationBatchSize',
            'advanced.translationBatchSizeDesc'
          ),
        ],
      },
      {
        title: 'advanced.cache',
        fields: [
          num('advanced.emojiCache', 'emojiCacheMb', 'advanced.emojiCacheDesc'),
          num('advanced.photoCache', 'photoCacheMb', 'advanced.photoCacheDesc'),
          num('advanced.stickerCache', 'stickerCacheMb', 'advanced.stickerCacheDesc'),
          num('advanced.textCache', 'textCacheMb', 'advanced.textCacheDesc'),
          num('advanced.emojiFetchLimit', 'emojiFetchLimit', 'advanced.emojiFetchLimitDesc'),
          num('advanced.emojiRetryMin', 'failedEmojiRetryMins', 'advanced.emojiRetryMinDesc'),
        ],
      },
      {
        title: 'advanced.burst',
        fields: [
          num('advanced.burstSampleWindow', 'burstSampleWindow', 'advanced.burstSampleWindowDesc'),
          num('advanced.burstElevated', 'burstElevatedThreshold', 'advanced.burstElevatedDesc'),
          num('advanced.burstHigh', 'burstHighThreshold', 'advanced.burstHighDesc'),
          num('advanced.burstExtreme', 'burstExtremeThreshold', 'advanced.burstExtremeDesc'),
        ],
      },
      {
        title: 'advanced.tuning',
        fields: [
          num(
            'advanced.tuningBacklogInjectionMax',
            'backlogInjectionMax',
            'advanced.tuningBacklogInjectionMaxDesc'
          ),
          num(
            'advanced.tuningDensityRamp',
            'backlogDensityRampMs',
            'advanced.tuningDensityRampDesc'
          ),
          num(
            'advanced.tuningPollFallback',
            'livePollFallbackMs',
            'advanced.tuningPollFallbackDesc'
          ),
          num(
            'advanced.tuningPollFailureLimit',
            'livePollFailureLimit',
            'advanced.tuningPollFailureLimitDesc'
          ),
          num(
            'advanced.tuningSpeedBoostThreshold',
            'speedBoostThreshold',
            'advanced.tuningSpeedBoostThresholdDesc'
          ),
          range(
            'advanced.tuningBacklogPause',
            'backlogPauseThreshold',
            'advanced.tuningBacklogPauseDesc'
          ),
          range(
            'advanced.tuningBacklogResume',
            'backlogResumeThreshold',
            'advanced.tuningBacklogResumeDesc'
          ),
          num(
            'advanced.tuningActivityTimeout',
            'activityTimeoutMs',
            'advanced.tuningActivityTimeoutDesc'
          ),
          num('advanced.tuningStaggerMax', 'staggerMaxDelayMs', 'advanced.tuningStaggerMaxDesc'),
          num(
            'advanced.tuningStaggerMedium',
            'staggerMediumDelayMs',
            'advanced.tuningStaggerMediumDesc'
          ),
          num(
            'advanced.tuningEmojiTimeout',
            'emojiFetchTimeoutMs',
            'advanced.tuningEmojiTimeoutDesc'
          ),
          num(
            'advanced.tuningDensityRampMax',
            'backlogDensityRampMaxMs',
            'advanced.tuningDensityRampMaxDesc'
          ),
          num(
            'advanced.tuningInjectionRateMin',
            'backlogInjectionRateMin',
            'advanced.tuningInjectionRateMinDesc'
          ),
          num('advanced.tuningSpeedBoostMax', 'speedBoostMax', 'advanced.tuningSpeedBoostMaxDesc'),
          num(
            'advanced.tuningSpeedBoostDenom',
            'speedBoostDenom',
            'advanced.tuningSpeedBoostDenomDesc'
          ),
          num(
            'advanced.tuningToggleCooldown',
            'backlogToggleCooldownMs',
            'advanced.tuningToggleCooldownDesc'
          ),
          num(
            'advanced.replayPrefetchPages',
            'replayPrefetchPages',
            'advanced.replayPrefetchPagesDesc'
          ),
          num('advanced.replayBatchLimit', 'replayBatchLimit', 'advanced.replayBatchLimitDesc'),
        ],
      },
      {
        title: 'advanced.developer',
        fields: [
          sel(
            'advanced.logLevel',
            'logLevel',
            [
              ['warn', 'advanced.logLevelWarn'],
              ['info', 'advanced.logLevelInfo'],
              ['debug', 'advanced.logLevelDebug'],
            ],
            'advanced.logLevelDesc'
          ),
          chk('advanced.debugOverlay', 'showDebugOverlay', 'advanced.debugOverlayDesc'),
          chk(
            'advanced.ignoreReducedMotion',
            'ignoreReducedMotion',
            'advanced.ignoreReducedMotionDesc'
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
              ['auto', 'translation.languageAuto'],
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
            [['auto', 'translation.serviceAuto']],
            'translation.serviceDesc'
          ),
          sel(
            'translation.source',
            'translationSource',
            [
              ['auto', 'translation.sourceAuto'],
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
              ['auto', 'translation.languageAuto'],
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
              ['dual', 'translation.displayModeDual'],
              ['replace', 'translation.displayModeReplace'],
            ],
            'translation.displayModeDesc'
          ),
        ],
      },
    ],
  },
];
