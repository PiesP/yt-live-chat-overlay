import { overlayLog } from '@core/logging';

export const CHAT_FRAME_SELECTORS = [
  'ytd-live-chat-frame#chat',
  '#chat',
  'ytd-live-chat-frame',
] as const;

export const CHAT_IFRAME_SELECTORS = [
  'iframe[src*="live_chat"]',
  'iframe#chatframe',
  'ytd-live-chat-frame iframe',
  '#chat iframe',
] as const;

export const CHAT_IFRAME_ITEM_SELECTORS = [
  '#items.yt-live-chat-item-list-renderer',
  '#items',
  'yt-live-chat-item-list-renderer #items',
] as const;

export const CHAT_CONTAINER_SELECTORS = [
  // Most specific selectors first
  '#chat #items.yt-live-chat-item-list-renderer',
  '#items.yt-live-chat-item-list-renderer',
  'yt-live-chat-item-list-renderer #items',

  // Frame-based selectors
  'ytd-live-chat-frame #items',

  // App-based selectors
  'yt-live-chat-app #items',

  // Chat panel selectors
  '#chat-container #items',
  '#chat #items',
  'ytd-live-chat #items',
] as const;

export const CHAT_TOGGLE_BUTTON_SELECTORS = [
  // Theater mode toggle button
  'ytd-toggle-button-renderer button[aria-label*="chat" i]',
  'ytd-toggle-button-renderer button[aria-label*="채팅" i]',
  // Live chat button
  'button#show-hide-button',
  // Engagement panel toggle
  'ytd-engagement-panel-title-header-renderer button',
  // Engagement panel list buttons
  'ytd-engagement-panel-section-list-renderer button[aria-label*="chat" i]',
  'ytd-engagement-panel-section-list-renderer button[aria-label*="채팅" i]',
  // Generic chat-related buttons (ignore overlay settings button)
  'button:not(#yt-chat-overlay-settings-button)[aria-label*="show chat" i]',
  'button:not(#yt-chat-overlay-settings-button)[aria-label*="open chat" i]',
] as const;

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
      overlayLog.info(
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
      overlayLog.info(
        `[YT Chat Overlay] Element rejected: found non-chat parent "${tagName}" at depth ${depth}`
      );
      return false;
    }

    current = current.parentElement;
    depth++;
  }

  overlayLog.info('[YT Chat Overlay] Element validation inconclusive, rejecting');
  return false;
};

export const debugLogChatElements = (): void => {
  overlayLog.info('[YT Chat Overlay] === DEBUG: Chat Elements ===');

  const chatElements = document.querySelectorAll(
    '[id*="chat"], [class*="chat"], yt-live-chat-app, ytd-live-chat-frame'
  );
  overlayLog.info(
    `[YT Chat Overlay] Found ${chatElements.length} elements with 'chat' in id/class or live chat tags`
  );

  let count = 0;
  for (const el of chatElements) {
    if (count++ >= 5) break;
    overlayLog.info(
      `  [${count - 1}] ${el.tagName} id="${el.id}" class="${el.className.substring(0, 50)}"`
    );
  }

  const allIframes = document.querySelectorAll('iframe');
  overlayLog.info(`[YT Chat Overlay] Found ${allIframes.length} total iframes`);
  let i = 0;
  for (const iframe of allIframes) {
    if (iframe.src.includes('chat')) {
      overlayLog.info(`  iframe[${i}] src="${iframe.src}"`);
    }
    i++;
  }

  overlayLog.info('[YT Chat Overlay] === END DEBUG ===');
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
