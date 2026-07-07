// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ChatMessage } from '@app-types';
import { getTranslatableText } from '@chat/message-helpers';
import type { TranslationService } from '@core/translation-service';
import { desaturateColor } from '@renderer/color-utils';
import {
  type CanvasMessage,
  EMPTY_CHAT_MESSAGE,
  FAR_LAYER_DESATURATION_FACTOR,
  SPEED_TIER,
} from '@renderer/constants';

export interface MessageActivatorConfig {
  topBottomDurationMs: number;
  depthLayersEnabled: boolean;
}

export interface ActivationCallbacks {
  onActivated: (cm: CanvasMessage) => void;
  onMessageRendered: () => void;
  onTranslationResult: (cm: CanvasMessage, text: string | null) => void;
}

export class MessageActivator {
  private readonly messagePool: CanvasMessage[] = [];
  private readonly translationService: TranslationService;
  private readonly config: MessageActivatorConfig;

  constructor(translationService: TranslationService, config: MessageActivatorConfig) {
    this.translationService = translationService;
    this.config = config;
  }

  acquireMessage(): CanvasMessage {
    return (
      this.messagePool.pop() ?? {
        message: EMPTY_CHAT_MESSAGE,
        startTime: 0,
        fadeStartTime: 0,
        duration: 0,
        invDuration: 0,
        width: 0,
        height: 0,
        startX: 0,
        x: 0,
        y: 0,
        pausedDuration: 0,
        laneIndex: 0,
        staggerDelay: 0,
        speedTier: 0,
        renderMessage: EMPTY_CHAT_MESSAGE,
        laneArrayIndices: [],
      }
    );
  }

  releaseMessage(msg: CanvasMessage): void {
    // Clear reference-type fields to prevent stale data leaks.
    // These are overwritten by Object.assign on next acquire.
    msg.message = EMPTY_CHAT_MESSAGE;
    msg.renderMessage = EMPTY_CHAT_MESSAGE;
    msg.translatedText = null;
    delete msg.desaturatedUserColor;
    // Keep numeric fields — they'll be overwritten by Object.assign
    this.messagePool.push(msg);
  }

  /**
   * Finalize and activate a message.
   */
  activate(
    message: ChatMessage,
    now: number,
    msgWidth: number,
    msgHeight: number,
    laneY: number,
    callbacks: ActivationCallbacks,
    duration?: number,
    startX?: number,
    laneIndex?: number,
    staggerDelay = 0,
    speedTier?: number
  ): void {
    const effectiveDuration = duration ?? this.config.topBottomDurationMs;
    const effectiveStartX = startX ?? 0;
    const cm = this.acquireMessage();
    Object.assign(cm, {
      message,
      fadeStartTime: now + staggerDelay,
      startTime: now + staggerDelay,
      duration: effectiveDuration,
      invDuration: 1 / Math.max(1, effectiveDuration),
      width: msgWidth,
      height: msgHeight,
      startX: effectiveStartX,
      x: effectiveStartX,
      y: laneY,
      pausedDuration: 0,
      laneIndex: laneIndex ?? 0,
      staggerDelay,
      speedTier: speedTier ?? SPEED_TIER.MID,
      renderMessage: message,
    });

    if (this.config.depthLayersEnabled && speedTier === SPEED_TIER.FAR && message.userColor) {
      cm.desaturatedUserColor = desaturateColor(message.userColor, FAR_LAYER_DESATURATION_FACTOR);
      cm.renderMessage = { ...message, userColor: cm.desaturatedUserColor };
    } else {
      // Avoid per-frame nullish coalescing in renderFrame — ensure renderMessage is always set
      cm.renderMessage = message;
    }

    callbacks.onActivated(cm);
    callbacks.onMessageRendered();

    // Trigger async translation for all message kinds (text, superchat, membership).
    // Use isEnabled (not isActive) so translate() is called even when the
    // translator is temporarily dead — auto-recovery inside translate()
    // will recreate it.
    const translatableText = getTranslatableText(message);
    if (this.translationService.isEnabled && translatableText) {
      const cmRef = cm;
      this.translationService
        .translate(translatableText)
        .then((translated) => {
          callbacks.onTranslationResult(cmRef, translated);
        })
        .catch(() => {
          // Silently ignore individual translation failures.
          // translate() already logs at debug level.
        });
    }
  }
}
