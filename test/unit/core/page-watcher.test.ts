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

describe('PageWatcher history patching', () => {
  it('restores both history methods after destroy', () => {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    const watcher = new PageWatcher();

    expect(history.pushState).not.toBe(originalPushState);
    expect(history.replaceState).not.toBe(originalReplaceState);

    watcher.destroy();

    expect(history.pushState).toBe(originalPushState);
    expect(history.replaceState).toBe(originalReplaceState);
  });

  it('does not let an older nested watcher overwrite a newer wrapper', () => {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    const firstWatcher = new PageWatcher();
    const firstPushState = history.pushState;
    const firstReplaceState = history.replaceState;
    const secondWatcher = new PageWatcher();
    const secondPushState = history.pushState;
    const secondReplaceState = history.replaceState;

    firstWatcher.destroy();

    expect(history.pushState).toBe(secondPushState);
    expect(history.replaceState).toBe(secondReplaceState);

    secondWatcher.destroy();

    expect(history.pushState).toBe(originalPushState);
    expect(history.replaceState).toBe(originalReplaceState);
    expect(firstPushState).not.toBe(originalPushState);
    expect(firstReplaceState).not.toBe(originalReplaceState);
  });
});
