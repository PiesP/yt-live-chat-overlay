// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { OverlaySettings } from '@app-types';
import { t } from '@i18n/index';
import type {
  OutlineSettingKey,
  RootNumericSettingKey,
  RootScalarSettingKey,
} from '@settings/schema';
import {
  AUTHOR_COLOR_KEYS,
  cloneSettings,
  getOutlineDisplayScale,
  getRootDisplayMeta,
  OUTLINE_NUMERIC_KEYS,
  resolveLimits,
  resolveOutlineLimits,
} from '@settings/schema';
import type {
  AuthorGridField,
  FieldDef,
  FontChipsField,
  FontPreviewField,
  PaneDef,
  WeightToggleField,
} from '@settings/ui/panes';
import { PANES } from '@settings/ui/panes';
import { TranslationService } from '@translation/service';
import { createLogger } from '@util/logging';

const log = createLogger('SettingsUiForm');

// ── Unique ID generator ──────────────────────────────────────────────────────

let _fieldIdCounter = 0;
function nextFieldId(prefix: string): string {
  return `yt-field-${prefix}-${_fieldIdCounter++}`;
}

// ── Tab keyboard navigation helper ────────────────────────────────────────────

function setupTabKeyNavigation(tablist: HTMLElement): void {
  const tabs = Array.from(tablist.querySelectorAll<HTMLElement>('[role="tab"]'));
  if (tabs.length === 0) return;

  const handleKeyDown = (event: KeyboardEvent): void => {
    const currentTab = document.activeElement as HTMLElement | null;
    if (currentTab?.getAttribute('role') !== 'tab') return;

    const currentIndex = tabs.indexOf(currentTab);
    if (currentIndex === -1) return;

    let newIndex = -1;

    switch (event.key) {
      case 'ArrowLeft':
        newIndex = (currentIndex - 1 + tabs.length) % tabs.length;
        event.preventDefault();
        break;
      case 'ArrowRight':
        newIndex = (currentIndex + 1) % tabs.length;
        event.preventDefault();
        break;
      case 'Home':
        newIndex = 0;
        event.preventDefault();
        break;
      case 'End':
        newIndex = tabs.length - 1;
        event.preventDefault();
        break;
      default:
        return;
    }

    if (newIndex >= 0 && newIndex !== currentIndex) {
      // Update roving tabindex
      currentTab.setAttribute('tabindex', '-1');
      const newTab = tabs[newIndex];
      if (newTab) {
        newTab.setAttribute('tabindex', '0');
        newTab.focus();
        // Automatic activation: switching focus immediately activates the tab.
        // Uses click() rather than dispatching a custom event so the existing
        // click-delegation handler in bindTabEvents() processes it uniformly.
        newTab.click();
      }
    }
  };

  tablist.addEventListener('keydown', handleKeyDown);
}

export const STYLE_ID = 'yt-chat-overlay-settings-style';
export const BUTTON_ID = 'yt-chat-overlay-settings-button';
export const RELOAD_BUTTON_ID = 'yt-chat-overlay-reload-button';
export const BACKDROP_ID = 'yt-chat-overlay-settings-backdrop';

const OUTLINE_NUMERIC_KEY_SET = new Set<string>(OUTLINE_NUMERIC_KEYS);
const isOutlineNumericKey = (key: string): key is Exclude<OutlineSettingKey, 'enabled'> =>
  OUTLINE_NUMERIC_KEY_SET.has(key);

// ── DOM helper functions ─────────────────────────────────────────────────────

