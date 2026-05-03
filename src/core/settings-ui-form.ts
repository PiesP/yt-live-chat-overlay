import { isLogLevel, type OverlaySettings } from '@app-types';
import {
  AUTHOR_COLOR_KEYS,
  cloneSettings,
  formatOutlineNumericSettingForInput,
  formatRootNumericSettingForInput,
  getOutlineNumericInputAttributes,
  getRootNumericInputAttributes,
  normalizeOutlineNumericInputValue,
  normalizeRootNumericInputValue,
  OUTLINE_SETTING_KEYS,
  type OutlineSettingKey,
  outlineFormName,
  ROOT_SETTING_KEYS,
  type RootScalarSettingKey,
  SHOW_AUTHOR_KEYS,
} from '@core/settings-schema';

// ── Constants shared with SettingsUi ────────────────────────────────────────

export const STYLE_ID = 'yt-chat-overlay-settings-style';
export const BUTTON_ID = 'yt-chat-overlay-settings-button';
export const BACKDROP_ID = 'yt-chat-overlay-settings-backdrop';
export const TITLE_ID = 'yt-chat-overlay-settings-title';

// ── Helper ──────────────────────────────────────────────────────────────────

const applyNumberInputAttributes = (
  input: HTMLInputElement,
  scope: 'root' | 'outline',
  key: RootScalarSettingKey | Exclude<OutlineSettingKey, 'enabled'>
): void => {
  const { min, max, step } =
    scope === 'root'
      ? getRootNumericInputAttributes(key as RootScalarSettingKey)
      : getOutlineNumericInputAttributes(key as Exclude<OutlineSettingKey, 'enabled'>);
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
};

// ── SettingsUiForm class ────────────────────────────────────────────────────

export class SettingsUiForm {
  private modal: HTMLDivElement | null = null;

  constructor(private readonly getSettings: () => Readonly<OverlaySettings>) {}

  setModal(modal: HTMLDivElement | null): void {
    this.modal = modal;
  }

  // ── Modal content factory ──────────────────────────────────────────────

