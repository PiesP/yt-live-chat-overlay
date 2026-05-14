import type { OverlaySettings } from '@app-types';
import {
  AUTHOR_COLOR_KEYS,
  cloneSettings,
  OUTLINE_LIMITS_MAP,
  type OutlineSettingKey,
  type RootNumericSettingKey,
  type RootScalarSettingKey,
  SETTINGS_LIMITS,
} from '@core/settings-schema';

// ── Constants ────────────────────────────────────────────────────────────────

const STYLE_ID = 'yt-chat-overlay-settings-style';
export const BUTTON_ID = 'yt-chat-overlay-settings-button';
export const BACKDROP_ID = 'yt-chat-overlay-settings-backdrop';
export { STYLE_ID };

const TITLE_ID = 'yt-chat-overlay-settings-title';

const ROOT_ROUNDED_KEYS = new Set<RootScalarSettingKey>([
  'maxConcurrentMessages',
  'minTextLength',
  'laneSpacing',
  'authorRateLimitMaxMessages',
]);

const ROOT_NUMERIC_OPTIONS: Partial<
  Record<RootScalarSettingKey, { scale?: number; precision?: number }>
> = {
  superChatOpacity: { scale: 100, precision: 0 },
  safeTop: { scale: 100, precision: 1 },
  safeBottom: { scale: 100, precision: 1 },
};

// ── Schema-driven field helpers ──────────────────────────────────────────────

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
interface ColorField {
  type: 'color';
  label: string;
  key: string;
}
interface EnabledField {
  type: 'enabled';
}

type FieldDef = NumberField | CheckboxField | SelectField | ColorField | EnabledField;

interface SectionDef {
  title: string;
  fields: FieldDef[];
}

interface PaneDef {
  id: string;
  label: string;
  sections: SectionDef[];
}

