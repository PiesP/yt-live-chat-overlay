import { isLogLevel, type OverlaySettings } from '@app-types';
import {
  AUTHOR_COLOR_KEYS,
  cloneSettings,
  OUTLINE_LIMITS_MAP,
  OUTLINE_NUMERIC_KEYS,
  OUTLINE_SETTING_KEYS,
  type OutlineSettingKey,
  ROOT_NUMERIC_KEYS,
  ROOT_SETTING_KEYS,
  type RootNumericSettingKey,
  type RootScalarSettingKey,
  SETTINGS_LIMITS,
  SHOW_AUTHOR_KEYS,
} from '@core/settings-schema';

const outlineFormName = (key: OutlineSettingKey): string => `outline-${key}`;

// ── Constants shared with SettingsUi ────────────────────────────────────────

export const STYLE_ID = 'yt-chat-overlay-settings-style';
export const BUTTON_ID = 'yt-chat-overlay-settings-button';
export const BACKDROP_ID = 'yt-chat-overlay-settings-backdrop';
const TITLE_ID = 'yt-chat-overlay-settings-title';

// ── UI value formatting ─────────────────────────────────────────────────────

const ROOT_ROUNDED_KEYS = new Set<RootScalarSettingKey>([
  'maxConcurrentMessages',
  'minTextLength',
  'laneSpacing',
  'authorRateLimitMaxMessages',
]);

interface NumericInputOptions {
  readonly scale?: number;
  readonly precision?: number;
}

/** Settings displayed as percentages in the UI (stored as 0-1 internally). */
const ROOT_NUMERIC_INPUT_OPTIONS: Partial<Record<RootScalarSettingKey, NumericInputOptions>> = {
  superChatOpacity: { scale: 100, precision: 0 },
  safeTop: { scale: 100, precision: 1 },
  safeBottom: { scale: 100, precision: 1 },
};

const scaleUiValue = (value: number, scale: number): number =>
  Math.round(value * scale * 1e4) / 1e4;

const getRootScale = (key: RootScalarSettingKey): number =>
  ROOT_NUMERIC_INPUT_OPTIONS[key]?.scale ?? 1;

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
  const options = ROOT_NUMERIC_INPUT_OPTIONS[key];
  const scaledValue = scaleUiValue(value, options?.scale ?? 1);
  return options?.precision === undefined ? scaledValue : scaledValue.toFixed(options.precision);
};

