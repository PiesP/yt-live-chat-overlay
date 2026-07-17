// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PageWatcher } from '@app/page-watcher';

// ── isValidPage ─────────────────────────────────────────────────────

describe('PageWatcher.isValidPage', () => {
  const stubLocation = (pathname: string): void => {
    // Replace the global location with a mock that has the desired pathname.
    // jsdom's Location.pathname is a non-configurable accessor, so we
    // replace the entire window.location object.
    vi.stubGlobal('location', {
      pathname,
      href: `https://www.youtube.com${pathname}`,
      origin: 'https://www.youtube.com',
    });
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns true for /watch', () => {
    stubLocation('/watch');
    const watcher = new PageWatcher();
    expect(watcher.isValidPage()).toBe(true);
    watcher.destroy();
  });

  it('returns true for /live/ with video ID', () => {
    stubLocation('/live/dQw4w9WgXcQ');
    const watcher = new PageWatcher();
    expect(watcher.isValidPage()).toBe(true);
    watcher.destroy();
  });

  it('returns true for /live/ with any suffix', () => {
    stubLocation('/live/some-video-id');
    const watcher = new PageWatcher();
    expect(watcher.isValidPage()).toBe(true);
    watcher.destroy();
  });

  it('returns false for /live (no trailing slash)', () => {
    // startsWith('/live/') requires the trailing slash
    stubLocation('/live');
    const watcher = new PageWatcher();
    expect(watcher.isValidPage()).toBe(false);
    watcher.destroy();
  });

  it('returns false for YouTube homepage /', () => {
    stubLocation('/');
    const watcher = new PageWatcher();
    expect(watcher.isValidPage()).toBe(false);
    watcher.destroy();
  });

  it('returns false for /channel/ page', () => {
    stubLocation('/channel/UC123456');
    const watcher = new PageWatcher();
    expect(watcher.isValidPage()).toBe(false);
    watcher.destroy();
  });

  it('returns false for /results page', () => {
    stubLocation('/results');
    const watcher = new PageWatcher();
    expect(watcher.isValidPage()).toBe(false);
    watcher.destroy();
  });

  it('returns false for /shorts page', () => {
    stubLocation('/shorts/abc123');
    const watcher = new PageWatcher();
    expect(watcher.isValidPage()).toBe(false);
    watcher.destroy();
  });

  it('returns false for /@channel page', () => {
    stubLocation('/@somechannel');
    const watcher = new PageWatcher();
    expect(watcher.isValidPage()).toBe(false);
    watcher.destroy();
  });
});