function domDiv(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

function domInput(props: { type: string; name: string; className?: string }): HTMLInputElement {
  const el = document.createElement('input');
  el.type = props.type;
  el.name = props.name;
  if (props.className) el.className = props.className;
  // Prevent password managers from treating settings inputs as credential fields.
  // The dialog-level autocomplete="off" covers most cases; this provides defense-in-depth
  // for password managers that scan individual inputs instead of the dialog attribute.
  el.autocomplete = 'off';
  return el;
}

function domField(labelText: string, control: HTMLElement, _id?: string): HTMLLabelElement {
  const label = document.createElement('label');
  label.className = 'yt-chat-overlay-settings-field';
  // No htmlFor needed — the label wraps the control, so implicit
  // label–input association works natively without an explicit for/id.
  const text = document.createElement('span');
  text.textContent = labelText;
  label.append(text, control);
  return label;
}

function domSection(titleText: string): HTMLDivElement {
  const sec = domDiv('yt-chat-overlay-settings-section');
  const title = document.createElement('h3');
  title.className = 'yt-chat-overlay-settings-section-title';
  title.textContent = titleText;
  sec.appendChild(title);
  return sec;
}

function domGridCheckbox(name: string, id?: string): HTMLInputElement {
  const el = domInput({ type: 'checkbox', name });
  el.className = 'yt-chat-overlay-author-grid-checkbox';
  if (id) el.id = id;
  return el;
}

// ── Modal sub-structure factories ────────────────────────────────────────────

const TITLE_ID = 'yt-chat-overlay-settings-title';

function createHeader(): HTMLDivElement {
  const header = domDiv('yt-chat-overlay-settings-header');
  const title = document.createElement('h2');
  title.id = TITLE_ID;
  title.className = 'yt-chat-overlay-settings-title';
  title.textContent = t('app.title');
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'yt-chat-overlay-settings-close';
  closeButton.setAttribute('data-action', 'close');
  closeButton.setAttribute('aria-label', t('app.close'));
  // command Invoker Commands (Chrome 134+) as progressive enhancement.
  // Declaratively closes the native dialog without JavaScript.
  closeButton.setAttribute('command', 'close');
  closeButton.textContent = '\u00D7';
  header.append(title, closeButton);
  return header;
}

function createTabs(): HTMLElement {
  const nav = document.createElement('nav');
  nav.className = 'yt-chat-overlay-settings-tabs';
  nav.setAttribute('role', 'tablist');
  nav.setAttribute('aria-orientation', 'horizontal');
  nav.setAttribute('aria-label', t('app.settingsCategories'));

  for (const [index, pane] of PANES.entries()) {
    const tabId = `tab-${pane.id}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.id = tabId;
    button.className = 'yt-chat-overlay-settings-tab';
    button.dataset.tab = pane.id;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(index === 0));
    button.setAttribute('aria-controls', `pane-${pane.id}`);
    // Roving tabindex: first tab focusable, rest not
    button.setAttribute('tabindex', String(index === 0 ? 0 : -1));
    button.textContent = t(pane.label);
    if (pane.id === 'comments') button.classList.add('active');
    nav.appendChild(button);
  }

  // Set up arrow key navigation
  setupTabKeyNavigation(nav);

  return nav;
}

const ACTIONS = ['reset', 'export', 'import', 'close'] as const;
export type ActionType = (typeof ACTIONS)[number];

function createActions(): HTMLDivElement {
  const wrapper = domDiv('yt-chat-overlay-settings-actions-wrapper');
  const actions = domDiv('yt-chat-overlay-settings-actions');
  for (const action of ACTIONS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.action = action;
    // Use "Done" for the close action to avoid user confusion
    button.textContent = action === 'close' ? t('app.done') : t(`actions.${action}`);
    actions.appendChild(button);
  }
  wrapper.appendChild(actions);

  // Subtle auto-save indicator — reassures users their changes are persisted
  const autoSaveHint = document.createElement('p');
  autoSaveHint.className = 'yt-chat-overlay-settings-autosave-hint';
  autoSaveHint.textContent = t('app.autoSave');
  wrapper.appendChild(autoSaveHint);

  return wrapper;
}

function createEnabledField(title?: string): HTMLLabelElement {
  const id = nextFieldId('enabled');
  const label = document.createElement('label');
  label.className = 'yt-chat-overlay-settings-enabled';
  // Label wraps the input below — implicit association, no htmlFor needed.
  const text = document.createElement('span');
  text.textContent = t('app.enabled');
  const input = domInput({ type: 'checkbox', name: 'enabled' });
  input.id = id;
  if (title) input.title = t(title);
  label.append(text, input);
  return label;
}

function createCheckboxField(labelText: string, name: string, title?: string): HTMLLabelElement {
  const id = nextFieldId(name);
  const input = domInput({ type: 'checkbox', name });
  input.id = id;
  if (title) input.title = t(title);
  return domField(t(labelText), input, id);
}

// ── UI value formatting ──────────────────────────────────────────────────────

/**
 * Map setting keys to human-readable unit labels for aria-valuetext.
 * Returns empty string if the key has no common unit.
 */
function getRangeUnit(key: string): string {
  switch (key) {
    case 'opacity':
    case 'safeTop':
    case 'safeBottom':
    case 'depthNearSpeedMul':
    case 'depthFarSpeedMul':
    case 'depthFarOpacityMul':
      return '%';
    case 'fontSize':
      return 'px';
    case 'speedPxPerSec':
      return 'px/s';
    default:
      return '';
  }
}

const ROUNDING_PRECISION = 1e4;

const scaleUiValue = (value: number, scale: number): number =>
  Math.round(value * scale * ROUNDING_PRECISION) / ROUNDING_PRECISION;

const getRootScale = (key: RootScalarSettingKey): number => getRootDisplayMeta(key).scale;

/**
 * Normalize a numeric input value to its internal representation.
 *
 * Rounding is applied at the display-value level **before** scaling down to the
 * internal range.  This is critical for settings with `displayScale` (e.g.
 * `superChatOpacity` where the UI works in 0–100 but the internal value is
 * 0.35–1.0).  Without pre-scale rounding a user entering "85" would produce
 * `Math.round(0.85) = 1` and silently revert to 100 %.
 */
const normalizeNumericValue = (
  value: unknown,
  fallback: number,
  limits: Readonly<{ min: number; max: number }>,
  rounded: boolean,
  scale = 1
): number => {
  const rawValue = typeof value === 'number' ? value : Number(value);
  // Round the display value while it is still in the display range, *then*
  // scale down to the internal range so fractional precision is preserved.
  const displayValue = rounded ? Math.round(rawValue) : rawValue;
  const scaledValue = displayValue / scale;
  const numericValue = Number.isFinite(scaledValue) ? scaledValue : fallback;
  return Math.min(limits.max, Math.max(limits.min, numericValue));
};

const formatRootNumericSettingForInput = (
  key: RootScalarSettingKey,
  value: number
): string | number => {
  const { scale, precision } = getRootDisplayMeta(key);
  const scaledValue = scaleUiValue(value, scale);
  return precision > 0 ? scaledValue.toFixed(precision) : scaledValue;
};

const normalizeRootNumericInputValue = (
  key: RootNumericSettingKey,
  value: unknown,
  fallback: number
): number => {
  return normalizeNumericValue(
    value,
    fallback,
    resolveLimits(key),
    getRootDisplayMeta(key).precision <= 0,
    getRootScale(key)
  );
};

const normalizeOutlineNumericInputValue = (
  key: Exclude<OutlineSettingKey, 'enabled'>,
  value: unknown,
  fallback: number
): number => {
  return normalizeNumericValue(
    value,
    fallback,
    resolveOutlineLimits(key),
    false,
    getOutlineDisplayScale(key)
  );
};

const getNumericInputAttributes = (
  key: RootScalarSettingKey | Exclude<OutlineSettingKey, 'enabled'>
): Readonly<{ min: number; max: number; step: number }> => {
  const limits = isOutlineNumericKey(key) ? resolveOutlineLimits(key) : resolveLimits(key);
  const scale = isOutlineNumericKey(key)
    ? getOutlineDisplayScale(key)
    : getRootScale(key as RootScalarSettingKey);
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

// ── Outline patching helper ───────────────────────────────────────────────────

function patchOutline(partial: Record<string, unknown>, patch: Record<string, unknown>): void {
  partial.outline = { ...((partial.outline as Record<string, unknown>) ?? {}), ...patch };
}

// ── SettingsUiForm class ─────────────────────────────────────────────────────
export class SettingsUiForm {
  private modal: HTMLDialogElement | null = null;
  private isUpdating = false;
  private errorDismissTimeouts: ReturnType<typeof setTimeout>[] = [];

  // Track event listeners added to the modal so they can be removed before
  // re-adding on language change (which calls rebuildModalContent → setModal).
  private _modalCleanupFns: (() => void)[] = [];

  constructor(
    private readonly getSettings: () => Readonly<OverlaySettings>,
    private readonly onPreview?: () => void
  ) {}

  setModal(modal: HTMLDialogElement | null): void {
    // Remove old listeners before re-binding (handles language change re-attach).
    for (const fn of this._modalCleanupFns) fn();
    this._modalCleanupFns = [];

    this.modal = modal;
    if (modal) {
      this.bindNumberInputKeys(modal);
      this.bindAriaInvalidSync(modal);
    } else {
      this.clearErrorDismissTimeouts();
    }
    log.debug('Modal set', { attached: modal !== null });
  }

  destroy(): void {
    this.clearErrorDismissTimeouts();
    this.modal = null;
  }

  private clearErrorDismissTimeouts(): void {
    for (const t of this.errorDismissTimeouts) clearTimeout(t);
    this.errorDismissTimeouts = [];
  }

  /**
   * Keyboard shortcuts for number inputs:
   *   Shift+↑/↓       → ±10 × step
   *   Ctrl+Shift+↑/↓  → ±100 × step
   *
   * Without modifiers, ↑/↓ uses the browser's native ±1 step behavior.
   * YouTube shortcuts are naturally suppressed because the focused input
   * receives the event first — no conflict.
   */
  private bindNumberInputKeys(modal: HTMLElement): void {
    const handler = (event: Event): void => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement) || target.type !== 'number') return;

      const step = parseFloat(target.step || '1');
      if (!step || !Number.isFinite(step)) return;

      let direction = 0;
      if ((event as KeyboardEvent).key === 'ArrowUp') direction = 1;
      else if ((event as KeyboardEvent).key === 'ArrowDown') direction = -1;
      else return;

      // Without modifiers, let the browser handle native ↑/↓ (±1 step)
      if (
        !(event as KeyboardEvent).shiftKey &&
        !(event as KeyboardEvent).ctrlKey &&
        !(event as KeyboardEvent).metaKey
      )
        return;

      const scale = (event as KeyboardEvent).ctrlKey || (event as KeyboardEvent).metaKey ? 100 : 10;
      const delta = direction * step * scale;

      event.preventDefault();
      const min = target.min ? parseFloat(target.min) : -Infinity;
      const max = target.max ? parseFloat(target.max) : Infinity;
      const current = parseFloat(target.value);
      const base = Number.isFinite(current) ? current : min;
      const newValue = Math.min(max, Math.max(min, base + delta));
      // Snap to the nearest step to avoid floating-point drift
      target.value = String(Math.round(newValue / step) * step);
      target.dispatchEvent(new Event('input', { bubbles: true }));
    };
    modal.addEventListener('keydown', handler);
    this._modalCleanupFns.push(() => modal.removeEventListener('keydown', handler));
  }

  /**
   * Sync aria-invalid attribute on form inputs using native :user-invalid
   * pseudo-class checking. Updates on blur and input events so screen
   * readers are notified of validation state changes.
   */
  private bindAriaInvalidSync(modal: HTMLElement): void {
    // Feature-detect :user-invalid support to avoid SyntaxError in
    // older browsers (Chrome < 119). CSS.supports('selector(...)')
    // is the standard way to check pseudo-class availability.
    const supportsUserInvalid = ((): boolean => {
      try {
        return CSS.supports('selector(:user-invalid)');
      } catch {
        return false;
      }
    })();

    const sync = (input: HTMLInputElement | HTMLSelectElement): void => {
      if (input.willValidate) {
        // Prefer :user-invalid (only flags after user interaction),
        // fall back to :invalid + checkValidity() in older browsers
        // where :user-invalid is not supported.
        const isInvalid = supportsUserInvalid
          ? input.matches(':user-invalid')
          : input.matches(':invalid') || !input.checkValidity();
        input.setAttribute('aria-invalid', String(isInvalid));
      }
    };
    const blurHandler = (event: Event): void => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) {
        if (target.name) sync(target);
      }
    };
    const inputHandler = (event: Event): void => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) {
        if (target.name) sync(target);
      }
    };
    modal.addEventListener('blur', blurHandler, true);
    modal.addEventListener('input', inputHandler);
    this._modalCleanupFns.push(() => {
      modal.removeEventListener('blur', blurHandler, true);
      modal.removeEventListener('input', inputHandler);
    });
  }

  private attachLivePreview(element: HTMLElement): void {
    if (!this.onPreview) return;
    const handler = (): void => {
      if (this.isUpdating) return;
      this.onPreview?.();
    };
    const inputs = element.querySelectorAll<HTMLElement>('input, select');
    for (const input of inputs) {
      if (input instanceof HTMLInputElement && input.type === 'number') {
        input.addEventListener('input', handler);
      } else {
        input.addEventListener('change', handler);
      }
    }

    // Font-specific handlers: update font preview box on font-related changes
    const fontPreviewEl = element.querySelector<HTMLElement>(
      '.yt-chat-overlay-settings-font-preview-text'
    );
    if (fontPreviewEl) {
      // Listen for fontSize number input changes
      const fontSizeInput = element.querySelector<HTMLInputElement>('input[name="fontSize"]');
      if (fontSizeInput) {
        fontSizeInput.addEventListener('input', () => {
          fontPreviewEl.style.fontSize = `${fontSizeInput.value}px`;
        });
      }

      // Listen for weight toggle changes
      const weightToggle = element.querySelector<HTMLElement>(
        '.yt-chat-overlay-settings-weight-toggle'
      );
      if (weightToggle) {
        weightToggle.addEventListener('change', () => {
          const activeBtn = weightToggle.querySelector<HTMLButtonElement>(
            '.yt-chat-overlay-settings-weight-toggle-btn.active'
          );
          if (activeBtn?.dataset.value) {
            fontPreviewEl.style.fontWeight = activeBtn.dataset.value === 'bold' ? '700' : '400';
          }
        });
      }

      // Listen for font chips changes
      const chipsWrapper = element.querySelector<HTMLElement>(
        '.yt-chat-overlay-settings-font-chips-wrapper'
      );
      if (chipsWrapper) {
        chipsWrapper.addEventListener('change', () => {
          const hiddenInput = chipsWrapper.querySelector<HTMLInputElement>(
            '.yt-chat-overlay-settings-font-value'
          );
          if (hiddenInput?.value) {
            fontPreviewEl.style.fontFamily = hiddenInput.value;
          }
        });
      }
    }
  }

  // ── Modal content factory ──────────────────────────────────────────────

  createModalContent(): Node[] {
    const panes = PANES.map((pane) => this.buildPane(pane));
    for (const pane of panes) {
      this.attachLivePreview(pane);
    }
    return [createHeader(), createTabs(), ...panes, createActions()];
  }

  private buildPane(def: PaneDef): HTMLDivElement {
    const pane = domDiv('yt-chat-overlay-settings-pane');
    pane.id = `pane-${def.id}`;
    pane.dataset.pane = def.id;
    pane.setAttribute('role', 'tabpanel');
    pane.setAttribute('aria-labelledby', `tab-${def.id}`);
    if (def.id !== 'comments') pane.hidden = true;

    // Translation tab: show unsupported message when browser lacks Translator API.
    if (def.id === 'translation' && !TranslationService.isSupported()) {
      const msg = domDiv('yt-chat-overlay-settings-unsupported');
      msg.textContent = t(
        'Translation requires a browser with built-in AI. Use Chrome 138+ or Edge 143+ Canary.'
      );
      pane.appendChild(msg);
      return pane;
    }

    for (const section of def.sections) {
      const authorGridField = section.fields.find(
        (f): f is AuthorGridField => f.type === 'author-grid'
      );
      if (authorGridField) {
        pane.appendChild(this.buildAuthorGrid());
        continue;
      }
      if (section.fields.length === 0) continue;

      if (section.title) {
        const secEl = domSection(t(section.title));
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
        return createEnabledField(def.title);
      case 'checkbox':
        return createCheckboxField(def.label, this.resolveKey(def), def.title);
      case 'number': {
        const inputId = nextFieldId(`number-${this.resolveKey(def)}`);
        const input = domInput({ type: 'number', name: this.resolveKey(def) });
        input.id = inputId;
        input.required = true;
        input.setAttribute('aria-required', 'true');
        applyNumberInputAttributes(
          input,
          def.key as RootScalarSettingKey | Exclude<OutlineSettingKey, 'enabled'>
        );
        if (def.title) input.title = t(def.title);
        return domField(t(def.label), input, inputId);
      }
      case 'range': {
        const container = domDiv('yt-chat-overlay-settings-range');
        const isOutline = def.modifier === 'outline' && isOutlineNumericKey(def.key);
        const limits = isOutline ? resolveOutlineLimits(def.key) : resolveLimits(def.key);
        const scale = isOutline
          ? getOutlineDisplayScale(def.key)
          : getRootDisplayMeta(def.key as RootScalarSettingKey).scale || 1;

        const sliderId = nextFieldId(`range-${this.resolveKey(def)}`);
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.id = sliderId;
        slider.name = `${this.resolveKey(def)}-slider`;
        slider.autocomplete = 'off';
        slider.min = String(limits.min * scale);
        slider.max = String(limits.max * scale);
        slider.step = String(limits.step * scale);
        slider.classList.add('yt-chat-overlay-settings-range-slider');
        // ARIA attributes for accessibility
        slider.setAttribute('aria-valuemin', String(limits.min * scale));
        slider.setAttribute('aria-valuemax', String(limits.max * scale));
        slider.setAttribute('aria-valuenow', String(limits.min * scale));
        const displayUnit = getRangeUnit(def.key);
        const formatValue = (v: number): string => (displayUnit ? `${v} ${displayUnit}` : `${v} `);
        slider.setAttribute('aria-valuetext', formatValue(limits.min * scale));

        const rangeValueId = `range-value-${this.resolveKey(def)}`;
        const numberInput = domInput({ type: 'number', name: this.resolveKey(def) });
        numberInput.id = rangeValueId;
        applyNumberInputAttributes(numberInput, def.key as RootScalarSettingKey);
        numberInput.classList.add('yt-chat-overlay-settings-range-number');
        numberInput.setAttribute('aria-label', t(def.label));
        slider.setAttribute('aria-describedby', rangeValueId);
        if (def.title) {
          numberInput.title = t(def.title);
          slider.title = t(def.title);
        }

        // Update aria-valuenow and aria-valuetext when slider changes
        slider.addEventListener('input', () => {
          const val = parseFloat(slider.value);
          slider.setAttribute('aria-valuenow', slider.value);
          slider.setAttribute('aria-valuetext', formatValue(val));
          numberInput.value = slider.value;
        });
        numberInput.addEventListener('input', () => {
          slider.value = numberInput.value;
          const val = parseFloat(numberInput.value);
          slider.setAttribute('aria-valuenow', numberInput.value);
          slider.setAttribute(
            'aria-valuetext',
            Number.isFinite(val) ? formatValue(val) : numberInput.value
          );
        });

        container.appendChild(domField(t(def.label), slider, sliderId));
        container.appendChild(numberInput);
        return container;
      }
      case 'select': {
        const selectId = nextFieldId(`select-${this.resolveKey(def)}`);
        const select = document.createElement('select');
        select.name = this.resolveKey(def);
        select.id = selectId;
        select.autocomplete = 'off';
        if (def.title) select.title = t(def.title);
        for (const [value, label] of def.options) {
          const opt = document.createElement('option');
          opt.value = value;
          opt.textContent = t(label);
          select.appendChild(opt);
        }
        return domField(t(def.label), select, selectId);
      }
      case 'text': {
        const inputId = nextFieldId(`text-${this.resolveKey(def)}`);
        const input = domInput({ type: 'text', name: this.resolveKey(def) });
        input.id = inputId;
        input.required = true;
        input.setAttribute('aria-required', 'true');
        if (def.title) input.title = t(def.title);
        if (def.placeholder) input.placeholder = t(def.placeholder);

        const field = domField(t(def.label), input, inputId);

        // Append <datalist> for autocomplete suggestions when provided
        if (def.suggestions && def.suggestions.length > 0) {
          const datalistId = `${inputId}-list`;
          input.setAttribute('list', datalistId);
          const datalist = document.createElement('datalist');
          datalist.id = datalistId;
          for (const suggestion of def.suggestions) {
            const opt = document.createElement('option');
            opt.value = suggestion;
            datalist.appendChild(opt);
          }
          field.appendChild(datalist);
        }

        return field;
      }
      case 'font-preview':
        return this.buildFontPreview(def);
      case 'weight-toggle': {
        const field = this.buildWeightToggle(def);
        field.classList.add('yt-chat-overlay-settings-field--top-align');
        return field;
      }
      case 'font-chips': {
        const field = this.buildFontChips(def);
        field.classList.add('yt-chat-overlay-settings-field--top-align');
        return field;
      }
      default:
        throw new Error('Unhandled field type');
    }
  }

  private resolveKey(def: { key: string; modifier?: string }): string {
    return def.modifier ? `${def.modifier}-${def.key}` : def.key;
  }

  // ── Font preview builder ─────────────────────────────────────────────────

  private buildFontPreview(_def: FontPreviewField): HTMLDivElement {
    const container = domDiv('yt-chat-overlay-settings-font-preview');
    const previewText = document.createElement('span');
    previewText.className = 'yt-chat-overlay-settings-font-preview-text';
    previewText.textContent = 'The quick brown fox jumped over the lazy dog. 안녕하세요 こんにちは';
    container.appendChild(previewText);
    return container;
  }

  // ── Weight toggle builder ────────────────────────────────────────────────

  private buildWeightToggle(def: WeightToggleField): HTMLElement {
    const resolvedKey = this.resolveKey(def);
    const container = domDiv('yt-chat-overlay-settings-weight-toggle');
    container.dataset.key = resolvedKey;

    for (const [value, label] of def.options) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'yt-chat-overlay-settings-weight-toggle-btn';
      btn.dataset.value = value;
      btn.textContent = t(label);
      btn.addEventListener('click', () => {
        container.querySelectorAll('.yt-chat-overlay-settings-weight-toggle-btn').forEach((b) => {
          b.classList.remove('active');
        });
        btn.classList.add('active');
        // Fire change event for live preview
        container.dispatchEvent(new Event('change', { bubbles: true }));
      });
      container.appendChild(btn);
    }

    return domField(t(def.label), container);
  }

  // ── Font chips builder ───────────────────────────────────────────────────

  private buildFontChips(def: FontChipsField): HTMLElement {
    const resolvedKey = this.resolveKey(def);
    const container = domDiv('yt-chat-overlay-settings-font-chips-wrapper');

    // Chips
    const chipsContainer = domDiv('yt-chat-overlay-settings-font-chips');
    for (const suggestion of def.suggestions) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'yt-chat-overlay-settings-font-chip';
      chip.setAttribute('aria-pressed', 'false');
      chip.dataset.value = suggestion;
      chip.textContent = this.fontChipLabel(suggestion);
      chip.addEventListener('click', () => {
        chipsContainer.querySelectorAll('.yt-chat-overlay-settings-font-chip').forEach((c) => {
          c.classList.remove('active');
          c.setAttribute('aria-pressed', 'false');
        });
        chip.classList.add('active');
        chip.setAttribute('aria-pressed', 'true');
        // Clear custom input
        const customInput = container.querySelector<HTMLInputElement>(
          '.yt-chat-overlay-settings-font-custom-input'
        );
        if (customInput) customInput.value = '';
        // Sync hidden input value for form collection
        const hiddenInput = container.querySelector<HTMLInputElement>(
          '.yt-chat-overlay-settings-font-value'
        );
        if (hiddenInput) hiddenInput.value = suggestion;
        container.dispatchEvent(new Event('change', { bubbles: true }));
      });
      chipsContainer.appendChild(chip);
    }
    container.appendChild(chipsContainer);

    // Custom font input
    const customRow = domDiv('yt-chat-overlay-settings-font-custom-row');
    const customInputId = nextFieldId(`font-custom-${this.resolveKey(def)}`);
    const customInput = document.createElement('input');
    customInput.type = 'text';
    customInput.id = customInputId;
    customInput.autocomplete = 'off';
    customInput.className = 'yt-chat-overlay-settings-font-custom-input';
    customInput.placeholder = t('danmaku.fontCustom');
    customInput.addEventListener('input', () => {
      // Deactivate all chips when custom input is used
      chipsContainer.querySelectorAll('.yt-chat-overlay-settings-font-chip').forEach((c) => {
        c.classList.remove('active');
        c.setAttribute('aria-pressed', 'false');
      });
      const hiddenInput = container.querySelector<HTMLInputElement>(
        '.yt-chat-overlay-settings-font-value'
      );
      if (hiddenInput) hiddenInput.value = customInput.value;
      container.dispatchEvent(new Event('change', { bubbles: true }));
    });
    customRow.appendChild(customInput);

    // Hidden input for form collection
    const hiddenInput = document.createElement('input');
    hiddenInput.type = 'hidden';
    hiddenInput.name = resolvedKey;
    hiddenInput.autocomplete = 'off';
    hiddenInput.className = 'yt-chat-overlay-settings-font-value';
    customRow.appendChild(hiddenInput);

    container.appendChild(customRow);

    return domField(t(def.label), container);
  }

  /** Derive a short display label from a CSS font-family value. */
  private fontChipLabel(cssFamily: string): string {
    // Common presets → human-friendly names
    const PRESET_LABELS: Record<string, string> = {
      'system-ui, -apple-system, sans-serif': 'System Default',
      '"Segoe UI", system-ui, sans-serif': 'Segoe UI',
      '"-apple-system", "Helvetica Neue", sans-serif': 'SF / Helvetica',
      '"Roboto", system-ui, sans-serif': 'Roboto',
      '"Noto Sans KR", sans-serif': 'Noto Sans KR',
      '"Noto Sans JP", sans-serif': 'Noto Sans JP',
      '"Noto Sans SC", sans-serif': 'Noto Sans SC',
      '"Noto Sans TC", sans-serif': 'Noto Sans TC',
      '"Malgun Gothic", sans-serif': 'Malgun Gothic',
      '"Microsoft YaHei", sans-serif': 'Microsoft YaHei',
      '"Meiryo", sans-serif': 'Meiryo',
      '"Cascadia Code", "Fira Code", monospace': 'Cascadia Code',
      '"JetBrains Mono", monospace': 'JetBrains Mono',
      '"Source Code Pro", monospace': 'Source Code Pro',
      monospace: 'Monospace',
      'Arial, sans-serif': 'Arial',
      '"Helvetica Neue", Arial, sans-serif': 'Helvetica Neue',
      'Verdana, sans-serif': 'Verdana',
      '"Trebuchet MS", sans-serif': 'Trebuchet MS',
      'sans-serif': 'Sans-serif',
      'Georgia, serif': 'Georgia',
      '"Times New Roman", serif': 'Times New Roman',
      serif: 'Serif',
      '"Comic Sans MS", cursive': 'Comic Sans MS',
      'Impact, sans-serif': 'Impact',
      '"Arial Black", sans-serif': 'Arial Black',
    };
    return PRESET_LABELS[cssFamily] ?? cssFamily;
  }

  private buildAuthorGrid(): HTMLDivElement {
    const section = domDiv('yt-chat-overlay-settings-section');
    const heading = document.createElement('h3');
    heading.className = 'yt-chat-overlay-settings-section-title';
    heading.textContent = t('appearance.authors');
    section.appendChild(heading);

    const fieldset = document.createElement('fieldset');
    fieldset.className = 'yt-chat-overlay-author-grid-fieldset';

    const grid = domDiv('yt-chat-overlay-author-grid');
    grid.setAttribute('role', 'grid');
    grid.setAttribute('aria-label', t('appearance.authors'));

    // Header row
    const headerRow = document.createElement('div');
    headerRow.setAttribute('role', 'row');
    const emptyHeader = document.createElement('span');
    emptyHeader.setAttribute('role', 'gridcell');
    headerRow.appendChild(emptyHeader);
    const nameColorHeader = document.createElement('span');
    nameColorHeader.setAttribute('role', 'gridcell');
    nameColorHeader.setAttribute('scope', 'col');
    nameColorHeader.className = 'yt-chat-overlay-author-grid-header';
    nameColorHeader.textContent = t('appearance.authorsNameColor');
    headerRow.appendChild(nameColorHeader);
    const showNameHeader = document.createElement('span');
    showNameHeader.setAttribute('role', 'gridcell');
    showNameHeader.setAttribute('scope', 'col');
    showNameHeader.className = 'yt-chat-overlay-author-grid-header';
    showNameHeader.textContent = t('appearance.authorsShowName');
    headerRow.appendChild(showNameHeader);
    grid.appendChild(headerRow);

    for (const key of AUTHOR_COLOR_KEYS) {
      const colorId = nextFieldId(`color-${key}`);
      const colorInput = domInput({
        type: 'color',
        name: `color-${key}`,
        className: 'yt-chat-overlay-author-grid-color',
      });
      colorInput.id = colorId;
      const labelKey = key.charAt(0).toUpperCase() + key.slice(1);
      colorInput.setAttribute('aria-label', `${t(labelKey)} ${t('appearance.authorsColor')}`);

      const checkboxId = nextFieldId(`showAuthor-${key}`);
      const checkbox = domGridCheckbox(`showAuthor-${key}`, checkboxId);
      checkbox.setAttribute('aria-label', `${t('appearance.authorsShow')} ${t(labelKey)}`);

      const label = document.createElement('label');
      label.className = 'yt-chat-overlay-author-grid-label';
      label.htmlFor = colorId;
      label.textContent = t(labelKey);

      const row = document.createElement('div');
      row.setAttribute('role', 'row');
      const labelCell = document.createElement('span');
      labelCell.setAttribute('role', 'gridcell');
      labelCell.appendChild(label);
      const colorCell = document.createElement('span');
      colorCell.setAttribute('role', 'gridcell');
      colorCell.appendChild(colorInput);
      const checkboxCell = document.createElement('span');
      checkboxCell.setAttribute('role', 'gridcell');
      checkboxCell.appendChild(checkbox);
      row.append(labelCell, colorCell, checkboxCell);
      grid.appendChild(row);
    }

    // SuperChat row
    const superChatCheckboxId = nextFieldId('showAuthor-superChat');
    const superChatCheckbox = domGridCheckbox('showAuthor-superChat', superChatCheckboxId);
    superChatCheckbox.setAttribute(
      'aria-label',
      `${t('appearance.authorsShow')} ${t('appearance.authorsSuperchat')}`
    );

    const superChatLabel = document.createElement('label');
    superChatLabel.className = 'yt-chat-overlay-author-grid-label';
    superChatLabel.htmlFor = superChatCheckboxId;
    superChatLabel.textContent = t('appearance.authorsSuperchat');

    const superChatRow = document.createElement('div');
    superChatRow.setAttribute('role', 'row');
    const superChatLabelCell = document.createElement('span');
    superChatLabelCell.setAttribute('role', 'gridcell');
    superChatLabelCell.appendChild(superChatLabel);
    const superChatPlaceholder = document.createElement('span');
    superChatPlaceholder.setAttribute('role', 'gridcell');
    superChatPlaceholder.className = 'yt-chat-overlay-author-grid-color-superchat';
    superChatRow.appendChild(superChatLabelCell);
    superChatRow.appendChild(superChatPlaceholder);
    const superChatCheckboxCell = document.createElement('span');
    superChatCheckboxCell.setAttribute('role', 'gridcell');
    superChatCheckboxCell.appendChild(superChatCheckbox);
    superChatRow.appendChild(superChatCheckboxCell);
    grid.appendChild(superChatRow);

    fieldset.appendChild(grid);
    section.appendChild(fieldset);
    return section;
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
        const rawKey = el.name.slice('outline-'.length);
        const key = rawKey as keyof typeof settings.outline;
        const value = settings.outline[key];
        if (el instanceof HTMLInputElement && el.type === 'checkbox') {
          el.checked = Boolean(value);
        } else {
          const numericKey = isOutlineNumericKey(rawKey) ? rawKey : null;
          if (numericKey) {
            const scale = getOutlineDisplayScale(numericKey);
            const displayValue = (value as number) * scale;
            el.value = String(scale > 1 ? Math.round(displayValue) : displayValue);
            // Sync the companion range slider for outline fields
            if (el.name) {
              const slider = this.modal.querySelector<HTMLInputElement>(
                `input[type="range"][name="${el.name}-slider"]`
              );
              if (slider) {
                slider.value = el.value;
                // Sync ARIA attributes on programmatic update (cross-tab sync / reopen).
                slider.setAttribute('aria-valuenow', slider.value);
              }
            }
          }
        }
        continue;
      }

      // Color fields
      if (el.name.startsWith('color-')) {
        const key = el.name.slice('color-'.length) as keyof typeof settings.colors;
        el.value = settings.colors[key];
        continue;
      }

      // Author visibility fields
      if (el.name.startsWith('showAuthor-')) {
        const key = el.name.slice('showAuthor-'.length) as keyof typeof settings.showAuthor;
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

      // Also sync range slider if present
      if (el.name) {
        const slider = this.modal.querySelector<HTMLInputElement>(
          `input[type="range"][name="${el.name}-slider"]`
        );
        if (slider) {
          slider.value = el.value;
          slider.setAttribute('aria-valuenow', slider.value);
        }
      }
    }

    this.syncMinTextLengthState();
    this.populateFontPreview(settings);
    this.populateWeightToggle(settings);
    this.populateFontChips(settings);
    this.isUpdating = false;
  }

  private populateFontPreview(settings: Readonly<OverlaySettings>): void {
    if (!this.modal) return;
    const previewEl = this.modal.querySelector<HTMLElement>(
      '.yt-chat-overlay-settings-font-preview-text'
    );
    if (!previewEl) return;
    previewEl.style.fontSize = `${settings.fontSize}px`;
    previewEl.style.fontWeight = settings.fontWeight === 'bold' ? '700' : '400';
    previewEl.style.fontFamily = settings.fontFamily;
  }

  private populateWeightToggle(settings: Readonly<OverlaySettings>): void {
    if (!this.modal) return;
    const container = this.modal.querySelector<HTMLElement>(
      '.yt-chat-overlay-settings-weight-toggle'
    );
    if (!container) return;
    const buttons = container.querySelectorAll<HTMLButtonElement>(
      '.yt-chat-overlay-settings-weight-toggle-btn'
    );
    for (const btn of buttons) {
      if (btn.dataset.value === settings.fontWeight) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    }
  }

  private populateFontChips(settings: Readonly<OverlaySettings>): void {
    if (!this.modal) return;
    const chipsContainer = this.modal.querySelector<HTMLElement>(
      '.yt-chat-overlay-settings-font-chips'
    );
    const customInput = this.modal.querySelector<HTMLInputElement>(
      '.yt-chat-overlay-settings-font-custom-input'
    );
    const hiddenInput = this.modal.querySelector<HTMLInputElement>(
      '.yt-chat-overlay-settings-font-value'
    );

    const family = settings.fontFamily;

    // Try matching a chip
    let matched = false;
    if (chipsContainer) {
      const chips = chipsContainer.querySelectorAll<HTMLElement>(
        '.yt-chat-overlay-settings-font-chip'
      );
      for (const chip of chips) {
        if (chip.dataset.value === family) {
          chip.classList.add('active');
          chip.setAttribute('aria-pressed', 'true');
          matched = true;
        } else {
          chip.classList.remove('active');
          chip.setAttribute('aria-pressed', 'false');
        }
      }
    }

    // If no chip matched, use custom input
    if (customInput && !matched) {
      customInput.value = family;
    }
    if (hiddenInput) {
      hiddenInput.value = family;
    }
  }

  syncMinTextLengthState(): void {
    if (!this.modal) return;
    const allowShort = this.modal.querySelector<HTMLInputElement>(
      'input[name="allowShortTextMessages"]'
    );
    const minText = this.modal.querySelector<HTMLInputElement>('input[name="minTextLength"]');
    if (allowShort && minText) {
      const isDisabled = allowShort.checked;
      minText.disabled = isDisabled;
      if (isDisabled) {
        minText.setAttribute('aria-disabled', 'true');
      } else {
        minText.removeAttribute('aria-disabled');
      }

      // Add/remove disabled-field helper text (search by input name, not parentElement)
      const existingHint = minText.name
        ? this.modal.querySelector<HTMLElement>(
            `.yt-chat-overlay-settings-field-hint[data-for="${minText.name}"]`
          )
        : null;
      if (isDisabled) {
        if (!existingHint) {
          const hint = document.createElement('span');
          hint.className = 'yt-chat-overlay-settings-field-hint';
          if (minText.name) hint.dataset.for = minText.name;
          hint.textContent = t('format.shortMessagesShown');
          minText.insertAdjacentElement('afterend', hint);
        }
      } else {
        existingHint?.remove();
      }
    }
  }

  // ── Form collection (schema-driven) ────────────────────────────────────

  collectSettings(): OverlaySettings {
    const partial: Record<string, unknown> = {};
    if (!this.modal) return cloneSettings(this.getSettings());

    // Exclude range sliders — they duplicate number inputs and produce spurious keys
    const els = this.modal.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      'input:not([type="range"]), select'
    );
    for (const el of els) {
      if (!el.name) continue;

      if (el.name.startsWith('outline-')) {
        const rawKey = el.name.slice('outline-'.length);
        const key = rawKey as OutlineSettingKey;
        if (key === 'enabled') {
          patchOutline(partial as Record<string, unknown>, {
            enabled: (el as HTMLInputElement).checked,
          });
        } else {
          const numericKey = isOutlineNumericKey(rawKey) ? rawKey : null;
          if (!numericKey) continue;
          patchOutline(partial as Record<string, unknown>, {
            [key]: normalizeOutlineNumericInputValue(
              numericKey,
              el.value,
              this.getSettings().outline[key]
            ),
          });
        }
        continue;
      }

      if (el.name.startsWith('color-')) {
        if (!partial.colors) partial.colors = {};
        (partial.colors as Record<string, string>)[el.name.slice('color-'.length)] = el.value;
        continue;
      }

      if (el.name.startsWith('showAuthor-')) {
        if (!partial.showAuthor) partial.showAuthor = {};
        (partial.showAuthor as Record<string, boolean>)[el.name.slice('showAuthor-'.length)] = (
          el as HTMLInputElement
        ).checked;
        continue;
      }

      const scalarKey = el.name as keyof OverlaySettings;
      if (el instanceof HTMLInputElement) {
        if (el.type === 'checkbox') {
          partial[scalarKey] = el.checked;
        } else if (el.type === 'number') {
          const clamped = normalizeRootNumericInputValue(
            scalarKey as RootNumericSettingKey,
            el.value,
            this.getSettings()[scalarKey] as number
          );
          partial[scalarKey] = clamped;
          // Show validation feedback when value is clamped
          const rawNum = Number(el.value);
          if (Number.isFinite(rawNum)) {
            const { min, max } = getNumericInputAttributes(scalarKey as RootScalarSettingKey);
            if (rawNum < min) {
              this.showFieldError(el, `${t('format.valueAdjusted')} ${min}`);
            } else if (rawNum > max) {
              this.showFieldError(el, `${t('format.valueAdjusted')} ${max}`);
            }
          }
        } else {
          partial[scalarKey] = el.value;
        }
      } else if (el instanceof HTMLSelectElement) {
        partial[scalarKey] = el.value;
      }
    }

    // Collect weight toggle value (buttons, not form elements)
    const weightToggleEl = this.modal.querySelector<HTMLElement>(
      '.yt-chat-overlay-settings-weight-toggle'
    );
    if (weightToggleEl) {
      const activeBtn = weightToggleEl.querySelector<HTMLButtonElement>(
        '.yt-chat-overlay-settings-weight-toggle-btn.active'
      );
      if (activeBtn?.dataset.value) {
        partial.fontWeight = activeBtn.dataset.value;
      }
    }

    return cloneSettings({ ...this.getSettings(), ...partial } as OverlaySettings);
  }

  // ── Validation error feedback ───────────────────────────────────────────

  private showFieldError(input: HTMLInputElement, message: string): void {
    if (!this.modal) return;
    // Remove any existing error (search by input name, not parentElement)
    if (input.name) {
      this.modal
        .querySelectorAll(`.yt-chat-overlay-settings-field-error[data-for="${input.name}"]`)
        .forEach((el) => {
          el.remove();
        });
    }

    const errorId = nextFieldId(`error-${input.name}`);
    const error = document.createElement('span');
    error.className = 'yt-chat-overlay-settings-field-error';
    error.id = errorId;
    error.setAttribute('role', 'alert');
    error.setAttribute('aria-live', 'polite');
    if (input.name) error.dataset.for = input.name;
    error.textContent = message;
    input.insertAdjacentElement('afterend', error);
    // Link error to input for screen readers
    input.setAttribute('aria-errormessage', errorId);
    input.setAttribute('aria-invalid', 'true');

    // Auto-dismiss after 3s
    const ERROR_DISMISS_MS = 3000;
    const timer = setTimeout(() => {
      error.remove();
      // Clear aria-errormessage when error is dismissed
      if (input.getAttribute('aria-errormessage') === errorId) {
        input.removeAttribute('aria-errormessage');
        input.setAttribute('aria-invalid', 'false');
      }
      this.errorDismissTimeouts = this.errorDismissTimeouts.filter((t) => t !== timer);
    }, ERROR_DISMISS_MS);
    this.errorDismissTimeouts.push(timer);
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
