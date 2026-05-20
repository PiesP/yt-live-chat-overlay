/**
 * Fetches YouTube live chat directly from youtubei endpoints without depending
 * on the visible chat panel DOM.
 *
 * Provides a class hierarchy:
 * - ChatSource (abstract base) — shared bootstrap, parser, settings, health tracking
 * - LiveChatSource — live polling loop, live continuation logic
 * - ReplayChatSource — replay polling loop, playerSeek + continuation logic
 */

export type {
  ChatHealthSnapshot,
  ChatSourceStartStatus,
  MessageCallback,
  PlaybackSnapshot,
} from '@core/chat-source-base';
export { ChatSource } from '@core/chat-source-base';
export { LiveChatSource } from '@core/chat-source-live';
export { ReplayChatSource } from '@core/chat-source-replay';
