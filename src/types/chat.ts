// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type {
  AuthorType,
  ChatMessageKind,
  ContentSegment,
  ImageAsset,
  SuperChatTier,
} from './common';

/**
 * Super Chat tier information
 */
export interface SuperChatInfo {
  /** Purchase amount (e.g., "5.00") */
  amount: string;
  /** Super Chat color tier (determines prominence) */
  tier: SuperChatTier;
  /** Background color from YouTube */
  backgroundColor?: string;
  /** Header background color (darker shade) */
  headerBackgroundColor?: string;
  /** Sticker image asset (for paid stickers / sticker-enhanced Super Chats) */
  sticker?: ImageAsset;
}

/** Serializable text alternative for one canvas-rendered chat message. */
export interface AccessibleChatMessage {
  /** Stable message identity used to avoid re-announcing the same rendered item. */
  id: string;
  /** Full, untruncated message body. */
  text: string;
  kind: ChatMessageKind;
  author?: string;
  superChatAmount?: string;
  membershipHeader?: string;
}

/**
 * Chat message structure (normalized)
 *
 * This is the ONLY type shared across the entire pipeline boundary (parser →
 * renderer → worker). All other message-like types (CanvasMessage,
 * WorkerMessage, ActiveMessage, SharedMessage) are renderer-internal and
 * intentionally NOT unified into a single type because:
 *
 *   1. Each renderer layer adds its own lifecycle state (timing, position,
 *      opacity buckets) that would pollute the ingress type with 20+ optional
 *      fields — defeating type safety.
 *   2. WorkerMessage must be serializable (postMessage), so it can't carry
 *      the same fields as CanvasMessage which holds live references (the
 *      original ChatMessage object, mutable render state).
 *   3. A union/sum type would force every consumer to narrow, adding runtime
 *      overhead to a hot path (60fps render loop).
 *
 * ChatMessage represents the "parsed and normalized" contract. Downstream
 * renderers project it into their own optimized shapes. This is a deliberate
 * projection-over-unification tradeoff.
 */
export interface ChatMessage {
  id?: string;
  text: string;
  content: ContentSegment[];
  kind: ChatMessageKind;
  timestamp: number;
  author?: string;
  authorType: AuthorType;
  authorPhotoUrl?: string;
  userColor?: string;
  superChat?: SuperChatInfo;
  membershipHeader?: string;
  isBacklog?: boolean;
  videoOffsetMs?: number;
  /**
   * Source action type from YouTube API.
   * - 'add': standard addChatItemAction (new message)
   * - 'replace': replaceChatItemAction (edited/deleted message)
   * - undefined: from sources that don't track this (DOM watcher, etc.)
   */
  actionType?: 'add' | 'replace';
}
