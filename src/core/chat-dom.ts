export type ChatSelectorSurface = 'frame' | 'iframe' | 'iframe-items' | 'container' | 'toggle';

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

const CHAT_FRAME_DESCRIPTORS = [
  {
    selector: 'ytd-live-chat-frame#chat',
    purpose: 'live chat frame host',
    surface: 'frame',
  },
  { selector: 'ytd-live-chat-frame', purpose: 'frame fallback', surface: 'frame' },
] as const satisfies readonly ChatSelectorDescriptor[];

const CHAT_IFRAME_DESCRIPTORS = [
  {
    selector: 'iframe[src*="live_chat"]',
    purpose: 'live chat iframe',
    surface: 'iframe',
  },
  { selector: 'iframe#chatframe', purpose: 'chatframe id', surface: 'iframe' },
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
    selector: 'ytd-toggle-button-renderer button[aria-label*="chat" i]',
    purpose: 'chat toggle button',
    surface: 'toggle',
  },
  {
    selector: 'ytd-toggle-button-renderer button[aria-label*="채팅" i]',
    purpose: 'localized chat toggle button',
    surface: 'toggle',
  },
  {
    selector: 'button#show-hide-button',
    purpose: 'show/hide chat button',
    surface: 'toggle',
  },
] as const satisfies readonly ChatSelectorDescriptor[];

const findChatSelectorMatch = <T extends Element>(
  descriptors: readonly ChatSelectorDescriptor[],
  options: ChatMatchOptions<T> = {}
): ChatSelectorMatch<T> | null => {
  const { root = document, predicate } = options;

  for (const descriptor of descriptors) {
    const element = root.querySelector<T>(descriptor.selector);
    if (!element) {
      continue;
    }

    if (predicate && !predicate(element)) {
      continue;
    }

    return { element, descriptor };
  }

  return null;
};

export const describeChatSelector = (descriptor: ChatSelectorDescriptor): string =>
  `${descriptor.surface}:${descriptor.purpose} (${descriptor.selector})`;

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
    predicate: (element) => !element.disabled,
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