  createModalContent(): Node[] {
    return [
      this.createHeader(),
      this.createTabs(),
      this.createDisplayPane(),
      this.createStylePane(),
      this.createAuthorsPane(),
      this.createFilterPane(),
      this.createActions(),
    ];
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
      ['display', 'Display'],
      ['style', 'Style'],
      ['authors', 'Authors'],
      ['filter', 'Filter'],
    ] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'yt-chat-overlay-settings-tab';
      button.dataset.tab = tabId;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(tabId === 'display'));
      button.setAttribute('aria-controls', `pane-${tabId}`);
      button.textContent = label;
      if (tabId === 'display') {
        button.classList.add('active');
      }
      nav.appendChild(button);
    }

    return nav;
  }

  private createDisplayPane(): HTMLDivElement {
    const pane = this.createPane('display');
    pane.append(
      this.createEnabledField(),
      this.createNumberField('Font Size (px)', 'fontSize'),
      this.createNumberField('Text Opacity', 'opacity'),
      this.createNumberField('Scroll Speed (px/s)', 'speedPxPerSec'),
      this.createNumberField(
        'Top Clear Zone (%)',
        'safeTop',
        'Keep top N% of video free of comments'
      ),
      this.createNumberField(
        'Bottom Clear Zone (%)',
        'safeBottom',
        'Keep bottom N% of video free of comments'
      )
    );
    return pane;
  }

  private createStylePane(): HTMLDivElement {
    const pane = this.createPane('style', true);
    const outlineSection = this.createSection('Text Outline');
    outlineSection.append(
      this.createCheckboxField('Enabled', outlineFormName('enabled')),
      this.createOutlineNumberField('Width (px)', 'widthPx'),
      this.createOutlineNumberField('Blur (px)', 'blurPx'),
      this.createOutlineNumberField('Opacity', 'opacity')
    );

    pane.append(
      this.createNumberField(
        'SuperChat Opacity (%)',
        'superChatOpacity',
        'Background opacity of Super Chat cards'
      ),
      this.createNumberField(
        'Lane Gap (px)',
        'laneSpacing',
        'Extra vertical gap between comment rows'
      ),
      outlineSection
    );
    return pane;
  }

  private createAuthorsPane(): HTMLDivElement {
    const pane = this.createPane('authors', true);
    const grid = this.createDiv('yt-chat-overlay-author-grid');
    grid.append(
      document.createElement('span'),
      this.createGridHeader('Color'),
      this.createGridHeader('Show')
    );

    for (const key of AUTHOR_COLOR_KEYS) {
      grid.append(
        this.createGridLabel(this.formatAuthorLabel(key)),
        this.createColorInput(`color-${key}`),
        this.createGridCheckbox(`showAuthor-${key}`)
      );
    }

    grid.append(
      this.createGridLabel('SuperChat'),
      document.createElement('span'),
      this.createGridCheckbox('showAuthor-superChat')
    );

    pane.appendChild(grid);
    return pane;
  }

  private createFilterPane(): HTMLDivElement {
    const pane = this.createPane('filter', true);
    const rateSection = this.createSection('Message Rate');
    rateSection.append(
      this.createNumberField(
        'Max per Second',
        'maxMessagesPerSecond',
        'Maximum new comments displayed per second'
      ),
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

    const debugSection = this.createSection('Debug');
    debugSection.append(this.createLogLevelField());

    pane.append(rateSection, performanceSection, debugSection);
    return pane;
  }

  private createActions(): HTMLDivElement {
    const actions = this.createDiv('yt-chat-overlay-settings-actions');
    for (const [action, label] of [
      ['reset', 'Reset'],
      ['apply', 'Apply'],
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
    const input = this.createInput('checkbox', 'enabled');
    label.append(text, input);
    return label;
  }

  private createNumberField(
    labelText: string,
    name: RootScalarSettingKey,
    title?: string
  ): HTMLLabelElement {
    const input = this.createInput('number', name);
    applyNumberInputAttributes(input, 'root', name);
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
    const input = this.createInput('number', name);
    applyNumberInputAttributes(input, 'outline', key);
    return this.createField(labelText, input);
  }

  private createCheckboxField(labelText: string, name: string, title?: string): HTMLLabelElement {
    const input = this.createInput('checkbox', name);
    if (title) {
      input.title = title;
    }
    return this.createField(labelText, input);
  }

  private createLogLevelField(): HTMLLabelElement {
    const select = document.createElement('select');
    select.name = 'logLevel';
    select.title = 'Console output verbosity';
    for (const [value, label] of [
      ['warn', 'Warn'],
      ['info', 'Info'],
      ['debug', 'Debug'],
    ] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    }
    return this.createField('Log Level', select);
  }

  private createField(labelText: string, control: HTMLElement): HTMLLabelElement {
    const label = document.createElement('label');
    label.className = 'yt-chat-overlay-settings-field';
    const text = document.createElement('span');
    text.textContent = labelText;
    label.append(text, control);
    return label;
  }

  private createInput(type: string, name: string): HTMLInputElement {
    const input = document.createElement('input');
    input.type = type;
    input.name = name;
    return input;
  }

  private createColorInput(name: string): HTMLInputElement {
    const input = this.createInput('color', name);
    input.className = 'yt-chat-overlay-author-grid-color';
    return input;
  }

  private createGridCheckbox(name: string): HTMLInputElement {
    const input = this.createInput('checkbox', name);
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

  private createDiv(className: string): HTMLDivElement {
    const element = document.createElement('div');
    element.className = className;
    return element;
  }

  private formatAuthorLabel(key: (typeof AUTHOR_COLOR_KEYS)[number]): string {
    return key.charAt(0).toUpperCase() + key.slice(1);
  }

  // ── Form population ────────────────────────────────────────────────────

  populateForm(settings: Readonly<OverlaySettings>): void {
    for (const key of ROOT_SETTING_KEYS) {
      this.populateRootSetting(key, settings);
    }

    this.setAuthorSettings(settings);
    for (const key of OUTLINE_SETTING_KEYS) {
      this.populateOutlineSetting(key, settings.outline);
    }

    this.syncMinTextLengthState();
  }

  private populateRootSetting(
    key: RootScalarSettingKey,
    settings: Readonly<OverlaySettings>
  ): void {
    const value = settings[key];

    if (key === 'enabled' || key === 'allowShortTextMessages') {
      this.setCheckbox(key, value as boolean);
    } else if (key === 'logLevel') {
      this.setSelect(key, value as string);
    } else {
      this.setValue(key, formatRootNumericSettingForInput(key, value as number));
    }
  }

  private populateOutlineSetting<K extends OutlineSettingKey>(
    key: K,
    outline: Readonly<OverlaySettings['outline']>
  ): void {
    const value = outline[key];
    const name = outlineFormName(key);

    if (key === 'enabled') {
      this.setCheckbox(name, value as boolean);
    } else {
      this.setValue(name, formatOutlineNumericSettingForInput(key, value as number));
    }
  }

  private setAuthorSettings(settings: Readonly<OverlaySettings>): void {
    for (const key of AUTHOR_COLOR_KEYS) {
      this.setValue(`color-${key}`, settings.colors[key]);
    }

    for (const key of SHOW_AUTHOR_KEYS) {
      this.setCheckbox(`showAuthor-${key}`, settings.showAuthor[key]);
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

    for (const key of ROOT_SETTING_KEYS) {
      nextSettings[key] = this.readRootSetting(key, current) as never;
    }

    nextSettings.showAuthor = this.collectShowAuthorSettings(current);
    nextSettings.colors = this.collectAuthorColors(current);
    nextSettings.outline = this.collectOutlineSettings(current.outline);

    return nextSettings;
  }

  private readNumber(name: string, fallback: number): number {
    const input = this.getInput(name);
    if (!input) return fallback;

    const parsed = Number.parseFloat(input.value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private collectAuthorColors(current: Readonly<OverlaySettings>): OverlaySettings['colors'] {
    const nextColors: OverlaySettings['colors'] = { ...current.colors };

    for (const key of AUTHOR_COLOR_KEYS) {
      nextColors[key] = this.getColor(`color-${key}`, current.colors[key]);
    }

    return nextColors;
  }

  private collectShowAuthorSettings(
    current: Readonly<OverlaySettings>
  ): OverlaySettings['showAuthor'] {
    const nextShowAuthor: OverlaySettings['showAuthor'] = {
      ...current.showAuthor,
    };

    for (const key of SHOW_AUTHOR_KEYS) {
      nextShowAuthor[key] = this.getCheckbox(`showAuthor-${key}`, current.showAuthor[key]);
    }

    return nextShowAuthor;
  }

  private readRootSetting(
    key: RootScalarSettingKey,
    current: Readonly<OverlaySettings>
  ): OverlaySettings[RootScalarSettingKey] {
    const fallback = current[key];

    if (key === 'enabled' || key === 'allowShortTextMessages') {
      return this.getCheckbox(key, fallback as boolean);
    }
    if (key === 'logLevel') {
      return this.getLogLevel(key, fallback as OverlaySettings['logLevel']);
    }
    return normalizeRootNumericInputValue(
      key,
      this.readNumber(key, fallback as number),
      fallback as number
    );
  }

  private readOutlineSetting<K extends OutlineSettingKey>(
    key: K,
    current: Readonly<OverlaySettings['outline']>
  ): OverlaySettings['outline'][K] {
    const fallback = current[key];
    const name = outlineFormName(key);

    return (
      key === 'enabled'
        ? this.getCheckbox(name, fallback as boolean)
        : normalizeOutlineNumericInputValue(
            key,
            this.readNumber(name, fallback as number),
            fallback as number
          )
    ) as OverlaySettings['outline'][K];
  }

  private collectOutlineSettings(
    current: Readonly<OverlaySettings['outline']>
  ): OverlaySettings['outline'] {
    const nextOutline: OverlaySettings['outline'] = { ...current };

    for (const key of OUTLINE_SETTING_KEYS) {
      nextOutline[key] = this.readOutlineSetting(key, current) as never;
    }

    return nextOutline;
  }

  // ── DOM query helpers ──────────────────────────────────────────────────

  getInput(name: string): HTMLInputElement | null {
    return this.modal?.querySelector<HTMLInputElement>(`input[name="${name}"]`) ?? null;
  }

  getSelect(name: string): HTMLSelectElement | null {
    return this.modal?.querySelector<HTMLSelectElement>(`select[name="${name}"]`) ?? null;
  }

  private getCheckbox(name: string, fallback: boolean): boolean {
    const input = this.getInput(name);
    return input ? input.checked : fallback;
  }

  private getColor(name: string, fallback: string): string {
    const input = this.getInput(name);
    return input?.value || fallback;
  }

  private getLogLevel(
    name: string,
    fallback: OverlaySettings['logLevel']
  ): OverlaySettings['logLevel'] {
    const select = this.getSelect(name);
    if (!select) return fallback;

    return isLogLevel(select.value) ? select.value : fallback;
  }

  private setValue(name: string, value: string | number): void {
    const input = this.getInput(name);
    if (input) {
      input.value = String(value);
    }
  }

  private setCheckbox(name: string, value: boolean): void {
    const input = this.getInput(name);
    if (input) {
      input.checked = value;
    }
  }

  private setSelect(name: string, value: string): void {
    const select = this.getSelect(name);
    if (select) {
      select.value = value;
    }
  }

  // ── Focus helpers ──────────────────────────────────────────────────────

  getFocusableElements(): HTMLElement[] {
    if (!this.modal) return [];

    const selectors =
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
      'textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

    return Array.from(this.modal.querySelectorAll<HTMLElement>(selectors)).filter((element) => {
      if (element.tabIndex < 0) return false;
      if (element.hasAttribute('hidden')) return false;
      // Exclude elements inside a hidden tab pane
      if (element.closest('[hidden]')) return false;
      return true;
    });
  }
}
