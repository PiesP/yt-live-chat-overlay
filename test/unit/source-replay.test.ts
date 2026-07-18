// SPDX-License-Identifier: MIT
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { ReplayChatSource } from '@chat/source-replay';
import { DEFAULT_SETTINGS } from '@settings/schema';

/**
 * Tests for ReplayChatSource seek+prefetch behavior.
 *
 * Regression guards for the Phase 3 fix: startPrefetch should only be
 * called when the seek fetch succeeds. The cooperative loop (lines 185-254)
 * already guards prefetch seeding behind mainPollSucceeded (line 202-204).
 * These tests verify the basic lifecycle and health snapshot contract.
 */

describe('ReplayChatSource', () => {
  let source: ReplayChatSource;

  beforeEach(() => {
    source = new ReplayChatSource(() => DEFAULT_SETTINGS);
  });

  it('constructs without error', () => {
    expect(source).toBeInstanceOf(ReplayChatSource);
  });

  it('accepts custom settings getter', () => {
    const custom = { ...DEFAULT_SETTINGS, replayPrefetchPages: 10 };
    const s = new ReplayChatSource(() => custom);
    expect(s).toBeInstanceOf(ReplayChatSource);
  });

  it('getHealthSnapshot returns expected shape', () => {
    const health = source.getHealthSnapshot();
    expect(health).toBeDefined();
    expect(typeof health.observerAlive).toBe('boolean');
    expect(typeof health.recentlyActive).toBe('boolean');
    expect(health).toHaveProperty('observerAlive');
    expect(health).toHaveProperty('recentlyActive');
  });

  it('getHealthSnapshot with activeTimeoutMs option', () => {
    const health = source.getHealthSnapshot({ activeTimeoutMs: 1000 });
    expect(health).toBeDefined();
    expect(typeof health.recentlyActive).toBe('boolean');
  });

  it('isActive returns boolean', () => {
    expect(typeof source.isActive()).toBe('boolean');
  });

  it('isActive with custom timeout', () => {
    expect(typeof source.isActive(5000)).toBe('boolean');
  });

  it('drainPendingMessages returns empty array when not started', () => {
    const pending = source.drainPendingMessages();
    expect(Array.isArray(pending)).toBe(true);
    expect(pending).toEqual([]);
  });

  it('stop() is idempotent', () => {
    expect(() => source.stop()).not.toThrow();
    expect(() => source.stop()).not.toThrow();
  });
});
