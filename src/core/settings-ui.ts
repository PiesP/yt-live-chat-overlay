import { isLogLevel, type OverlaySettings } from '@app-types';
import { ensurePlayerPositioning, findPlayerContainerElement } from '@core/dom';
import { createLogger } from '@core/logging';
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
import { SETTINGS_UI_STYLES } from '@core/settings-ui-styles';

const log = createLogger('SettingsUi');

const STYLE_ID = 'yt-chat-overlay-settings-style';
const BUTTON_ID = 'yt-chat-overlay-settings-button';
const BACKDROP_ID = 'yt-chat-overlay-settings-backdrop';
const TITLE_ID = 'yt-chat-overlay-settings-title';
const PLAYER_LOOKUP_INTERVAL_MS = 500;

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

export class SettingsUi {
  private playerElement: HTMLElement | null = null;
  private button: HTMLButtonElement | null = null;
  private backdrop: HTMLDivElement | null = null;
  private modal: HTMLDivElement | null = null;
  private previousFocus: HTMLElement | null = null;
  private activeTab = 'display';

  private readonly handleKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      this.close();
      return;
    }

    if (event.key === 'Tab') {
      this.trapFocus(event);
    }
  };

  constructor(
    private readonly getSettings: () => Readonly<OverlaySettings>,
    private readonly updateSettings: (partial: Partial<OverlaySettings>) => void,
    private readonly resetSettings: () => void
  ) {}

  async attach(): Promise<void> {
    const player = await this.findPlayerContainer();
    if (!player) return;

    if (this.playerElement === player && this.button?.isConnected) {
      return;
    }

    this.playerElement = player;
    this.ensureButton(player);
    this.ensureModal();
    this.close();
  }

  close(): void {
    if (!this.backdrop) return;
    this.setDialogOpen(false);

    if (this.previousFocus?.isConnected) {
      this.previousFocus.focus();
    }
    this.previousFocus = null;
  }

  private async findPlayerContainer(): Promise<HTMLElement | null> {
    return findPlayerContainerElement({
      intervalMs: PLAYER_LOOKUP_INTERVAL_MS,
    });
  }

  private ensureButton(player: HTMLElement): void {
    if (!this.button) {
      this.button = document.createElement('button');
      this.button.id = BUTTON_ID;
      this.button.type = 'button';
      this.button.className = 'yt-chat-overlay-settings-button';
      this.button.textContent = '⚙';
      this.button.setAttribute('aria-label', 'Chat overlay settings');
      this.button.addEventListener('click', () => this.open());
    } else if (this.button.parentElement) {
      this.button.remove();
    }

    ensurePlayerPositioning(player);

    player.appendChild(this.button);
  }

  private ensureStyles(): void {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = SETTINGS_UI_STYLES;
    document.head.appendChild(style);
  }

  private setDialogOpen(isOpen: boolean): void {
    if (!this.backdrop) {
      return;
    }

    this.backdrop.style.display = isOpen ? 'flex' : 'none';
    this.backdrop.hidden = !isOpen;
    this.backdrop.setAttribute('aria-hidden', isOpen ? 'false' : 'true');

    if (isOpen) {
      document.addEventListener('keydown', this.handleKeydown);
      return;
    }

    document.removeEventListener('keydown', this.handleKeydown);
  }

  private bindTabEvents(): void {
    this.modal
      ?.querySelectorAll<HTMLButtonElement>('.yt-chat-overlay-settings-tab')
      .forEach((btn) => {
        btn.addEventListener('click', () => {
          const tabId = btn.dataset.tab;
          if (tabId) this.switchTab(tabId);
        });
      });
  }

  private switchTab(tabId: string): void {
    if (!this.modal) return;
    this.activeTab = tabId;

    this.modal
      .querySelectorAll<HTMLButtonElement>('.yt-chat-overlay-settings-tab')
      .forEach((btn) => {
        const isActive = btn.dataset.tab === tabId;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-selected', String(isActive));
      });

    this.modal
      .querySelectorAll<HTMLDivElement>('.yt-chat-overlay-settings-pane')
      .forEach((pane) => {
        if (pane.dataset.pane === tabId) {
          pane.removeAttribute('hidden');
        } else {
          pane.setAttribute('hidden', '');
        }
      });
  }

  private bindModalEvents(): void {
    this.modal
      ?.querySelector<HTMLButtonElement>('.yt-chat-overlay-settings-close')
      ?.addEventListener('click', () => this.close());
    this.modal
      ?.querySelector<HTMLButtonElement>('button[data-action="apply"]')
      ?.addEventListener('click', () => this.apply());
    this.modal
      ?.querySelector<HTMLButtonElement>('button[data-action="reset"]')
      ?.addEventListener('click', () => this.handleReset());

    this.modal
      ?.querySelector<HTMLInputElement>('input[name="allowShortTextMessages"]')
      ?.addEventListener('change', () => this.syncMinTextLengthState());

    this.bindTabEvents();
  }

  private ensureModal(): void {
    this.ensureStyles();

    if (this.backdrop) return;

    this.backdrop = document.createElement('div');
    this.backdrop.id = BACKDROP_ID;
    this.backdrop.className = 'yt-chat-overlay-settings-backdrop';
    this.backdrop.addEventListener('click', (event) => {
      if (event.target === this.backdrop) {
        this.close();
      }
    });

    this.modal = document.createElement('div');
    this.modal.className = 'yt-chat-overlay-settings-modal';
    this.modal.tabIndex = -1;
    this.modal.setAttribute('role', 'dialog');
    this.modal.setAttribute('aria-modal', 'true');
    this.modal.setAttribute('aria-labelledby', TITLE_ID);
    this.modal.append(...this.createModalContent());

    this.bindModalEvents();

    this.backdrop.appendChild(this.modal);
    document.body.appendChild(this.backdrop);
    this.setDialogOpen(false);
  }

  private createModalContent(): Node[] {
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

  private open(): void {
    if (!this.backdrop || !this.modal) return;

    const activeElement = document.activeElement;
    this.previousFocus = activeElement instanceof HTMLElement ? activeElement : null;

    this.populateForm(this.getSettings());
    this.switchTab(this.activeTab);
    this.setDialogOpen(true);
    this.focusInitialElement();
  }

  private apply(): void {
    const partial = this.collectSettings();
    this.updateSettings(partial);
    this.populateForm(this.getSettings());
    this.close();
  }

  private handleReset(): void {
    this.resetSettings();
    this.populateForm(this.getSettings());
  }

  private setAuthorSettings(settings: Readonly<OverlaySettings>): void {
    for (const key of AUTHOR_COLOR_KEYS) {
      this.setValue(`color-${key}`, settings.colors[key]);
    }

    for (const key of SHOW_AUTHOR_KEYS) {
      this.setCheckbox(`showAuthor-${key}`, settings.showAuthor[key]);
    }
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

  private populateForm(settings: Readonly<OverlaySettings>): void {
    for (const key of ROOT_SETTING_KEYS) {
      this.populateRootSetting(key, settings);
    }

    this.setAuthorSettings(settings);
    for (const key of OUTLINE_SETTING_KEYS) {
      this.populateOutlineSetting(key, settings.outline);
    }

    this.syncMinTextLengthState();
  }

  private syncMinTextLengthState(): void {
    const allowShort = this.getInput('allowShortTextMessages');
    const minLength = this.getInput('minTextLength');
    if (allowShort && minLength) {
      minLength.disabled = allowShort.checked;
    }
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

  private collectSettings(): OverlaySettings {
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

  private getFocusableElements(): HTMLElement[] {
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

  private focusInitialElement(): void {
    if (!this.modal) return;

    const closeButton = this.modal.querySelector<HTMLButtonElement>(
      '.yt-chat-overlay-settings-close'
    );
    if (closeButton) {
      closeButton.focus();
      return;
    }

    const [first] = this.getFocusableElements();
    if (first) {
      first.focus();
      return;
    }

    this.modal.focus();
  }

  private trapFocus(event: KeyboardEvent): void {
    if (!this.backdrop || this.backdrop.hidden) {
      return;
    }

    const focusableElements = this.getFocusableElements();
    if (focusableElements.length === 0) {
      event.preventDefault();
      this.modal?.focus();
      return;
    }

    const first = focusableElements[0];
    const last = focusableElements[focusableElements.length - 1];
    if (!first || !last) return;

    const activeElement = document.activeElement;
    const isShiftTab = event.shiftKey;

    if (isShiftTab && activeElement === first) {
      event.preventDefault();
      last.focus();
      return;
    }

    if (!isShiftTab && activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  private getInput(name: string): HTMLInputElement | null {
    return this.modal?.querySelector<HTMLInputElement>(`input[name="${name}"]`) ?? null;
  }

  private getSelect(name: string): HTMLSelectElement | null {
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

  destroy(): void {
    this.close();
    this.button?.remove();
    this.backdrop?.remove();

    const styleElement = document.getElementById(STYLE_ID);
    styleElement?.remove();

    this.button = null;
    this.backdrop = null;
    this.modal = null;
    this.playerElement = null;

    log.info('Destroyed');
  }
}
