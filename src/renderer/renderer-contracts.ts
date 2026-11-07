// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ChatMessage, OverlayDimensions, OverlaySettings } from '@app-types';
import type { ObservabilityReporter } from '@util/observability';

export type ConnectionStatus = 'connected' | 'connecting' | 'degraded' | 'disconnected' | 'standby';

/** The only renderer capability needed by pre-live standby. */
export interface StandbyStatusSink {
  setStandbyStatus(standby: boolean): void;
}

/** RuntimeManager's renderer operations; implementation state remains private. */
export interface RuntimeRenderer extends StandbyStatusSink {
  readonly observability: ObservabilityReporter;
  readonly laneCount: number;
  readonly isVideoPaused: boolean;
  onBacklogPauseChange: ((paused: boolean) => void) | null;
  onStatusBarClick: (() => void) | null;
  addMessage(message: ChatMessage): void;
  replayMessage(message: ChatMessage): void;
  destroy(): void;
  updateSettings(settings: OverlaySettings, options?: { resetState?: boolean }): void;
  setConnectionStatus(status: ConnectionStatus): void;
  setChatPanelOpen(open: boolean): void;
  setReplayMode(enabled: boolean): void;
  pause(): void;
  resume(): void;
  pauseForVideo(): void;
  resumeForVideo(): void;
  resumeRenderLoop(): void;
  clearPausedDuration(): void;
  prepareForRefresh(): void;
  resetAllocator(dimensions: OverlayDimensions | null): void;
  resetBurstDetector(): void;
  trimBackgroundQueue(): void;
  drainPendingQueue(): ChatMessage[];
  getBurstEmaRate(): number;
  getLaneUtilization(): number;
  getQueueLength(): number;
  getActiveMessageCount(): number;
  getMsSinceLastRenderActivity(now?: number): number;
  isWorkerAlive(): boolean;
  fallbackToMainThread(reason: string): void;
}
