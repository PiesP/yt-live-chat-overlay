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

describe('PageWatcher native navigation observation', () => {
  it('observes push and replace without changing History methods', async () => {
    const originalUrl = location.href;
    const originalState = history.state;
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    const watcher = new PageWatcher();
    const onChange = vi.fn();
    watcher.onChange(onChange);
    expect(history.pushState).toBe(originalPushState);
    expect(history.replaceState).toBe(originalReplaceState);

    try {
      history.pushState({ navigation: 'push' }, '', '/watch?v=first');

      expect(location.pathname).toBe('/watch');
      expect(location.search).toBe('?v=first');
      expect(history.state).toEqual({ navigation: 'push' });
      await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));

      history.replaceState({ navigation: 'replace' }, '', '/live/second');

      expect(location.pathname).toBe('/live/second');
      expect(location.search).toBe('');
      expect(history.state).toEqual({ navigation: 'replace' });
      await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
      history.replaceState({ navigation: 'same-url' }, '', '/live/second');
      await Promise.resolve();
      expect(onChange).toHaveBeenCalledTimes(2);
      window.dispatchEvent(new Event('yt-navigate-finish'));
      expect(onChange).toHaveBeenCalledTimes(3);
    } finally {
      watcher.destroy();
      originalReplaceState.call(history, originalState, '', originalUrl);
    }

    expect(history.pushState).toBe(originalPushState);
    expect(history.replaceState).toBe(originalReplaceState);
  });

  it('keeps History unchanged across repeated creation and disposal', () => {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    const watcher = new PageWatcher();

    expect(history.pushState).toBe(originalPushState);
    expect(history.replaceState).toBe(originalReplaceState);

    watcher.destroy();

    expect(history.pushState).toBe(originalPushState);
    expect(history.replaceState).toBe(originalReplaceState);
  });

  it('isolates callbacks when an older watcher is disposed before a newer one', async () => {
    const originalUrl = location.href;
    const originalState = history.state;
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    const firstWatcher = new PageWatcher();
    const secondWatcher = new PageWatcher();
    const firstCallback = vi.fn();
    const secondCallback = vi.fn();
    firstWatcher.onChange(firstCallback);
    secondWatcher.onChange(secondCallback);

    try {
      history.pushState({}, '', '/watch?v=first');
      await vi.waitFor(() => {
        expect(firstCallback).toHaveBeenCalledTimes(1);
        expect(secondCallback).toHaveBeenCalledTimes(1);
      });
      firstWatcher.destroy();
      history.pushState({}, '', '/live/second');
      await vi.waitFor(() => expect(secondCallback).toHaveBeenCalledTimes(2));
      expect(firstCallback).toHaveBeenCalledTimes(1);
      window.dispatchEvent(new Event('yt-navigate-finish'));
      expect(secondCallback).toHaveBeenCalledTimes(3);
      expect(firstCallback).toHaveBeenCalledTimes(1);
    } finally {
      firstWatcher.destroy();
      secondWatcher.destroy();
      originalReplaceState.call(history, originalState, '', originalUrl);
    }

    expect(history.pushState).toBe(originalPushState);
    expect(history.replaceState).toBe(originalReplaceState);
  });

  it('isolates an exception in one callback before notifying the next', () => {
    const watcher = new PageWatcher();
    const next = vi.fn();
    watcher.onChange(() => {
      throw new Error('controlled callback failure');
    });
    watcher.onChange(next);
    window.dispatchEvent(new Event('yt-navigate-finish'));
    expect(next).toHaveBeenCalledOnce();
    watcher.destroy();
  });

  it('observes back and forward entries without an extra popstate listener', async () => {
    const originalUrl = location.href;
    const originalState = history.state;
    const watcher = new PageWatcher();
    const onChange = vi.fn();
    watcher.onChange(onChange);
    try {
      history.pushState({}, '', '/watch?v=back');
      history.pushState({}, '', '/live/forward');
      await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
      history.back();
      await vi.waitFor(() => expect(location.search).toBe('?v=back'));
      expect(onChange).toHaveBeenCalledTimes(3);
      history.forward();
      await vi.waitFor(() => expect(location.pathname).toBe('/live/forward'));
      expect(onChange).toHaveBeenCalledTimes(4);
    } finally {
      watcher.destroy();
      history.replaceState(originalState, '', originalUrl);
    }
  });
});
