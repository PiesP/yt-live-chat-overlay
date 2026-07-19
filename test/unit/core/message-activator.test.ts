/**
 * Tests for MessageActivator — message pooling, activation, and translation ID guard.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ChatMessage } from '@app-types';
import { MessageActivator } from '@util/message-activator';
import type { ActivationCallbacks, MessageActivatorConfig } from '@util/message-activator';
import { EMPTY_CHAT_MESSAGE } from '@renderer/constants';
import type { TranslationService } from '@translation/service';

// ── Helpers ───────────────────────────────────────────────────────────────

function makeChatMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    timestamp: Date.now(),
    text: 'Hello world',
    content: [{ type: 'text', content: 'Hello world' }],
    kind: 'text',
    authorType: 'normal',
    ...overrides,
  } as ChatMessage;
}

function makeCallbacks(): ActivationCallbacks {
  return {
    onActivated: vi.fn(),
    onMessageRendered: vi.fn(),
    onTranslationResult: vi.fn(),
  };
}

function makeConfig(overrides: Partial<MessageActivatorConfig> = {}): MessageActivatorConfig {
  return {
    topBottomDurationMs: 4000,
    depthLayersEnabled: false,
    ...overrides,
  };
}

function makeMockTranslationService(enabled = false): TranslationService & {
  translate: ReturnType<typeof vi.fn>;
} {
  return {
    isEnabled: enabled,
    isActive: false,
    translate: vi.fn().mockResolvedValue(null),
    setTarget: vi.fn(),
    setOverride: vi.fn(),
    destroy: vi.fn(),
    onLifecycle: vi.fn(),
  } as unknown as TranslationService & { translate: ReturnType<typeof vi.fn> };
}

// ── Construction ───────────────────────────────────────────────────────────

describe('MessageActivator', () => {
  let activator: MessageActivator;
  let translationService: ReturnType<typeof makeMockTranslationService>;

  beforeEach(() => {
    translationService = makeMockTranslationService();
    activator = new MessageActivator(translationService, makeConfig());
  });

  // ── acquireMessage ──────────────────────────────────────────────────────

  describe('acquireMessage()', () => {
    it('creates a new CanvasMessage from fresh pool', () => {
      const cm = activator.acquireMessage();
      expect(cm).toBeDefined();
      expect(cm.message).toBe(EMPTY_CHAT_MESSAGE);
      expect(cm.startTime).toBe(0);
      expect(cm.width).toBe(0);
      expect(cm.height).toBe(0);
      expect(cm.laneArrayIndices).toEqual([]);
    });

    it('returns a recycled message from the pool when available', () => {
      const msg1 = activator.acquireMessage();
      msg1.message = makeChatMessage({ id: 'original' });
      activator.releaseMessage(msg1);

      const msg2 = activator.acquireMessage();
      // Should be the same object reference (recycled)
      expect(msg2).toBe(msg1);
    });

    it('returns unique objects when pool is empty', () => {
      const msg1 = activator.acquireMessage();
      const msg2 = activator.acquireMessage();
      expect(msg1).not.toBe(msg2);
    });
  });

  // ── releaseMessage ──────────────────────────────────────────────────────

  describe('releaseMessage()', () => {
    it('clears message references on release', () => {
      const cm = activator.acquireMessage();
      cm.message = makeChatMessage({ id: 'test' });
      cm.renderMessage = makeChatMessage({ id: 'render-test' });
      cm.translatedText = '번역된 텍스트';
      (cm as unknown as Record<string, unknown>).desaturatedUserColor = '#aaa';

      activator.releaseMessage(cm);

      expect(cm.message).toBe(EMPTY_CHAT_MESSAGE);
      expect(cm.renderMessage).toBe(EMPTY_CHAT_MESSAGE);
      expect(cm.translatedText).toBeNull();
      expect((cm as unknown as Record<string, unknown>).desaturatedUserColor).toBeUndefined();
    });

    it('recycles same object back into pool', () => {
      const original = activator.acquireMessage();
      activator.releaseMessage(original);
      const recycled = activator.acquireMessage();
      expect(recycled).toBe(original); // Same object reference
    });
  });

  // ── activate ────────────────────────────────────────────────────────────

  describe('activate()', () => {
    it('calls onActivated and onMessageRendered callbacks', () => {
      const msg = makeChatMessage();
      const callbacks = makeCallbacks();

      activator.activate(msg, 1000, 200, 30, 400, callbacks);

      expect(callbacks.onActivated).toHaveBeenCalledTimes(1);
      expect(callbacks.onMessageRendered).toHaveBeenCalledTimes(1);
    });

    it('uses topBottomDurationMs when no duration provided', () => {
      const activator4000 = new MessageActivator(
        translationService,
        makeConfig({ topBottomDurationMs: 4000 })
      );
      const msg = makeChatMessage();
      const callbacks = makeCallbacks();

      activator4000.activate(msg, 1000, 200, 30, 400, callbacks);

      const cmArg = (callbacks.onActivated as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(cmArg.duration).toBe(4000);
      expect(cmArg.invDuration).toBe(1 / 4000);
    });

    it('uses provided duration when specified', () => {
      const msg = makeChatMessage();
      const callbacks = makeCallbacks();

      activator.activate(msg, 1000, 200, 30, 400, callbacks, 3000);

      const cmArg = (callbacks.onActivated as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(cmArg.duration).toBe(3000);
    });

    it('handles duration = 0 without division by zero', () => {
      const msg = makeChatMessage();
      const callbacks = makeCallbacks();

      activator.activate(msg, 1000, 200, 30, 400, callbacks, 0);

      const cmArg = (callbacks.onActivated as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      // invDuration = 1 / max(1, 0) = 1
      expect(cmArg.invDuration).toBe(1);
    });

    it('desaturates userColor when depthLayersEnabled and speedTier is FAR', () => {
      const farActivator = new MessageActivator(
        translationService,
        makeConfig({ depthLayersEnabled: true })
      );
      const msg = makeChatMessage({ userColor: '#ff0000' });
      const callbacks = makeCallbacks();

      farActivator.activate(msg, 1000, 200, 30, 400, callbacks, undefined, undefined, undefined, 0, 0); // speedTier = FAR(0)

      const cmArg = (callbacks.onActivated as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(cmArg.desaturatedUserColor).toBeDefined();
      expect(typeof cmArg.desaturatedUserColor).toBe('string');
      expect(cmArg.renderMessage.userColor).toBe(cmArg.desaturatedUserColor);
    });

    it('does not desaturate when speedTier is not FAR', () => {
      const farActivator = new MessageActivator(
        translationService,
        makeConfig({ depthLayersEnabled: true })
      );
      const msg = makeChatMessage({ userColor: '#ff0000' });
      const callbacks = makeCallbacks();

      farActivator.activate(msg, 1000, 200, 30, 400, callbacks, undefined, undefined, undefined, 0, 1); // speedTier = MID(1)

      const cmArg = (callbacks.onActivated as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(cmArg.desaturatedUserColor).toBeUndefined();
    });

    it('sets renderMessage correctly', () => {
      const msg = makeChatMessage({ id: 'test-msg', text: '안녕하세요' });
      const callbacks = makeCallbacks();

      activator.activate(msg, 1000, 200, 30, 400, callbacks);

      const cmArg = (callbacks.onActivated as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(cmArg.renderMessage).toBe(msg);
      expect(cmArg.renderMessage.id).toBe('test-msg');
    });
  });

  // ── Translation ID guard ────────────────────────────────────────────────

  describe('translation callback ID guard', () => {
    it('triggers translate when translationService is enabled', async () => {
      const svc = makeMockTranslationService(true);
      svc.translate.mockResolvedValue('번역됨');
      const act = new MessageActivator(svc, makeConfig());

      const msg = makeChatMessage({ id: 'msg-1', text: 'Hello' });
      const callbacks = makeCallbacks();

      act.activate(msg, 1000, 200, 30, 400, callbacks);

      expect(svc.translate).toHaveBeenCalledTimes(1);

      // Wait for async translation
      await new Promise((r) => setTimeout(r, 10));
    });

    it('does not trigger translate when translationService is disabled', () => {
      const msg = makeChatMessage({ id: 'msg-1', text: 'Hello' });
      const callbacks = makeCallbacks();

      activator.activate(msg, 1000, 200, 30, 400, callbacks);

      expect(translationService.translate).not.toHaveBeenCalled();
    });

    it('does not trigger translate when translatable text is empty', () => {
      // Message with empty content segments
      const svc = makeMockTranslationService(true);
      const act = new MessageActivator(svc, makeConfig());
      const msg = makeChatMessage({ id: 'msg-1', text: '', content: [{ type: 'text' as const, content: '' }] });
      const callbacks = makeCallbacks();

      act.activate(msg, 1000, 200, 30, 400, callbacks);

      expect(svc.translate).not.toHaveBeenCalled();
    });

    it('guards against applying translation to recycled message', async () => {
      const svc = makeMockTranslationService(true);
      // Make translate resolve synchronously for test simplicity
      svc.translate.mockResolvedValue('translated');
      const act = new MessageActivator(svc, makeConfig());

      const msg1 = makeChatMessage({ id: 'msg-1', text: 'Hello' });
      const callbacks1 = makeCallbacks();

      act.activate(msg1, 1000, 200, 30, 400, callbacks1);

      // Release the CanvasMessage back to pool before translation resolves
      const cmFromCallback = (callbacks1.onActivated as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      act.releaseMessage(cmFromCallback);

      // Acquire a new message from pool (same object)
      const cmRecycled = act.acquireMessage();
      expect(cmRecycled).toBe(cmFromCallback); // same object

      // Assign a new message ID (different from msg-1)
      cmRecycled.message = makeChatMessage({ id: 'msg-2', text: 'World' });

      // Wait for translation promise to resolve
      await new Promise((r) => setTimeout(r, 10));

      // onTranslationResult should NOT have been called because cm.message.id
      // now points to msg-2 ('msg-2') !== captured 'msg-1'
      expect(callbacks1.onTranslationResult).not.toHaveBeenCalled();
    });
  });
});
