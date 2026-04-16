import { overlayLog } from '@core/logging';

export type ChatSelectorSurface = 'frame' | 'iframe' | 'iframe-items' | 'container' | 'toggle';

export interface ChatSelectorDescriptor {
  selector: string;
  purpose: string;
  priority: number;
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
    priority: 300,
    surface: 'frame',
  },
  { selector: '#chat', purpose: 'generic chat root', priority: 200, surface: 'frame' },
  { selector: 'ytd-live-chat-frame', purpose: 'frame fallback', priority: 100, surface: 'frame' },
] as const satisfies readonly ChatSelectorDescriptor[];

const CHAT_IFRAME_DESCRIPTORS = [
  {
    selector: 'iframe[src*="live_chat"]',
    purpose: 'live chat iframe',
    priority: 400,
    surface: 'iframe',
  },
  { selector: 'iframe#chatframe', purpose: 'chatframe id', priority: 300, surface: 'iframe' },
  {
    selector: 'ytd-live-chat-frame iframe',
    purpose: 'iframe inside chat frame',
    priority: 200,
    surface: 'iframe',
  },
  { selector: '#chat iframe', purpose: 'iframe under chat root', priority: 100, surface: 'iframe' },
] as const satisfies readonly ChatSelectorDescriptor[];

const CHAT_IFRAME_ITEM_DESCRIPTORS = [
  {
    selector: '#items.yt-live-chat-item-list-renderer',
    purpose: 'specific iframe item list',
    priority: 300,
    surface: 'iframe-items',
  },
  { selector: '#items', purpose: 'iframe items fallback', priority: 200, surface: 'iframe-items' },
  {
    selector: 'yt-live-chat-item-list-renderer #items',
    purpose: 'nested iframe item list',
    priority: 100,
    surface: 'iframe-items',
  },
] as const satisfies readonly ChatSelectorDescriptor[];

const CHAT_CONTAINER_DESCRIPTORS = [
  {
    selector: '#chat #items.yt-live-chat-item-list-renderer',
    purpose: 'specific in-page chat items',
    priority: 700,
    surface: 'container',
  },
  {
    selector: '#items.yt-live-chat-item-list-renderer',
    purpose: 'root item list',
    priority: 600,
    surface: 'container',
  },
  {
    selector: 'yt-live-chat-item-list-renderer #items',
    purpose: 'nested item list',
    priority: 500,
    surface: 'container',
  },
  {
    selector: 'ytd-live-chat-frame #items',
    purpose: 'items under frame host',
    priority: 400,
    surface: 'container',
  },
  {
    selector: 'yt-live-chat-app #items',
    purpose: 'app-root items',
    priority: 300,
    surface: 'container',
  },
  {
    selector: '#chat-container #items',
    purpose: 'panel container items',
    priority: 200,
    surface: 'container',
  },
  {
    selector: '#chat #items',
    purpose: 'chat-root items fallback',
    priority: 100,
    surface: 'container',
  },
  {
    selector: 'ytd-live-chat #items',
    purpose: 'legacy host items',
    priority: 50,
    surface: 'container',
  },
] as const satisfies readonly ChatSelectorDescriptor[];

