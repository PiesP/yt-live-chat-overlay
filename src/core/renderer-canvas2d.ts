/**
 * Canvas2DRenderer
 *
 * Canvas 2D-based renderer that uses requestAnimationFrame instead of CSS
 * @keyframes animations.  Each frame computes positions with Math.floor() to
 * snap to integer pixel coordinates, eliminating the sub-pixel text jitter
 * inherent in CSS transform interpolation.
 *
 * Pause state machine mirrors the CSS Renderer:
 *   isPaused      — tab visibility
 *   isVideoPaused — video element pause
 */

import type { ChatMessage, OverlaySettings } from '@app-types';
import { createLogger } from '@core/logging';
import { ObservabilityReporter } from '@core/observability';
import type { Overlay } from '@core/overlay';

const log = createLogger('Canvas2DRenderer');

export interface Canvas2DRendererUpdateOptions {
  resetState?: boolean;
}

export class Canvas2DRenderer {
  readonly observability: ObservabilityReporter;
  onBacklogPauseChange: ((paused: boolean) => void) | null = null;

  private isPaused = false;
  private isVideoPaused = false;

  constructor(_overlay: Overlay, settings: OverlaySettings) {
    this.observability = new ObservabilityReporter(settings.showDebugOverlay);
    log.info('Canvas2DRenderer created (stub)');
  }

  get laneCount(): number {
    return 0;
  }

  addMessage(_message: ChatMessage): void {
    // stub
  }

  setBacklogSpeedMultiplier(_multiplier: number): void {
    // stub
  }

  trimBackgroundQueue(): void {
    // stub
  }

  updateSettings(_settings: OverlaySettings, _options?: Canvas2DRendererUpdateOptions): void {
    // stub
  }

  pause(): void {
    if (this.isPaused) return;
    this.isPaused = true;
  }

  resume(): void {
    if (!this.isPaused) return;
    if (this.isVideoPaused) return;
    this.isPaused = false;
  }

  /** Pause animations due to video playback pause. */
  pauseForVideo(): void {
    if (this.isVideoPaused) return;
    this.isVideoPaused = true;
    if (!this.isPaused) {
      this.pause();
    }
  }

  /** Resume animations after video playback resumes. */
  resumeForVideo(): void {
    if (!this.isVideoPaused) return;
    this.isVideoPaused = false;
    if (!document.hidden) {
      this.resume();
    }
  }

  setPlaybackRate(_rate: number): void {
    // stub
  }

  destroy(): void {
    this.isPaused = false;
    this.isVideoPaused = false;
    this.observability.destroy();
    log.debug('Destroyed');
  }
}
