import type { OverlaySettings } from '@app-types';
import {
  AUTHOR_COLOR_KEYS,
  cloneSettings,
  getRootDisplayMeta,
  OUTLINE_NUMERIC_KEYS,
  type OutlineSettingKey,
  type RootNumericSettingKey,
  type RootScalarSettingKey,
  resolveLimits,
} from '@core/settings-schema';
import { PANES } from '@core/settings-ui-panes';
import type { FieldDef, PaneDef } from '@core/settings-ui-types';

const STYLE_ID = 'yt-chat-overlay-settings-style';
export const BUTTON_ID = 'yt-chat-overlay-settings-button';
export const BACKDROP_ID = 'yt-chat-overlay-settings-backdrop';
export { STYLE_ID };

const ROOT_ROUNDED_KEYS = new Set<RootScalarSettingKey>([
  'maxConcurrentMessages',
  'minTextLength',
  'laneSpacing',
  'authorRateLimitMaxMessages',
  'superChatMaxBodyLines',
  'membershipMaxBodyLines',
]);

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
  title.textContent = 'Chat Overlay';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'yt-chat-overlay-settings-close';
  closeButton.setAttribute('aria-label', 'Close settings');
  closeButton.textContent = 'x';
  header.append(title, closeButton);
  return header;
}

function createTabs(): HTMLElement {
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

function createActions(): HTMLDivElement {
  const actions = domDiv('yt-chat-overlay-settings-actions');
  for (const [action, label] of [
    ['reset', 'Reset'],
    ['export', 'Export'],
    ['import', 'Import'],
    ['close', 'Close'],
  ] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.action = action;
    button.textContent = label;
    actions.appendChild(button);
  }
  return actions;
}

function createEnabledField(): HTMLLabelElement {
  const label = document.createElement('label');
  label.className = 'yt-chat-overlay-settings-enabled';
  const text = document.createElement('span');
  text.textContent = 'Overlay Enabled';
  const input = domInput({ type: 'checkbox', name: 'enabled' });
  label.append(text, input);
  return label;
}

function createCheckboxField(labelText: string, name: string, title?: string): HTMLLabelElement {
  const input = domInput({ type: 'checkbox', name });
  if (title) input.title = title;
  return domField(labelText, input);
}

// ── UI value formatting ──────────────────────────────────────────────────────

const scaleUiValue = (value: number, scale: number): number =>
  Math.round(value * scale * 1e4) / 1e4;

const getRootScale = (key: RootScalarSettingKey): number => getRootDisplayMeta(key).scale;

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
    ROOT_ROUNDED_KEYS.has(key),
    getRootScale(key)
  );
};

const normalizeOutlineNumericInputValue = (
  key: Exclude<OutlineSettingKey, 'enabled'>,
  value: unknown,
  fallback: number
): number => {
  return normalizeNumericValue(value, fallback, resolveLimits(key), false);
};

const formatOutlineNumericSettingForInput = (
  key: Exclude<OutlineSettingKey, 'enabled'>,
  value: number
): string | number => {
  return formatRootNumericSettingForInput(key as unknown as RootScalarSettingKey, value);
};

const getNumericInputAttributes = (
  key: RootScalarSettingKey | Exclude<OutlineSettingKey, 'enabled'>
): Readonly<{ min: number; max: number; step: number }> => {
  const limits = resolveLimits(key);
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
    return [createHeader(), createTabs(), ...panes, createActions()];
  }

  private buildPane(def: PaneDef): HTMLDivElement {
    const pane = domDiv('yt-chat-overlay-settings-pane');
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
        const secEl = domSection(section.title);
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
        return createEnabledField();
      case 'checkbox':
        return createCheckboxField(def.label, def.key, def.title);
      case 'number': {
        const input = domInput({ type: 'number', name: this.resolveKey(def) });
        applyNumberInputAttributes(
          input,
          def.key as RootScalarSettingKey | Exclude<OutlineSettingKey, 'enabled'>
        );
        if (def.title) input.title = def.title;
        return domField(def.label, input);
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
        return domField(def.label, select);
      }
      case 'text': {
        const input = domInput({ type: 'text', name: def.key });
        if (def.title) input.title = def.title;
        if (def.placeholder) input.placeholder = def.placeholder;
        return domField(def.label, input);
      }
      default:
        throw new Error('Unhandled field type');
    }
  }

  private resolveKey(def: { key: string; modifier?: string }): string {
    return def.modifier ? `${def.modifier}-${def.key}` : def.key;
  }

  private buildAuthorGrid(): HTMLDivElement {
    const section = domSection('Author Colors & Visibility');
    const grid = domDiv('yt-chat-overlay-author-grid');
    grid.append(document.createElement('span'), domGridHeader('Color'), domGridHeader('Show'));

    for (const key of AUTHOR_COLOR_KEYS) {
      grid.append(
        domGridLabel(key.charAt(0).toUpperCase() + key.slice(1)),
        domInput({
          type: 'color',
          name: `color-${key}`,
          className: 'yt-chat-overlay-author-grid-color',
        }),
        domGridCheckbox(`showAuthor-${key}`)
      );
    }

    grid.append(
      domGridLabel('SuperChat'),
      document.createElement('span'),
      domGridCheckbox('showAuthor-superChat')
    );

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
        const rawKey = el.name.slice(8);
        const key = rawKey as keyof typeof settings.outline;
        const value = settings.outline[key];
        if (el instanceof HTMLInputElement && el.type === 'checkbox') {
          el.checked = Boolean(value);
        } else {
          const numericKey = isOutlineNumericKey(rawKey) ? rawKey : null;
          if (numericKey) {
            el.value = formatOutlineNumericSettingForInput(numericKey, value as number) as string;
          }
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
        const rawKey = el.name.slice(8);
        const key = rawKey as OutlineSettingKey;
        if (key === 'enabled') {
          partial.outline = {
            ...((partial.outline as Record<string, unknown>) ?? {}),
            enabled: (el as HTMLInputElement).checked,
          };
        } else {
          const numericKey = isOutlineNumericKey(rawKey) ? rawKey : null;
          if (!numericKey) continue;
          partial.outline = {
            ...((partial.outline as Record<string, unknown>) ?? {}),
            [key]: normalizeOutlineNumericInputValue(
              numericKey,
              el.value,
              this.getSettings().outline[key]
            ),
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