const CHAT_TOGGLE_BUTTON_DESCRIPTORS = [
  {
    selector: 'ytd-toggle-button-renderer button[aria-label*="chat" i]',
    purpose: 'chat toggle button',
    priority: 700,
    surface: 'toggle',
  },
  {
    selector: 'ytd-toggle-button-renderer button[aria-label*="채팅" i]',
    purpose: 'localized chat toggle button',
    priority: 650,
    surface: 'toggle',
  },
  {
    selector: 'button#show-hide-button',
    purpose: 'show/hide chat button',
    priority: 600,
    surface: 'toggle',
  },
  {
    selector: 'ytd-engagement-panel-title-header-renderer button',
    purpose: 'engagement panel header button',
    priority: 500,
    surface: 'toggle',
  },
  {
    selector: 'ytd-engagement-panel-section-list-renderer button[aria-label*="chat" i]',
    purpose: 'engagement panel list chat button',
    priority: 400,
    surface: 'toggle',
  },
  {
    selector: 'ytd-engagement-panel-section-list-renderer button[aria-label*="채팅" i]',
    purpose: 'localized engagement panel list chat button',
    priority: 350,
    surface: 'toggle',
  },
  {
    selector: 'button:not(#yt-chat-overlay-settings-button)[aria-label*="show chat" i]',
    purpose: 'generic show chat button',
    priority: 200,
    surface: 'toggle',
  },
  {
    selector: 'button:not(#yt-chat-overlay-settings-button)[aria-label*="open chat" i]',
    purpose: 'generic open chat button',
    priority: 100,
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

    return {
      element,
      descriptor,
    };
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
  findChatSelectorMatch<Element>(CHAT_CONTAINER_DESCRIPTORS, {
    predicate: (element) => validateChatElement(element),
  });

export const findChatToggleButtonMatch = (): ChatSelectorMatch<HTMLButtonElement> | null =>
  findChatSelectorMatch<HTMLButtonElement>(CHAT_TOGGLE_BUTTON_DESCRIPTORS, {
    predicate: (element) => !element.disabled,
  });

/**
 * Validate that an element is actually a chat container
 * Prevents matching non-chat elements like sidebar menus
 */
export const validateChatElement = (element: Element): boolean => {
  let current: Element | null = element;
  let depth = 0;
  const maxDepth = 10;

  while (current && depth < maxDepth) {
    const tagName = current.tagName.toLowerCase();
    const className = current.className.toLowerCase();
    const id = current.id.toLowerCase();

    // Positive indicators (chat-related)
    if (
      tagName.includes('chat') ||
      className.includes('chat') ||
      id.includes('chat') ||
      tagName === 'yt-live-chat-app' ||
      tagName === 'ytd-live-chat-frame' ||
      tagName === 'yt-live-chat-item-list-renderer'
    ) {
      overlayLog.debug(
        `[YT Chat Overlay] Element validated: found chat-related parent at depth ${depth}`
      );
      return true;
    }

    // Negative indicators (not chat)
    if (
      tagName === 'ytd-mini-guide-renderer' ||
      tagName === 'ytd-guide-renderer' ||
      className.includes('guide') ||
      className.includes('sidebar') ||
      id.includes('guide')
    ) {
      overlayLog.debug(
        `[YT Chat Overlay] Element rejected: found non-chat parent "${tagName}" at depth ${depth}`
      );
      return false;
    }

    current = current.parentElement;
    depth++;
  }

  overlayLog.debug('[YT Chat Overlay] Element validation inconclusive, rejecting');
  return false;
};

export const debugLogChatElements = (): void => {
  overlayLog.debug('[YT Chat Overlay] === DEBUG: Chat Elements ===');

  const chatElements = document.querySelectorAll(
    '[id*="chat"], [class*="chat"], yt-live-chat-app, ytd-live-chat-frame'
  );
  overlayLog.debug(
    `[YT Chat Overlay] Found ${chatElements.length} elements with 'chat' in id/class or live chat tags`
  );

  let count = 0;
  for (const el of chatElements) {
    if (count++ >= 5) break;
    overlayLog.debug(
      `  [${count - 1}] ${el.tagName} id="${el.id}" class="${el.className.substring(0, 50)}"`
    );
  }

  const allIframes = document.querySelectorAll('iframe');
  overlayLog.debug(`[YT Chat Overlay] Found ${allIframes.length} total iframes`);
  let i = 0;
  for (const iframe of allIframes) {
    if (iframe.src.includes('chat')) {
      overlayLog.debug(`  iframe[${i}] src="${iframe.src}"`);
    }
    i++;
  }

  overlayLog.debug('[YT Chat Overlay] === END DEBUG ===');
};

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

  const hiddenAncestor = chatFrame.closest('[hidden], [aria-hidden="true"]');
  return Boolean(hiddenAncestor);
};
