// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { OverlaySettings } from '@app-types';
import { t } from '@core/i18n';
import { createLogger } from '@core/logging';
import type {
  OutlineSettingKey,
  RootNumericSettingKey,
  RootScalarSettingKey,
} from '@core/settings-schema';
import {
  AUTHOR_COLOR_KEYS,
  cloneSettings,
  getOutlineDisplayScale,
  getRootDisplayMeta,
  OUTLINE_NUMERIC_KEYS,
  resolveLimits,
  resolveOutlineLimits,
} from '@core/settings-schema';
import type { AuthorGridField, FieldDef, PaneDef } from '@core/settings-ui-panes';
import { PANES } from '@core/settings-ui-panes';
import { TranslationService } from '@core/translation-service';

const log = createLogger('SettingsUiForm');

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
  return el;
}

function domField(labelText: string, control: HTMLElement): HTMLLabelElement {
  const label = document.createElement('label');
  label.className = 'yt-chat-overlay-settings-field';
  const text = document.createElement('span');
  text.textContent = labelText;
  label.append(text, control);
  return label;
}

function domSection(titleText: string): HTMLDivElement {
  const sec = domDiv('yt-chat-overlay-settings-section');
  const title = domDiv('yt-chat-overlay-settings-section-title');
  title.textContent = titleText;
  sec.appendChild(title);
  return sec;
}

function domGridCheckbox(name: string): HTMLInputElement {
  const el = domInput({ type: 'checkbox', name });
  el.className = 'yt-chat-overlay-author-grid-checkbox';
  return el;
}

function domGridHeader(text: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = 'yt-chat-overlay-author-grid-header';
  el.textContent = text;
  return el;
}

function domGridLabel(text: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = 'yt-chat-overlay-author-grid-label';
  el.textContent = text;
  return el;
}

// ── Modal sub-structure factories ────────────────────────────────────────────

const TITLE_ID = 'yt-chat-overlay-settings-title';

function createHeader(): HTMLDivElement {
  const header = domDiv('yt-chat-overlay-settings-header');
  const title = document.createElement('div');
  title.id = TITLE_ID;
  title.textContent = t('Chat Overlay');
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'yt-chat-overlay-settings-close';
  closeButton.setAttribute('data-action', 'close');
  closeButton.setAttribute('aria-label', t('Close settings'));
  closeButton.textContent = '\u00D7';
  header.append(title, closeButton);
  return header;
}

function createTabs(): HTMLElement {
  const nav = document.createElement('nav');
  nav.className = 'yt-chat-overlay-settings-tabs';
  nav.setAttribute('role', 'tablist');
  nav.setAttribute('aria-label', t('Settings categories'));

  for (const [index, pane] of PANES.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'yt-chat-overlay-settings-tab';
    button.dataset.tab = pane.id;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(index === 0));
    button.setAttribute('aria-controls', `pane-${pane.id}`);
    button.textContent = t(pane.label);
    if (pane.id === 'comments') button.classList.add('active');
    nav.appendChild(button);
  }

  return nav;
}

export const ACTIONS = ['reset', 'export', 'import', 'close'] as const;
export type ActionType = (typeof ACTIONS)[number];

function createActions(): HTMLDivElement {
  const actions = domDiv('yt-chat-overlay-settings-actions');
  for (const [action, label] of ACTIONS.map(
    (a) => [a, a.charAt(0).toUpperCase() + a.slice(1)] as const
  )) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.action = action;
    button.textContent = t(label);
    actions.appendChild(button);
  }
  return actions;
}

function createEnabledField(title?: string): HTMLLabelElement {
  const label = document.createElement('label');
  label.className = 'yt-chat-overlay-settings-enabled';
  const text = document.createElement('span');
  text.textContent = t('Overlay Enabled');
  const input = domInput({ type: 'checkbox', name: 'enabled' });
  if (title) input.title = t(title);
  label.append(text, input);
  return label;
}

function createCheckboxField(labelText: string, name: string, title?: string): HTMLLabelElement {
  const input = domInput({ type: 'checkbox', name });
  if (title) input.title = t(title);
  return domField(t(labelText), input);
}