// Shorthand constructors to reduce PANES boilerplate
const num = (label: string, key: string, title?: string, modifier?: string): NumberField => ({
  type: 'number' as const,
  label,
  key,
  ...(title !== undefined ? { title } : {}),
  ...(modifier !== undefined ? { modifier } : {}),
});
const chk = (label: string, key: string, title?: string, modifier?: string): CheckboxField => ({
  type: 'checkbox' as const,
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

// ── Declarative field schemas ────────────────────────────────────────────────

const PANES: PaneDef[] = [
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
          num('Lane Gap (px)', 'laneSpacing', 'Extra vertical gap between comment rows'),
        ],
      },
      {
        title: 'Text Outline',
        fields: [
          chk('Enabled', 'enabled', undefined, 'outline'),
          num('Width (px)', 'widthPx', undefined, 'outline'),
          num('Blur (px)', 'blurPx', undefined, 'outline'),
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
        ],
      },
      {
        title: 'Renderer',
        fields: [
          sel('Renderer', 'rendererType', [
            ['css', 'CSS (DOM animations)'],
            ['canvas', 'Canvas2D (rAF, stable)'],
          ]),
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

// ── UI value formatting ──────────────────────────────────────────────────────

const scaleUiValue = (value: number, scale: number): number =>
  Math.round(value * scale * 1e4) / 1e4;

const getRootScale = (key: RootScalarSettingKey): number => ROOT_NUMERIC_OPTIONS[key]?.scale ?? 1;

const normalizeNumericValue = (
  value: unknown,
  fallback: number,
  limits: Readonly<{ min: number; max: number }>,
  rounded: boolean,
  scale = 1
): number => {
  const scaledValue = typeof value === 'number' ? value / scale : Number(value) / scale;
  const numericValue = Number.isFinite(scaledValue) ? scaledValue : fallback;
  const clamped = Math.min(limits.max, Math.max(limits.min, numericValue));
  return rounded ? Math.round(clamped) : clamped;
};

const formatRootNumericSettingForInput = (
  key: RootScalarSettingKey,
  value: number
): string | number => {
  const options = ROOT_NUMERIC_OPTIONS[key];
  const scaledValue = scaleUiValue(value, options?.scale ?? 1);
  return options?.precision === undefined ? scaledValue : scaledValue.toFixed(options.precision);
};

const normalizeRootNumericInputValue = (
  key: RootNumericSettingKey,
  value: unknown,
  fallback: number
): number => {
  const limits = SETTINGS_LIMITS[key as keyof typeof SETTINGS_LIMITS];
  if (!limits) return fallback;
  return normalizeNumericValue(
    value,
    fallback,
    limits,
    ROOT_ROUNDED_KEYS.has(key),
    getRootScale(key)
  );
};

const normalizeOutlineNumericInputValue = (
  key: Exclude<OutlineSettingKey, 'enabled'>,
  value: unknown,
  fallback: number
): number => {
  const limitsKey = OUTLINE_LIMITS_MAP[key];
  return normalizeNumericValue(value, fallback, SETTINGS_LIMITS[limitsKey], false);
};

const getNumericInputAttributes = (
  key: RootScalarSettingKey | Exclude<OutlineSettingKey, 'enabled'>
): Readonly<{ min: number; max: number; step: number }> => {
  const limitsKey =
    key in SETTINGS_LIMITS
      ? (key as keyof typeof SETTINGS_LIMITS)
      : OUTLINE_LIMITS_MAP[key as Exclude<OutlineSettingKey, 'enabled'>];
  const limits = SETTINGS_LIMITS[limitsKey];
  const scale = getRootScale(key as RootScalarSettingKey);
  return {
    min: scaleUiValue(limits.min, scale),
    max: scaleUiValue(limits.max, scale),
    step: scaleUiValue(limits.step, scale),
  };
};

const applyNumberInputAttributes = (
  input: HTMLInputElement,
  key: RootScalarSettingKey | Exclude<OutlineSettingKey, 'enabled'>
): void => {
  const { min, max, step } = getNumericInputAttributes(key);
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
};

// ── SettingsUiForm class ─────────────────────────────────────────────────────

export class SettingsUiForm {
  private modal: HTMLDivElement | null = null;
  private isUpdating = false;

  constructor(
    private readonly getSettings: () => Readonly<OverlaySettings>,
    private readonly onPreview?: (settings: OverlaySettings) => void
  ) {}

  setModal(modal: HTMLDivElement | null): void {
    this.modal = modal;
  }

  private attachLivePreview(element: HTMLElement): void {
    if (!this.onPreview) return;
    const handler = (): void => {
      if (this.isUpdating) return;
      this.onPreview?.(this.collectSettings());
    };
    const inputs = element.querySelectorAll<HTMLElement>('input, select');
    for (const input of inputs) {
      if (input instanceof HTMLInputElement && input.type === 'number') {
        input.addEventListener('input', handler);
      } else {
        input.addEventListener('change', handler);
      }
    }
  }

  // ── Modal content factory ──────────────────────────────────────────────

  createModalContent(): Node[] {
    const panes = PANES.map((pane) => this.buildPane(pane));
    for (const pane of panes) {
      this.attachLivePreview(pane);
    }
    return [this.createHeader(), this.createTabs(), ...panes, this.createActions()];
  }

  private buildPane(def: PaneDef): HTMLDivElement {
    const pane = this.div('yt-chat-overlay-settings-pane');
    pane.id = `pane-${def.id}`;
    pane.dataset.pane = def.id;
    pane.setAttribute('role', 'tabpanel');
    if (def.id !== 'comments') pane.hidden = true;

    for (const section of def.sections) {
      if (section.title === 'Author Colors & Visibility') {
        pane.appendChild(this.buildAuthorGrid());
        continue;
      }
      if (section.fields.length === 0) continue;

      if (section.title) {
        const secEl = this.section(section.title);
        for (const field of section.fields) {
          secEl.appendChild(this.buildField(field));
        }
        pane.appendChild(secEl);
      } else {
        for (const field of section.fields) {
          const el = this.buildField(field);
          if (field.type === 'enabled') el.classList.add('yt-chat-overlay-settings-enabled');
          pane.appendChild(el);
        }
      }
    }
    return pane;
  }

  private buildField(def: FieldDef): HTMLElement {
    switch (def.type) {
      case 'enabled':
        return this.createEnabledField();
      case 'checkbox':
        return this.createCheckboxField(def.label, def.key, def.title);
      case 'number': {
        const input = this.input({ type: 'number', name: this.resolveKey(def) });
        applyNumberInputAttributes(
          input,
          def.key as RootScalarSettingKey | Exclude<OutlineSettingKey, 'enabled'>
        );
        if (def.title) input.title = def.title;
        return this.field(def.label, input);
      }
      case 'select': {
        const select = document.createElement('select');
        select.name = def.key;
        if (def.title) select.title = def.title;
        for (const [value, label] of def.options) {
          const opt = document.createElement('option');
          opt.value = value;
          opt.textContent = label;
          select.appendChild(opt);
        }
        return this.field(def.label, select);
      }
      default:
        throw new Error('Unhandled field type');
    }
  }

  private resolveKey(def: { key: string; modifier?: string }): string {
    return def.modifier ? `${def.modifier}-${def.key}` : def.key;
  }

  private buildAuthorGrid(): HTMLDivElement {
    const section = this.section('Author Colors & Visibility');
    const grid = this.div('yt-chat-overlay-author-grid');
    grid.append(document.createElement('span'), this.gridHeader('Color'), this.gridHeader('Show'));

    for (const key of AUTHOR_COLOR_KEYS) {
      grid.append(
        this.gridLabel(key.charAt(0).toUpperCase() + key.slice(1)),
        this.input({
          type: 'color',
          name: `color-${key}`,
          className: 'yt-chat-overlay-author-grid-color',
        }),
        this.gridCheckbox(`showAuthor-${key}`)
      );
    }

    grid.append(
      this.gridLabel('SuperChat'),
      document.createElement('span'),
      this.gridCheckbox('showAuthor-superChat')
    );

    section.appendChild(grid);
    return section;
  }

  // ── DOM helpers ────────────────────────────────────────────────────────

  private div(className: string): HTMLDivElement {
    const el = document.createElement('div');
    el.className = className;
    return el;
  }

  private input(props: { type: string; name: string; className?: string }): HTMLInputElement {
    const el = document.createElement('input');
    el.type = props.type;
    el.name = props.name;
    if (props.className) el.className = props.className;
    return el;
  }

  private field(labelText: string, control: HTMLElement): HTMLLabelElement {
    const label = document.createElement('label');
    label.className = 'yt-chat-overlay-settings-field';
    const text = document.createElement('span');
    text.textContent = labelText;
    label.append(text, control);
    return label;
  }

  private section(titleText: string): HTMLDivElement {
    const sec = this.div('yt-chat-overlay-settings-section');
    const title = this.div('yt-chat-overlay-settings-section-title');
    title.textContent = titleText;
    sec.appendChild(title);
    return sec;
  }

  private gridCheckbox(name: string): HTMLInputElement {
    const el = this.input({ type: 'checkbox', name });
    el.className = 'yt-chat-overlay-author-grid-checkbox';
    return el;
  }

  private gridHeader(text: string): HTMLSpanElement {
    const el = document.createElement('span');
    el.className = 'yt-chat-overlay-author-grid-header';
    el.textContent = text;
    return el;
  }

  private gridLabel(text: string): HTMLSpanElement {
    const el = document.createElement('span');
    el.className = 'yt-chat-overlay-author-grid-label';
    el.textContent = text;
    return el;
  }

  private createHeader(): HTMLDivElement {
    const header = this.div('yt-chat-overlay-settings-header');
    const title = document.createElement('div');
    title.id = TITLE_ID;
    title.textContent = 'Chat Overlay';
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'yt-chat-overlay-settings-close';
    closeButton.setAttribute('aria-label', 'Close settings');
    closeButton.textContent = 'x';
    header.append(title, closeButton);
    return header;
  }

  private createTabs(): HTMLElement {
    const nav = document.createElement('nav');
    nav.className = 'yt-chat-overlay-settings-tabs';
    nav.setAttribute('role', 'tablist');
    nav.setAttribute('aria-label', 'Settings categories');

    for (const pane of PANES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'yt-chat-overlay-settings-tab';
      button.dataset.tab = pane.id;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(pane.id === 'comments'));
      button.setAttribute('aria-controls', `pane-${pane.id}`);
      button.textContent = pane.label;
      if (pane.id === 'comments') button.classList.add('active');
      nav.appendChild(button);
    }

    return nav;
  }

  private createActions(): HTMLDivElement {
    const actions = this.div('yt-chat-overlay-settings-actions');
    for (const [action, label] of [
      ['reset', 'Reset'],
      ['export', 'Export'],
      ['import', 'Import'],
      ['apply', 'Close'],
    ] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.action = action;
      button.textContent = label;
      actions.appendChild(button);
    }
    return actions;
  }

  private createEnabledField(): HTMLLabelElement {
    const label = document.createElement('label');
    label.className = 'yt-chat-overlay-settings-enabled';
    const text = document.createElement('span');
    text.textContent = 'Overlay Enabled';
    const input = this.input({ type: 'checkbox', name: 'enabled' });
    label.append(text, input);
    return label;
  }

  private createCheckboxField(labelText: string, name: string, title?: string): HTMLLabelElement {
    const input = this.input({ type: 'checkbox', name });
    if (title) input.title = title;
    return this.field(labelText, input);
  }

  // ── Form population (schema-driven) ────────────────────────────────────

  populateForm(settings: Readonly<OverlaySettings>): void {
    if (!this.modal) return;
    this.isUpdating = true;

    const els = this.modal.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select');
    for (const el of els) {
      if (!el.name) continue;

      // Outline fields
      if (el.name.startsWith('outline-')) {
        const key = el.name.slice(8) as keyof typeof settings.outline;
        const value = settings.outline[key];
        if (el instanceof HTMLInputElement && el.type === 'checkbox') {
          el.checked = Boolean(value);
        } else {
          el.value = formatRootNumericSettingForInput(
            key as unknown as RootScalarSettingKey,
            value as number
          ) as string;
        }
        continue;
      }

      // Color fields
      if (el.name.startsWith('color-')) {
        const key = el.name.slice(6) as keyof typeof settings.colors;
        el.value = settings.colors[key];
        continue;
      }

      // Author visibility fields
      if (el.name.startsWith('showAuthor-')) {
        const key = el.name.slice(11) as keyof typeof settings.showAuthor;
        if (el instanceof HTMLInputElement && el.type === 'checkbox') {
          el.checked = settings.showAuthor[key];
        }
        continue;
      }

      // Root scalar fields
      const scalarKey = el.name as RootScalarSettingKey;
      const value = settings[scalarKey];
      if (el instanceof HTMLInputElement && el.type === 'checkbox') {
        el.checked = Boolean(value);
      } else {
        el.value =
          typeof value === 'number'
            ? String(formatRootNumericSettingForInput(scalarKey, value))
            : String(value);
      }
    }

    this.syncMinTextLengthState();
    this.isUpdating = false;
  }

  syncMinTextLengthState(): void {
    if (!this.modal) return;
    const allowShort = this.modal.querySelector<HTMLInputElement>(
      'input[name="allowShortTextMessages"]'
    );
    const minText = this.modal.querySelector<HTMLInputElement>('input[name="minTextLength"]');
    if (allowShort && minText) {
      minText.disabled = allowShort.checked;
    }
  }

  // ── Form collection (schema-driven) ────────────────────────────────────

  collectSettings(): OverlaySettings {
    const partial: Record<string, unknown> = {};
    if (!this.modal) return cloneSettings(this.getSettings());

    const els = this.modal.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select');
    for (const el of els) {
      if (!el.name) continue;

      if (el.name.startsWith('outline-')) {
        const key = el.name.slice(8) as Exclude<OutlineSettingKey, 'enabled'>;
        if (el instanceof HTMLInputElement && el.type === 'checkbox') {
          partial.outline = {
            ...((partial.outline as Record<string, unknown>) ?? {}),
            [key]: el.checked,
          };
        } else {
          partial.outline = {
            ...((partial.outline as Record<string, unknown>) ?? {}),
            [key]: normalizeOutlineNumericInputValue(key, el.value, 0),
          };
        }
        continue;
      }

      if (el.name.startsWith('color-')) {
        if (!partial.colors) partial.colors = {};
        (partial.colors as Record<string, string>)[el.name.slice(6)] = el.value;
        continue;
      }

      if (el.name.startsWith('showAuthor-')) {
        if (!partial.showAuthor) partial.showAuthor = {};
        (partial.showAuthor as Record<string, boolean>)[el.name.slice(11)] = (
          el as HTMLInputElement
        ).checked;
        continue;
      }

      const scalarKey = el.name as keyof OverlaySettings;
      if (el instanceof HTMLInputElement) {
        if (el.type === 'checkbox') {
          partial[scalarKey] = el.checked;
        } else if (el.type === 'number') {
          partial[scalarKey] = normalizeRootNumericInputValue(
            scalarKey as RootNumericSettingKey,
            el.value,
            this.getSettings()[scalarKey] as number
          );
        } else {
          partial[scalarKey] = el.value;
        }
      } else if (el instanceof HTMLSelectElement) {
        partial[scalarKey] = el.value;
      }
    }

    return cloneSettings({ ...this.getSettings(), ...partial } as OverlaySettings);
  }

  getFocusableElements(): HTMLElement[] {
    if (!this.modal) return [];
    return [
      ...this.modal.querySelectorAll<HTMLElement>(
        'input:not([disabled]), select:not([disabled]), button, [tabindex]:not([tabindex="-1"])'
      ),
    ];
  }
}
