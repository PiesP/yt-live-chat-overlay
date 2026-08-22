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

  it('bounds each externally injected DOM batch to the configured capacity', async () => {
    const container = createChatContainer();
    const onMessages = vi.fn();
    const unsubscribe = installDomChatWatcher(onMessages, () => 2);

    const batch = document.createElement('div');
    batch.append(
      ...Array.from({ length: 10 }, (_, index) =>
        createTextRenderer(`author-${index}`, `message-${index}`, `message-${index}`)
      )
    );
    container.append(batch);
    await vi.runAllTimersAsync();

    expect(onMessages).toHaveBeenCalledOnce();
    expect(onMessages.mock.calls[0]?.[0]).toHaveLength(2);
    unsubscribe?.();
  });

  it('shares one retained-record and message capacity across callbacks before rAF', async () => {
    const container = createChatContainer();
    const onMessages = vi.fn();
    const pendingCounts: number[] = [];
    const unsubscribe = installDomChatWatcher(onMessages, () => 2, (count) => {
      pendingCounts.push(count);
    });

    for (let index = 0; index < 10; index++) {
      container.append(createTextRenderer('author', `message-${index}`, `message-${index}`));
      await Promise.resolve();
    }
    expect(onMessages).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    expect(Math.max(...pendingCounts)).toBeLessThanOrEqual(2);
    expect(onMessages).toHaveBeenCalledOnce();
    expect(onMessages.mock.calls[0]?.[0]).toHaveLength(2);
    unsubscribe?.();
  });

  it('bounds non-element visits and huge renderer text extraction', async () => {
    const container = createChatContainer();
    const onMessages = vi.fn();
    const visitCounts: number[] = [];
    const characterCounts: number[] = [];
    const unsubscribe = installDomChatWatcher(
      onMessages,
      () => 10,
      undefined,
      (count) => visitCounts.push(count),
      (count) => characterCounts.push(count)
    );
    const renderer = createTextRenderer('a'.repeat(10_000), 'm'.repeat(10_000), 'bounded');
    const messageElement = renderer.children.item(1);
    if (!messageElement) throw new Error('message fixture missing');
    for (let index = 0; index < 1000; index++) {
      messageElement.append(document.createComment(`comment-${index}`), document.createTextNode('x'));
    }
    const querySelector = vi.spyOn(renderer, 'querySelector');
    const fragment = document.createDocumentFragment();
    fragment.append(renderer);
    for (let index = 0; index < 1000; index++) {
      fragment.append(document.createTextNode('noise'), document.createComment('noise'));
    }

    container.append(fragment);
    await vi.runAllTimersAsync();

    expect(Math.max(...visitCounts)).toBeLessThanOrEqual(160);
    expect(Math.max(...characterCounts)).toBeLessThanOrEqual(160);
    expect(querySelector).not.toHaveBeenCalled();
    expect(onMessages).toHaveBeenCalledOnce();
    expect(onMessages.mock.calls[0]?.[0][0]).toMatchObject({
      id: 'bounded',
      author: 'a'.repeat(80),
      text: 'm'.repeat(80),
    });
    unsubscribe?.();
  });
});
