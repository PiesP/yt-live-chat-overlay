import { PageWatcher } from '@app/page-watcher';
import { describe, expect, it, vi } from 'vite-plus/test';

// ── isValidPage ─────────────────────────────────────────────────────

describe('PageWatcher.isValidPage', () => {
  const watcherAt = (pathname: string): PageWatcher =>
    new PageWatcher(() => `https://www.youtube.com${pathname}`);

  it('returns true for /watch', () => {
    const watcher = watcherAt('/watch');
    expect(watcher.isValidPage()).toBe(true);
    watcher.destroy();
  });

  it('returns true for /live/ with video ID', () => {
    const watcher = watcherAt('/live/dQw4w9WgXcQ');
    expect(watcher.isValidPage()).toBe(true);
    watcher.destroy();
  });

  it('returns true for /live/ with any suffix', () => {
    const watcher = watcherAt('/live/some-video-id');
    expect(watcher.isValidPage()).toBe(true);
    watcher.destroy();
  });

  it('returns false for /live (no trailing slash)', () => {
    // startsWith('/live/') requires the trailing slash
    const watcher = watcherAt('/live');
    expect(watcher.isValidPage()).toBe(false);
    watcher.destroy();
  });

  it('returns false for YouTube homepage /', () => {
    const watcher = watcherAt('/');
    expect(watcher.isValidPage()).toBe(false);
    watcher.destroy();
  });

  it('returns false for /channel/ page', () => {
    const watcher = watcherAt('/channel/UC123456');
    expect(watcher.isValidPage()).toBe(false);
    watcher.destroy();
  });

  it('returns false for /results page', () => {
    const watcher = watcherAt('/results');
    expect(watcher.isValidPage()).toBe(false);
    watcher.destroy();
  });

  it('returns false for /shorts page', () => {
    const watcher = watcherAt('/shorts/abc123');
    expect(watcher.isValidPage()).toBe(false);
    watcher.destroy();
  });

  it('returns false for /@channel page', () => {
    const watcher = watcherAt('/@somechannel');
    expect(watcher.isValidPage()).toBe(false);
    watcher.destroy();
  });
});

describe('PageWatcher history patching', () => {
  it('preserves history navigation and notifies for patched methods', () => {
    const originalUrl = location.href;
    const originalState = history.state;
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    const watcher = new PageWatcher();
    const onChange = vi.fn();
    watcher.onChange(onChange);

    try {
      history.pushState({ navigation: 'push' }, '', '/watch?v=first');

      expect(location.pathname).toBe('/watch');
      expect(location.search).toBe('?v=first');
      expect(history.state).toEqual({ navigation: 'push' });
      expect(onChange).toHaveBeenCalledTimes(1);

      history.replaceState({ navigation: 'replace' }, '', '/live/second');

      expect(location.pathname).toBe('/live/second');
      expect(location.search).toBe('');
      expect(history.state).toEqual({ navigation: 'replace' });
      expect(onChange).toHaveBeenCalledTimes(2);
    } finally {
      watcher.destroy();
      originalReplaceState.call(history, originalState, '', originalUrl);
    }

    expect(history.pushState).toBe(originalPushState);
    expect(history.replaceState).toBe(originalReplaceState);
  });

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
