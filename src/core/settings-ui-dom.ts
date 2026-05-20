import { PANES } from '@core/settings-ui-panes';

// ── DOM helper functions ─────────────────────────────────────────────────────

export function domDiv(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

export function domInput(props: {
  type: string;
  name: string;
  className?: string;
}): HTMLInputElement {
  const el = document.createElement('input');
  el.type = props.type;
  el.name = props.name;
  if (props.className) el.className = props.className;
  return el;
}

export function domField(labelText: string, control: HTMLElement): HTMLLabelElement {
  const label = document.createElement('label');
  label.className = 'yt-chat-overlay-settings-field';
  const text = document.createElement('span');
  text.textContent = labelText;
  label.append(text, control);
  return label;
}

export function domSection(titleText: string): HTMLDivElement {
  const sec = domDiv('yt-chat-overlay-settings-section');
  const title = domDiv('yt-chat-overlay-settings-section-title');
  title.textContent = titleText;
  sec.appendChild(title);
  return sec;
}

export function domGridCheckbox(name: string): HTMLInputElement {
  const el = domInput({ type: 'checkbox', name });
  el.className = 'yt-chat-overlay-author-grid-checkbox';
  return el;
}

export function domGridHeader(text: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = 'yt-chat-overlay-author-grid-header';
  el.textContent = text;
  return el;
}

export function domGridLabel(text: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = 'yt-chat-overlay-author-grid-label';
  el.textContent = text;
  return el;
}

// ── Modal sub-structure factories ────────────────────────────────────────────

const TITLE_ID = 'yt-chat-overlay-settings-title';

export function createHeader(): HTMLDivElement {
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

export function createTabs(): HTMLElement {
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

export function createActions(): HTMLDivElement {
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

export function createEnabledField(): HTMLLabelElement {
  const label = document.createElement('label');
  label.className = 'yt-chat-overlay-settings-enabled';
  const text = document.createElement('span');
  text.textContent = 'Overlay Enabled';
  const input = domInput({ type: 'checkbox', name: 'enabled' });
  label.append(text, input);
  return label;
}

export function createCheckboxField(
  labelText: string,
  name: string,
  title?: string
): HTMLLabelElement {
  const input = domInput({ type: 'checkbox', name });
  if (title) input.title = title;
  return domField(labelText, input);
}
