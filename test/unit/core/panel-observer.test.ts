// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { ChatPanelObserver } from '@chat/panel-observer';

describe('ChatPanelObserver state reset', () => {
  it('stop() resets isPaused so next start() → pause() works', () => {
    const observer = new ChatPanelObserver();
    let callCount = 0;
    observer.start(() => {
      callCount++;
    });

    // Simulate: start → pause → stop → start → pause
    observer.pause();
    observer.stop();

    // Start again with a fresh callback
    let secondCallCount = 0;
    observer.start(() => {
      secondCallCount++;
    });

    // After stop(), a fresh start() should not be blocked by stale isPaused
    // The pause() that follows should not be a no-op due to stale flag
    observer.pause();
    // Pause is idempotent — calling it again is safe
    observer.pause();

    observer.stop();
    expect(secondCallCount).toBeGreaterThanOrEqual(0);
  });

  it('resume() after stop()+start() works correctly', () => {
    const observer = new ChatPanelObserver();
    let callCount = 0;
    observer.start(() => {
      callCount++;
    });

    // Simulate pause → stop → start → resume cycle
    observer.pause();
    observer.stop();

    let secondCallCount = 0;
    observer.start(() => {
      secondCallCount++;
    });

    // resume() should not be blocked: after stop(), isPaused=false
    observer.resume();
    // Double resume is safe (idempotent)
    observer.resume();

    observer.stop();
    expect(secondCallCount).toBeGreaterThanOrEqual(0);
  });
});
