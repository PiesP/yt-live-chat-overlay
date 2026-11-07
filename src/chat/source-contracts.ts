// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ChatMessage, Pauseable } from '@app-types';
import type { ChatHealthSnapshot, ChatSourceStartStatus } from '@chat/source-base';
import type { ChatBootstrapData } from '@chat/youtube/api';

/** Operations shared by live and replay consumers, independent of source implementation. */
export interface ChatSourceOperations extends Pauseable {
  setInitialBootstrap(data: ChatBootstrapData): void;
  start(
    callback: (messages: ChatMessage | ChatMessage[], isInitialSeed?: boolean) => void,
    signal?: AbortSignal
  ): Promise<ChatSourceStartStatus>;
  setPauseReason(reason: string, paused: boolean): void;
  getLatestMessages(limit: number): ChatMessage[];
  getHealthSnapshot(options?: { activeTimeoutMs?: number }): ChatHealthSnapshot;
}

/** RuntimeManager alone owns source retirement. */
export interface ChatSourceOwner extends ChatSourceOperations {
  stop(): void;
}

/** Live ingress is borrowed by the runtime's fetch and DOM interception callbacks. */
export interface LiveChatIngress {
  injectExternalMessages(messages: ChatMessage[]): void;
}

export interface LiveChatPort extends ChatSourceOwner, LiveChatIngress {
  readonly mode: 'live';
  burstRateProvider?: () => number;
}

/** Replay timeline ownership stays with its source; consumers request due messages only. */
export interface ReplayChatPort extends ChatSourceOwner {
  readonly mode: 'replay';
  onSeek?: () => void;
  onLateDrop?: (count: number) => void;
  drainPendingMessages(): ChatMessage[];
}

export type RuntimeChatSource = LiveChatPort | ReplayChatPort;

/** The panel observer borrows only the live source's ingress. */
export type ChatPanelSource =
  | { readonly mode: 'replay' }
  | (LiveChatIngress & { readonly mode: 'live' });