// ── UI value formatting ──────────────────────────────────────────────────────

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
  private modal: HTMLDivElement | null = null;
  private isUpdating = false;

  constructor(
    private readonly getSettings: () => Readonly<OverlaySettings>,
    private readonly onPreview?: () => void
  ) {}

  setModal(modal: HTMLDivElement | null): void {
    this.modal = modal;
    if (modal) {
      this.bindNumberInputKeys(modal);
    }
    log.debug('Modal set', { attached: modal !== null });
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
  private bindNumberInputKeys(modal: HTMLDivElement): void {
    modal.addEventListener('keydown', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement) || target.type !== 'number') return;

      const step = parseFloat(target.step || '1');
      if (!step || !Number.isFinite(step)) return;

      let direction = 0;
      if (event.key === 'ArrowUp') direction = 1;
      else if (event.key === 'ArrowDown') direction = -1;
      else return;

      // Without modifiers, let the browser handle native ↑/↓ (±1 step)
      if (!event.shiftKey && !event.ctrlKey && !event.metaKey) return;

      const scale = event.ctrlKey || event.metaKey ? 100 : 10;
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
        const input = domInput({ type: 'number', name: this.resolveKey(def) });
        applyNumberInputAttributes(
          input,
          def.key as RootScalarSettingKey | Exclude<OutlineSettingKey, 'enabled'>
        );
        if (def.title) input.title = t(def.title);
        return domField(t(def.label), input);
      }
      case 'range': {
        const container = domDiv('yt-chat-overlay-settings-range');
        const isOutline = def.modifier === 'outline' && isOutlineNumericKey(def.key);
        const limits = isOutline ? resolveOutlineLimits(def.key) : resolveLimits(def.key);
        const scale = isOutline
          ? getOutlineDisplayScale(def.key)
          : getRootDisplayMeta(def.key as RootScalarSettingKey).scale || 1;

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.name = `${this.resolveKey(def)}-slider`;
        slider.min = String(limits.min * scale);
        slider.max = String(limits.max * scale);
        slider.step = String(limits.step * scale);
        slider.classList.add('yt-chat-overlay-settings-range-slider');

        const numberInput = domInput({ type: 'number', name: this.resolveKey(def) });
        applyNumberInputAttributes(numberInput, def.key as RootScalarSettingKey);
        numberInput.classList.add('yt-chat-overlay-settings-range-number');
        if (def.title) {
          numberInput.title = t(def.title);
          slider.title = t(def.title);
        }

        // Sync: slider → number, number → slider
        slider.addEventListener('input', () => {
          numberInput.value = slider.value;
        });
        numberInput.addEventListener('input', () => {
          slider.value = numberInput.value;
        });

        container.appendChild(domField(t(def.label), slider));
        container.appendChild(numberInput);
        return container;
      }
      case 'select': {
        const select = document.createElement('select');
        select.name = this.resolveKey(def);
        if (def.title) select.title = t(def.title);
        for (const [value, label] of def.options) {
          const opt = document.createElement('option');
          opt.value = value;
          opt.textContent = t(label);
          select.appendChild(opt);
        }
        return domField(t(def.label), select);
      }
      case 'text': {
        const input = domInput({ type: 'text', name: this.resolveKey(def) });
        if (def.title) input.title = t(def.title);
        if (def.placeholder) input.placeholder = t(def.placeholder);
        return domField(t(def.label), input);
      }
      default:
        throw new Error('Unhandled field type');
    }
  }

  private resolveKey(def: { key: string; modifier?: string }): string {
    return def.modifier ? `${def.modifier}-${def.key}` : def.key;
  }

  private buildAuthorGrid(): HTMLDivElement {
    const section = domSection(t('Author Colors & Visibility'));
    const grid = domDiv('yt-chat-overlay-author-grid');
    grid.append(
      document.createElement('span'),
      domGridHeader(t('Name Color')),
      domGridHeader(t('Show Name'))
    );

    for (const key of AUTHOR_COLOR_KEYS) {
      const colorInput = domInput({
        type: 'color',
        name: `color-${key}`,
        className: 'yt-chat-overlay-author-grid-color',
      });
      const labelKey = key.charAt(0).toUpperCase() + key.slice(1);
      colorInput.setAttribute('aria-label', `${t(labelKey)} ${t('Color')}`);

      const checkbox = domGridCheckbox(`showAuthor-${key}`);
      checkbox.setAttribute('aria-label', `${t('Show')} ${t(labelKey)}`);

      grid.append(domGridLabel(t(labelKey)), colorInput, checkbox);
    }

    const superChatCheckbox = domGridCheckbox('showAuthor-superChat');
    superChatCheckbox.setAttribute('aria-label', `${t('Show')} ${t('SuperChat')}`);

    grid.append(domGridLabel(t('SuperChat')), document.createElement('span'), superChatCheckbox);

    section.appendChild(grid);
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
            const slider = el.parentElement?.querySelector<HTMLInputElement>('input[type="range"]');
            if (slider && slider.name === `${el.name}-slider`) {
              slider.value = el.value;
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
      const slider = el.parentElement?.querySelector<HTMLInputElement>('input[type="range"]');
      if (slider && el.name && slider.name === `${el.name}-slider`) {
        slider.value = el.value;
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
      const isDisabled = allowShort.checked;
      minText.disabled = isDisabled;

      // Add/remove disabled-field helper text
      const existingHint = minText.parentElement?.querySelector(
        '.yt-chat-overlay-settings-field-hint'
      );
      if (isDisabled) {
        if (!existingHint) {
          const hint = document.createElement('span');
          hint.className = 'yt-chat-overlay-settings-field-hint';
          hint.textContent = t('Short messages shown regardless of length');
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

    const els = this.modal.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select');
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
              this.showFieldError(el, `${t('Value adjusted to')} ${min}`);
            } else if (rawNum > max) {
              this.showFieldError(el, `${t('Value adjusted to')} ${max}`);
            }
          }
        } else {
          partial[scalarKey] = el.value;
        }
      } else if (el instanceof HTMLSelectElement) {
        partial[scalarKey] = el.value;
      }
    }

    return cloneSettings({ ...this.getSettings(), ...partial } as OverlaySettings);
  }

  // ── Validation error feedback ───────────────────────────────────────────

  private showFieldError(input: HTMLInputElement, message: string): void {
    // Remove any existing error
    const existing = input.parentElement?.querySelector('.yt-chat-overlay-settings-field-error');
    existing?.remove();

    const error = document.createElement('span');
    error.className = 'yt-chat-overlay-settings-field-error';
    error.textContent = message;
    input.insertAdjacentElement('afterend', error);

    // Auto-dismiss after 3s
    const ERROR_DISMISS_MS = 3000;
    setTimeout(() => error.remove(), ERROR_DISMISS_MS);
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
