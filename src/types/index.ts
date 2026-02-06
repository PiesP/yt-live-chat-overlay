/**
 * Type definitions for YouTube Live Chat Overlay
 */

/**
 * Author type classification
 */
export type AuthorType = 'normal' | 'member' | 'moderator' | 'owner' | 'verified';

/**
 * Chat message structure (normalized)
 */
export interface ChatMessage {
  /** Message text content (sanitized, max 80 chars) */
  text: string;
  /** Message type */
  kind: 'text' | 'superchat' | 'membership' | 'other';
  /** Timestamp when the message was detected */
  timestamp: number;
  /** Author display name (optional, for future use) */
  author?: string;
  /** Author type classification */
  authorType?: AuthorType;
}

/**
 * Color settings for different author types
 */
export interface ColorSettings {
  /** Normal user color */
  normal: string;
  /** Member (membership subscriber) color */
  member: string;
  /** Moderator color */
  moderator: string;
  /** Channel owner color */
  owner: string;
  /** Verified user color */
  verified: string;
}

/**
 * Overlay settings
 */
export interface OverlaySettings {
  /** Enable/disable overlay */
  enabled: boolean;
  /** Speed in pixels per second (150-500) */
  speedPxPerSec: number;
  /** Font size in pixels */
  fontSize: number;
  /** Opacity (0.0-1.0) */
  opacity: number;
  /** Safe zone top percentage (0.0-1.0) */
  safeTop: number;
  /** Safe zone bottom percentage (0.0-1.0) */
  safeBottom: number;
  /** Maximum concurrent messages */
  maxConcurrentMessages: number;
  /** Maximum messages per second */
  maxMessagesPerSecond: number;
  /** Color settings for different author types */
  colors: ColorSettings;
}

/**
 * Lane state for message flow
 */
export interface LaneState {
  /** Lane index */
  index: number;
  /** Last item exit time (timestamp) */
  lastItemExitTime: number;
  /** Last item start time (timestamp) */
  lastItemStartTime: number;
}

/**
 * Overlay dimensions
 */
export interface OverlayDimensions {
  width: number;
  height: number;
  laneHeight: number;
  laneCount: number;
}

/**
 * Default settings
 */
export const DEFAULT_SETTINGS: Readonly<OverlaySettings> = {
  enabled: true,
  speedPxPerSec: 280,
  fontSize: 24,
  opacity: 0.9,
  safeTop: 0.06,
  safeBottom: 0.12,
  maxConcurrentMessages: 30,
  maxMessagesPerSecond: 8,
  colors: {
    normal: '#FFFFFF', // White for normal users
    member: '#0F9D58', // Green for members
    moderator: '#5E84F1', // Blue for moderators
    owner: '#FFD600', // Gold/Yellow for channel owner
    verified: '#AAAAAA', // Gray for verified users
  },
};
