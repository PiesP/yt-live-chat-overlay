export type ChatSelectorSurface =
  | 'host'
  | 'frame'
  | 'iframe'
  | 'iframe-items'
  | 'container'
  | 'toggle';

export interface ChatSelectorDescriptor {
  selector: string;
  purpose: string;
  surface: ChatSelectorSurface;
}

export interface ChatSelectorMatch<T extends Element> {
  element: T;
  descriptor: ChatSelectorDescriptor;
}

interface ChatMatchOptions<T extends Element> {
  predicate?: (element: T) => boolean;
  root?: ParentNode;
}

const CHAT_HOST_DESCRIPTORS = [
  {
    selector: '#chat',
    purpose: 'watch page chat host',
    surface: 'host',
  },
] as const satisfies readonly ChatSelectorDescriptor[];

const CHAT_FRAME_DESCRIPTORS = [
  {
    selector: 'ytd-live-chat-frame#chat',
    purpose: 'live chat frame host',
    surface: 'frame',
  },
  { selector: 'ytd-live-chat-frame', purpose: 'frame fallback', surface: 'frame' },
] as const satisfies readonly ChatSelectorDescriptor[];

const CHAT_IFRAME_DESCRIPTORS = [
  { selector: 'iframe#chatframe', purpose: 'chatframe id', surface: 'iframe' },
  {
    selector: 'ytd-live-chat-frame iframe[src*="live_chat"]',
    purpose: 'live chat iframe inside frame',
    surface: 'iframe',
  },
] as const satisfies readonly ChatSelectorDescriptor[];

const CHAT_IFRAME_ITEM_DESCRIPTORS = [
  {
    selector: '#items.yt-live-chat-item-list-renderer',
    purpose: 'iframe item list',
    surface: 'iframe-items',
  },
  { selector: '#items', purpose: 'iframe items fallback', surface: 'iframe-items' },
] as const satisfies readonly ChatSelectorDescriptor[];

const CHAT_CONTAINER_DESCRIPTORS = [
  {
    selector: '#chat #items.yt-live-chat-item-list-renderer',
    purpose: 'in-page chat items',
    surface: 'container',
  },
  {
    selector: '#chat yt-live-chat-item-list-renderer #items',
    purpose: 'chat host item list',
    surface: 'container',
  },
  {
    selector: '#chat #items',
    purpose: 'chat host items fallback',
    surface: 'container',
  },
  {
    selector: '#items.yt-live-chat-item-list-renderer',
    purpose: 'root item list',
    surface: 'container',
  },
  {
    selector: 'yt-live-chat-item-list-renderer #items',
    purpose: 'nested item list',
    surface: 'container',
  },
] as const satisfies readonly ChatSelectorDescriptor[];

const CHAT_TOGGLE_BUTTON_DESCRIPTORS = [
  {
    selector: 'ytd-live-chat-frame button#show-hide-button',
    purpose: 'live chat frame show/hide toggle',
    surface: 'toggle',
  },
  {
    selector: 'button#show-hide-button',
    purpose: 'show/hide chat button',
    surface: 'toggle',
  },
  {
    selector: '#secondary ytd-toggle-button-renderer button',
    purpose: 'secondary column toggle renderer button',
    surface: 'toggle',
  },
  {
    selector: '#secondary button[aria-controls], #secondary button[aria-expanded]',
    purpose: 'secondary column chat button candidate',
    surface: 'toggle',
  },
] as const satisfies readonly ChatSelectorDescriptor[];

const CHAT_TOGGLE_MARKERS = ['chat', '채팅', 'チャット'] as const;

const normalizeChatToggleText = (value: string | null | undefined): string =>
  value?.replace(/\s+/g, ' ').trim().toLowerCase() ?? '';

const hasChatToggleMarker = (value: string | null | undefined): boolean => {
  const normalized = normalizeChatToggleText(value);
  return normalized.length > 0 && CHAT_TOGGLE_MARKERS.some((marker) => normalized.includes(marker));
};

const isLikelyChatToggleButton = (button: HTMLButtonElement): boolean => {
  if (button.id === 'show-hide-button') {
    return true;
  }

  const ariaControls = normalizeChatToggleText(button.getAttribute('aria-controls'));
  if (ariaControls.includes('chat')) {
    return true;
  }

  const hasChatLabel = [
    button.getAttribute('aria-label'),
    button.getAttribute('title'),
    button.textContent,
  ].some((candidate) => hasChatToggleMarker(candidate));

  if (!hasChatLabel) {
    return false;
  }

  if (button.closest('ytd-live-chat-frame') || button.closest('ytd-toggle-button-renderer')) {
    return true;
  }

  return button.hasAttribute('aria-expanded');
};

const findChatSelectorMatch = <T extends Element>(
  descriptors: readonly ChatSelectorDescriptor[],
  options: ChatMatchOptions<T> = {}
): ChatSelectorMatch<T> | null => {
  const { root = document, predicate } = options;

  for (const descriptor of descriptors) {
    const elements = Array.from(root.querySelectorAll(descriptor.selector)) as T[];
    for (const element of elements) {
      if (predicate && !predicate(element)) {
        continue;
      }

      return { element, descriptor };
    }
  }

  return null;
};

export const describeChatSelector = (descriptor: ChatSelectorDescriptor): string =>
  `${descriptor.surface}:${descriptor.purpose} (${descriptor.selector})`;

export const findChatHostMatch = (): ChatSelectorMatch<HTMLElement> | null =>
  findChatSelectorMatch<HTMLElement>(CHAT_HOST_DESCRIPTORS);

export const findChatFrameMatch = (): ChatSelectorMatch<HTMLElement> | null =>
  findChatSelectorMatch<HTMLElement>(CHAT_FRAME_DESCRIPTORS);

export const findChatIframeMatch = (): ChatSelectorMatch<HTMLIFrameElement> | null =>
  findChatSelectorMatch<HTMLIFrameElement>(CHAT_IFRAME_DESCRIPTORS);

export const findChatIframeItemMatch = (root: ParentNode): ChatSelectorMatch<Element> | null =>
  findChatSelectorMatch<Element>(CHAT_IFRAME_ITEM_DESCRIPTORS, { root });

export const findInPageChatContainerMatch = (): ChatSelectorMatch<Element> | null =>
  findChatSelectorMatch<Element>(CHAT_CONTAINER_DESCRIPTORS);

export const findChatToggleButtonMatch = (): ChatSelectorMatch<HTMLButtonElement> | null =>
  findChatSelectorMatch<HTMLButtonElement>(CHAT_TOGGLE_BUTTON_DESCRIPTORS, {
    predicate: isLikelyChatToggleButton,
  });

export const isChatFrameHidden = (chatFrame: HTMLElement): boolean => {
  if (
    chatFrame.hasAttribute('collapsed') ||
    chatFrame.hasAttribute('hidden') ||
    chatFrame.getAttribute('aria-hidden') === 'true'
  ) {
    return true;
  }

  if (chatFrame.style.display === 'none' || chatFrame.style.visibility === 'hidden') {
    return true;
  }

  if (chatFrame.offsetWidth === 0 || chatFrame.offsetHeight === 0) {
    return true;
  }

  return Boolean(chatFrame.closest('[hidden], [aria-hidden="true"]'));
};
