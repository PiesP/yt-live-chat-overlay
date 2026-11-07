// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { OverlaySettings } from '@app-types';

/** Queue-ratio hysteresis; visual resets retain the session callback. */
export class BacklogHysteresis {
  paused = false;
  onChange: ((paused: boolean) => void) | null = null;
  private lastToggleTime = 0;

  update(queueLength: number, settings: Readonly<OverlaySettings>): void {
    const now = Date.now();
    if (now - this.lastToggleTime < settings.backlogToggleCooldownMs) return;
    const ratio = settings.queueMaxSize > 0 ? queueLength / settings.queueMaxSize : 0;
    if (ratio > settings.backlogPauseThreshold && !this.paused) {
      this.paused = true;
      this.lastToggleTime = now;
      this.onChange?.(true);
    } else if (ratio < settings.backlogResumeThreshold && this.paused) {
      this.paused = false;
      this.lastToggleTime = now;
      this.onChange?.(false);
    }
  }

  resetVisualState(): void {
    this.paused = false;
  }

  destroy(): void {
    this.paused = false;
    this.onChange = null;
  }
}
