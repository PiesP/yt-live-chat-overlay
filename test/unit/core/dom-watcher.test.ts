// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDomChatWatcher } from '@chat/dom-watcher';

function createTextRenderer(author: string, text: string, id: string): HTMLElement {
  const renderer = document.createElement('yt-live-chat-text-message-renderer');
  renderer.id = id;

  const authorElement = document.createElement('span');
  authorElement.id = 'author-name';
  authorElement.textContent = author;

  const messageElement = document.createElement('span');
  messageElement.id = 'message';
  messageElement.textContent = text;

  renderer.append(authorElement, messageElement);

  // jsdom resolves duplicate ID selectors against the document instead of the
  // scoped element. YouTube legitimately repeats these IDs per renderer, so
  // keep the fixture's DOM shape while preserving scoped selector behavior.
  Object.defineProperty(renderer, 'querySelector', {
    configurable: true,
    value: (selector: string): Element | null => {
      if (selector === '#author-name') return authorElement;
      if (selector === '#message') return messageElement;
      return HTMLElement.prototype.querySelector.call(renderer, selector);
    },
  });

  return renderer;
}

function createChatContainer(): HTMLElement {
  const list = document.createElement('yt-live-chat-item-list-renderer');
  const items = document.createElement('div');
  items.id = 'items';
  list.append(items);
  document.body.append(list);
  return items;
}

describe('installDomChatWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.replaceChildren();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('forwards every renderer from a single added mutation node', async () => {
    const container = createChatContainer();
    const onMessages = vi.fn();
    const unsubscribe = installDomChatWatcher(onMessages);

    const batch = document.createElement('div');
    batch.append(
      createTextRenderer('alice', 'first message', 'message-1'),
      createTextRenderer('bob', 'second message', 'message-2'),
    );
    container.append(batch);

    await vi.runAllTimersAsync();

    expect(onMessages).toHaveBeenCalledTimes(1);
    const messages = onMessages.mock.calls[0]?.[0];
    expect(messages?.map((message: { id: string }) => message.id)).toEqual(['message-1', 'message-2']);
    expect(messages?.map((message: { text: string }) => message.text)).toEqual(['first message', 'second message']);

    unsubscribe?.();
  });
});
