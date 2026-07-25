// SPDX-License-Identifier: MIT
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createChatPreflight } from '@app/chat-availability-preflight';

describe('ChatAvailabilityPreflight', () => {
  it('starts in idle state', () => {
    const p = createChatPreflight();
    expect(p.state.phase).toBe('idle');
    expect(p.isTerminalAbsent).toBe(false);
    expect(p.isSettling).toBe(false);
  });

  it('transitions idle → settling on startSettle', () => {
    const p = createChatPreflight();
    p.startSettle('https://youtube.com/watch?v=abc');
    expect(p.state.phase).toBe('settling');
    expect(p.isSettling).toBe(true);
    expect(p.isTerminalAbsent).toBe(false);
  });

  it('stores URL in settling state', () => {
    const p = createChatPreflight();
    p.startSettle('https://youtube.com/watch?v=abc');
    expect(p.state).toEqual({ phase: 'settling', url: 'https://youtube.com/watch?v=abc' });
  });

  it('is idempotent on duplicate startSettle for same URL', () => {
    const p = createChatPreflight();
    p.startSettle('https://youtube.com/watch?v=abc');
    // Second call with same URL should be a no-op
    p.startSettle('https://youtube.com/watch?v=abc');
    expect(p.state.phase).toBe('settling');
  });

  it('transitions settling → expected-absent on markAbsent', () => {
    const p = createChatPreflight();
    p.startSettle('https://youtube.com/watch?v=abc');
    p.markAbsent('https://youtube.com/watch?v=abc');
    expect(p.state.phase).toBe('expected-absent');
    expect(p.isTerminalAbsent).toBe(true);
    expect(p.isSettling).toBe(false);
  });

  it('markAbsent is idempotent for same URL', () => {
    const p = createChatPreflight();
    p.markAbsent('https://youtube.com/watch?v=abc');
    p.markAbsent('https://youtube.com/watch?v=abc');
    expect(p.state.phase).toBe('expected-absent');
  });

  it('transitions expected-absent → idle on reset', () => {
    const p = createChatPreflight();
    p.markAbsent('https://youtube.com/watch?v=abc');
    expect(p.isTerminalAbsent).toBe(true);
    p.reset();
    expect(p.state.phase).toBe('idle');
    expect(p.isTerminalAbsent).toBe(false);
  });

  it('transitions settling → idle on reset', () => {
    const p = createChatPreflight();
    p.startSettle('https://youtube.com/watch?v=abc');
    p.reset();
    expect(p.state.phase).toBe('idle');
    expect(p.isSettling).toBe(false);
  });

  it('startSettle on expected-absent for same URL is a no-op', () => {
    const p = createChatPreflight();
    p.markAbsent('https://youtube.com/watch?v=abc');
    // Same URL should not restart settling
    p.startSettle('https://youtube.com/watch?v=abc');
    expect(p.state.phase).toBe('expected-absent');
  });

  it('startSettle on expected-absent for different URL transitions to settling', () => {
    const p = createChatPreflight();
    p.markAbsent('https://youtube.com/watch?v=abc');
    // Different URL should restart settling
    p.startSettle('https://youtube.com/watch?v=xyz');
    expect(p.state.phase).toBe('settling');
    expect(p.isSettling).toBe(true);
  });

  it('immediate markAbsent from idle works', () => {
    const p = createChatPreflight();
    p.markAbsent('https://youtube.com/watch?v=abc');
    expect(p.state.phase).toBe('expected-absent');
    expect(p.isTerminalAbsent).toBe(true);
  });

  it('multiple independent instances do not interfere', () => {
    const a = createChatPreflight();
    const b = createChatPreflight();
    a.markAbsent('https://a.com');
    b.startSettle('https://b.com');
    expect(a.isTerminalAbsent).toBe(true);
    expect(b.isSettling).toBe(true);
  });

  it('full lifecycle: idle → settling → absent → reset → idle', () => {
    const p = createChatPreflight();
    expect(p.state.phase).toBe('idle');
    p.startSettle('https://example.com/watch');
    expect(p.state.phase).toBe('settling');
    p.markAbsent('https://example.com/watch');
    expect(p.state.phase).toBe('expected-absent');
    p.reset();
    expect(p.state.phase).toBe('idle');
  });
});