const normalizeRootNumericInputValue = (
  key: RootNumericSettingKey,
  value: unknown,
  fallback: number
): number => {
  if (!(key in SETTINGS_LIMITS)) return fallback;
  return normalizeNumericValue(
    value,
    fallback,
    SETTINGS_LIMITS[key as keyof typeof SETTINGS_LIMITS],
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

// ── Helper ──────────────────────────────────────────────────────────────────

const applyNumberInputAttributes = (
  input: HTMLInputElement,
  key: RootScalarSettingKey | Exclude<OutlineSettingKey, 'enabled'>
): void => {
  const { min, max, step } = getNumericInputAttributes(key);
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
};

// ── SettingsUiForm class ────────────────────────────────────────────────────

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

  /** Attach input/change listeners to enable live preview on form fields. */
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
    const panes = [this.createCommentsPane(), this.createColorsPane(), this.createAdvancedPane()];
    for (const pane of panes) {
      this.attachLivePreview(pane);
    }
    return [this.createHeader(), this.createTabs(), ...panes, this.createActions()];
  }

  private createDiv(className: string): HTMLDivElement {
    const element = document.createElement('div');
    element.className = className;
    return element;
  }

  private createHeader(): HTMLDivElement {
    const header = this.createDiv('yt-chat-overlay-settings-header');
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

    for (const [tabId, label] of [
      ['comments', 'Comments'],
      ['colors', 'Colors'],
      ['advanced', 'Advanced'],
    ] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'yt-chat-overlay-settings-tab';
      button.dataset.tab = tabId;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(tabId === 'comments'));
      button.setAttribute('aria-controls', `pane-${tabId}`);
      button.textContent = label;
      if (tabId === 'comments') {
        button.classList.add('active');
      }
      nav.appendChild(button);
    }

    return nav;
  }

  // ── Select field factory ───────────────────────────────────────────────

  private static readonly SELECT_FIELD_OPTIONS: Record<
    string,
    { label: string; title: string; options: ReadonlyArray<[string, string]> }
  > = {
    logLevel: {
      label: 'Log Level',
      title: 'Console output verbosity',
      options: [
        ['warn', 'Warn'],
        ['info', 'Info'],
        ['debug', 'Debug'],
      ],
    },
    backlogMode: {
      label: 'Backlog Mode',
      title: 'How to show past chat messages on load',
      options: [
        ['playback', 'Playback-based (recommended)'],
        ['recent', 'Recent only'],
        ['full', 'Full (show all)'],
        ['none', 'None (skip backlog)'],
      ],
    },
    danmakuMode: {
      label: 'Danmaku Mode',
      title: 'Comment animation direction and behavior',
      options: [
        ['scroll', 'Scroll (RTL)'],
        ['reverse', 'Reverse (LTR)'],
        ['top', 'Top Fixed'],
        ['bottom', 'Bottom Fixed'],
      ],
    },
  };

  private createSelectField(name: string): HTMLLabelElement {
    const config = SettingsUiForm.SELECT_FIELD_OPTIONS[name];
    if (!config) return this.createField(name, document.createElement('select'));
    const select = document.createElement('select');
    select.name = name;
    select.title = config.title;
    for (const [value, label] of config.options) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    }
    return this.createField(config.label, select);
  }

  private createCommentsPane(): HTMLDivElement {
    const pane = this.createPane('comments');
    const outlineSection = this.createSection('Text Outline');
    outlineSection.append(
      this.createCheckboxField('Enabled', outlineFormName('enabled')),
      this.createOutlineNumberField('Width (px)', 'widthPx'),
      this.createOutlineNumberField('Blur (px)', 'blurPx'),
      this.createOutlineNumberField('Opacity', 'opacity')
    );

    pane.append(
      this.createEnabledField(),
      this.createSelectField('danmakuMode'),
      this.createNumberField('Font Size (px)', 'fontSize'),
      this.createNumberField('Text Opacity', 'opacity'),
      this.createNumberField('Scroll Speed (px/s)', 'speedPxPerSec'),
      this.createNumberField(
        'Lane Gap (px)',
        'laneSpacing',
        'Extra vertical gap between comment rows'
      ),
      outlineSection
    );
    return pane;
  }

  private createColorsPane(): HTMLDivElement {
    const pane = this.createPane('colors', true);
    pane.append(
      this.createNumberField(
        'SuperChat Opacity (%)',
        'superChatOpacity',
        'Background opacity of Super Chat cards'
      )
    );
    const authorSection = this.createSection('Author Colors & Visibility');
    const grid = this.createDiv('yt-chat-overlay-author-grid');
    grid.append(
      document.createElement('span'),
      this.createGridHeader('Color'),
      this.createGridHeader('Show')
    );

    for (const key of AUTHOR_COLOR_KEYS) {
      grid.append(
        this.createGridLabel(this.formatAuthorLabel(key)),
        this.createInput({
          type: 'color',
          name: `color-${key}`,
          className: 'yt-chat-overlay-author-grid-color',
        }),
        this.createGridCheckbox(`showAuthor-${key}`)
      );
    }

    grid.append(
      this.createGridLabel('SuperChat'),
      document.createElement('span'),
      this.createGridCheckbox('showAuthor-superChat')
    );

    authorSection.appendChild(grid);
    pane.appendChild(authorSection);
    return pane;
  }

  private createAdvancedPane(): HTMLDivElement {
    const pane = this.createPane('advanced', true);

    const safeZoneSection = this.createSection('Safe Zone');
    safeZoneSection.append(
      this.createNumberField(
        'Top Clear Zone (%)',
        'safeTop',
        'Keep top N% of video free of comments (safe zone for stream info overlays)'
      ),
      this.createNumberField(
        'Bottom Clear Zone (%)',
        'safeBottom',
        'Keep bottom N% of video free of comments (safe zone for YouTube controls)'
      )
    );

    const rateSection = this.createSection('Message Rate');
    rateSection.append(
      this.createCheckboxField(
        'Show Short Messages',
        'allowShortTextMessages',
        'Show messages shorter than Min Length'
      ),
      this.createNumberField(
        'Min Length (chars)',
        'minTextLength',
        'Minimum character count (ignored when Show Short is on)'
      )
    );

    const performanceSection = this.createSection('Performance');
    performanceSection.append(
      this.createNumberField(
        'Max Visible',
        'maxConcurrentMessages',
        'Performance warning threshold for simultaneous comments'
      )
    );

    const backlogSection = this.createSection('Backlog');
    backlogSection.append(
      this.createSelectField('backlogMode'),
      this.createNumberField(
        'Max backlog rate (msg/s)',
        'backlogMaxRate',
        'Maximum messages per second during backlog injection'
      ),
      this.createNumberField(
        'Backlog speed multiplier',
        'backlogSpeedMultiplier',
        'Speed multiplier for backlog message animations'
      ),
      this.createNumberField(
        'Recent minutes',
        'backlogRecentMinutes',
        'Show past chat from last N minutes (only for "Recent" mode)'
      ),
      this.createCheckboxField(
        'Show backlog loading indicator',
        'showBacklogIndicator',
        'Show loading indicator during backlog injection'
      )
    );

    const rateLimitSection = this.createSection('Rate Limiting');
    rateLimitSection.append(
      this.createCheckboxField(
        'Enable author rate limiting',
        'authorRateLimitEnabled',
        'Limit messages per author per time window'
      ),
      this.createNumberField(
        'Window (ms)',
        'authorRateLimitWindowMs',
        'Time window for rate limiting in milliseconds'
      ),
      this.createNumberField(
        'Max per window',
        'authorRateLimitMaxMessages',
        'Maximum messages per author per window'
      )
    );

    const debugSection = this.createSection('Debug');
    debugSection.append(
      this.createSelectField('logLevel'),
      this.createCheckboxField(
        'Show debug overlay',
        'showDebugOverlay',
        'Display real-time metrics overlay'
      )
    );

    pane.append(
      safeZoneSection,
      rateSection,
      performanceSection,
      backlogSection,
      rateLimitSection,
      debugSection
    );
    return pane;
  }

  private createActions(): HTMLDivElement {
    const actions = this.createDiv('yt-chat-overlay-settings-actions');
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

  private createPane(id: string, hidden = false): HTMLDivElement {
    const pane = this.createDiv('yt-chat-overlay-settings-pane');
    pane.id = `pane-${id}`;
    pane.dataset.pane = id;
    pane.setAttribute('role', 'tabpanel');
    if (hidden) {
      pane.hidden = true;
    }
    return pane;
  }

  private createSection(titleText: string): HTMLDivElement {
    const section = this.createDiv('yt-chat-overlay-settings-section');
    const title = this.createDiv('yt-chat-overlay-settings-section-title');
    title.textContent = titleText;
    section.appendChild(title);
    return section;
  }

  private createEnabledField(): HTMLLabelElement {
    const label = document.createElement('label');
    label.className = 'yt-chat-overlay-settings-enabled';
    const text = document.createElement('span');
    text.textContent = 'Overlay Enabled';
    const input = this.createInput({ type: 'checkbox', name: 'enabled' });
    label.append(text, input);
    return label;
  }

  private createNumberField(
    labelText: string,
    name: RootScalarSettingKey,
    title?: string
  ): HTMLLabelElement {
    const input = this.createInput({ type: 'number', name });
    applyNumberInputAttributes(input, name);
    if (title) {
      input.title = title;
    }
    return this.createField(labelText, input);
  }

  private createOutlineNumberField(
    labelText: string,
    key: Exclude<OutlineSettingKey, 'enabled'>
  ): HTMLLabelElement {
    const name = outlineFormName(key);
    const input = this.createInput({ type: 'number', name });
    applyNumberInputAttributes(input, key);
    return this.createField(labelText, input);
  }

  private createCheckboxField(labelText: string, name: string, title?: string): HTMLLabelElement {
    const input = this.createInput({ type: 'checkbox', name });
    if (title) {
      input.title = title;
    }
    return this.createField(labelText, input);
  }

  private createField(labelText: string, control: HTMLElement): HTMLLabelElement {
    const label = document.createElement('label');
    label.className = 'yt-chat-overlay-settings-field';
    const text = document.createElement('span');
    text.textContent = labelText;
    label.append(text, control);
    return label;
  }

  private createInput(props: { type: string; name: string; className?: string }): HTMLInputElement {
    const input = document.createElement('input');
    input.type = props.type;
    input.name = props.name;
    if (props.className) {
      input.className = props.className;
    }
    return input;
  }

  private createGridCheckbox(name: string): HTMLInputElement {
    const input = this.createInput({ type: 'checkbox', name });
    input.className = 'yt-chat-overlay-author-grid-checkbox';
    return input;
  }

  private createGridHeader(text: string): HTMLSpanElement {
    const element = document.createElement('span');
    element.className = 'yt-chat-overlay-author-grid-header';
    element.textContent = text;
    return element;
  }

  private createGridLabel(text: string): HTMLSpanElement {
    const element = document.createElement('span');
    element.className = 'yt-chat-overlay-author-grid-label';
    element.textContent = text;
    return element;
  }

  private formatAuthorLabel(key: (typeof AUTHOR_COLOR_KEYS)[number]): string {
    return key.charAt(0).toUpperCase() + key.slice(1);
  }

  // ── Form population ────────────────────────────────────────────────────

  populateForm(settings: Readonly<OverlaySettings>): void {
    this.isUpdating = true;
    try {
      for (const key of ROOT_SETTING_KEYS) {
        this.populateRootSetting(key, settings);
      }

      this.setAuthorSettings(settings);
      for (const key of OUTLINE_SETTING_KEYS) {
        this.populateOutlineSetting(key, settings.outline);
      }

      this.syncMinTextLengthState();
    } finally {
      this.isUpdating = false;
    }
  }

  private static readonly BOOLEAN_ROOT_KEYS = new Set<RootScalarSettingKey>([
    'enabled',
    'allowShortTextMessages',
    'showDebugOverlay',
    'authorRateLimitEnabled',
    'showBacklogIndicator',
  ]);

  private static readonly SELECT_ROOT_KEYS = new Set<RootScalarSettingKey>([
    'logLevel',
    'backlogMode',
    'danmakuMode',
  ]);

  private populateRootSetting(
    key: RootScalarSettingKey,
    settings: Readonly<OverlaySettings>
  ): void {
    const value = settings[key];

    if (SettingsUiForm.BOOLEAN_ROOT_KEYS.has(key)) {
      this.setCheckbox(key, value as boolean);
    } else if (SettingsUiForm.SELECT_ROOT_KEYS.has(key)) {
      this.setSelect(key, value as string);
    } else {
      this.setValue(key, formatRootNumericSettingForInput(key, value as number));
    }
  }

  private populateOutlineSetting(
    key: keyof OverlaySettings['outline'],
    outline: OverlaySettings['outline']
  ): void {
    const inputName = outlineFormName(key);
    if (key === 'enabled') {
      this.setCheckbox(inputName, outline.enabled);
    } else {
      this.setValue(inputName, String(outline[key]));
    }
  }

  private setAuthorSettings(settings: Readonly<OverlaySettings>): void {
    for (const key of SHOW_AUTHOR_KEYS) {
      this.setCheckbox(`showAuthor-${key}`, settings.showAuthor[key]);
    }

    const colorInputs = this.modal?.querySelectorAll<HTMLInputElement>(
      'input[type="color"][name^="color-"]'
    );
    if (colorInputs) {
      for (const input of colorInputs) {
        const colorKey = input.name.replace('color-', '') as keyof OverlaySettings['colors'];
        if (colorKey in settings.colors) {
          input.value = settings.colors[colorKey];
        }
      }
    }
  }

  syncMinTextLengthState(): void {
    const allowShort = this.getInput('allowShortTextMessages');
    const minLength = this.getInput('minTextLength');
    if (allowShort && minLength) {
      minLength.disabled = allowShort.checked;
    }
  }

  // ── Form data collection ───────────────────────────────────────────────

  collectSettings(): OverlaySettings {
    const current = this.getSettings();
    const nextSettings = cloneSettings(current);

    this.applyRootSettingsTo(nextSettings, current);

    nextSettings.showAuthor = this.collectShowAuthorSettings(current);
    nextSettings.colors = this.collectAuthorColors(current);
    nextSettings.outline = this.collectOutlineSettings(current.outline);

    return nextSettings;
  }

  private applyRootSettingsTo(target: OverlaySettings, current: Readonly<OverlaySettings>): void {
    for (const key of SettingsUiForm.BOOLEAN_ROOT_KEYS) {
      (target[key] as boolean) = this.getCheckbox(key, current[key] as boolean);
    }

    target.logLevel = this.getLogLevel('logLevel', current.logLevel);
    target.backlogMode = this.getSelectValue(
      'backlogMode',
      current.backlogMode
    ) as OverlaySettings['backlogMode'];
    target.danmakuMode = this.getSelectValue(
      'danmakuMode',
      current.danmakuMode
    ) as OverlaySettings['danmakuMode'];

    for (const key of ROOT_NUMERIC_KEYS) {
      target[key] = normalizeRootNumericInputValue(
        key,
        this.readNumber(key, current[key]),
        current[key]
      );
    }
  }

  private readNumber(name: string, fallback: number): number {
    const input = this.getInput(name);
    if (!input) return fallback;
    const parsed = Number.parseFloat(input.value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  // ── DOM access helpers ─────────────────────────────────────────────────

  private getInput(name: string): HTMLInputElement | null {
    return this.modal?.querySelector<HTMLInputElement>(`input[name="${name}"]`) ?? null;
  }

  private getCheckbox(name: string, fallback: boolean): boolean {
    const input = this.getInput(name);
    return input ? input.checked : fallback;
  }

  private setCheckbox(name: string, checked: boolean): void {
    const input = this.getInput(name);
    if (input) input.checked = checked;
  }

  private setValue(name: string, value: string | number): void {
    const input = this.getInput(name);
    if (input) input.value = String(value);
  }

  private getSelectValue(name: string, fallback: string): string {
    const select = this.modal?.querySelector<HTMLSelectElement>(`select[name="${name}"]`);
    return select?.value ?? fallback;
  }

  private setSelect(name: string, value: string): void {
    const select = this.modal?.querySelector<HTMLSelectElement>(`select[name="${name}"]`);
    if (select) select.value = value;
  }

  private getLogLevel(
    name: string,
    fallback: OverlaySettings['logLevel']
  ): OverlaySettings['logLevel'] {
    const select = this.modal?.querySelector<HTMLSelectElement>(`select[name="${name}"]`);
    const value = select?.value;
    return isLogLevel(value) ? value : fallback;
  }

  private collectShowAuthorSettings(
    current: Readonly<OverlaySettings>
  ): OverlaySettings['showAuthor'] {
    const showAuthor = { ...current.showAuthor };
    for (const key of SHOW_AUTHOR_KEYS) {
      showAuthor[key] = this.getCheckbox(`showAuthor-${key}`, current.showAuthor[key]);
    }
    return showAuthor;
  }

  private collectAuthorColors(current: Readonly<OverlaySettings>): OverlaySettings['colors'] {
    const colors = { ...current.colors };
    for (const key of AUTHOR_COLOR_KEYS) {
      const input = this.getInput(`color-${key}`);
      if (input) colors[key] = input.value;
    }
    return colors;
  }

  private collectOutlineSettings(current: OverlaySettings['outline']): OverlaySettings['outline'] {
    const outline = { ...current };
    outline.enabled = this.getCheckbox(outlineFormName('enabled'), current.enabled);
    for (const key of OUTLINE_NUMERIC_KEYS) {
      const input = this.getInput(outlineFormName(key));
      if (input) {
        outline[key] = normalizeOutlineNumericInputValue(key, input.value, current[key]);
      }
    }
    return outline;
  }

  getFocusableElements(): HTMLElement[] {
    if (!this.modal) return [];
    return Array.from(
      this.modal.querySelectorAll<HTMLElement>(
        'input:not([type="hidden"]), select, button, textarea, [tabindex]:not([tabindex="-1"])'
      )
    ).filter((el) => {
      if (el instanceof HTMLElement && el.offsetParent !== null) return true;
      return false;
    });
  }
}
