// SPDX-License-Identifier: MIT
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPageWorkerBlobUrl,
  loadPackagedWorkerSource,
  MAX_PACKAGED_WORKER_BYTES,
  retainWorkerBlobUrlForDocument,
} from '../../extension/worker-source-loader';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('extension worker source loader', () => {
  it('loads only the supplied packaged worker URL within the byte limit', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('self.postMessage({ type: "ready" });', {
        headers: { 'content-length': '37' },
        status: 200,
      })
    );
    const signal = new AbortController().signal;

    await expect(
      loadPackagedWorkerSource('chrome-extension://trusted/workers/renderer.js', {
        fetchImpl,
        signal,
      })
    ).resolves.toContain('ready');
    expect(fetchImpl).toHaveBeenCalledWith('chrome-extension://trusted/workers/renderer.js', {
      signal: expect.any(AbortSignal),
    });
  });

  it('times out stalled preparation so application fallback can initialize', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    const request = loadPackagedWorkerSource('chrome-extension://trusted/workers/renderer.js', {
      fetchImpl,
    });
    const rejected = expect(request).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects failed, empty, and oversized packaged responses', async () => {
    await expect(
      loadPackagedWorkerSource('chrome-extension://trusted/workers/renderer.js', {
        fetchImpl: vi.fn().mockResolvedValue(new Response('', { status: 404 })),
      })
    ).rejects.toThrow(/could not be loaded/u);
    await expect(
      loadPackagedWorkerSource('chrome-extension://trusted/workers/renderer.js', {
        fetchImpl: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
      })
    ).rejects.toThrow(/empty/u);
    await expect(
      loadPackagedWorkerSource('chrome-extension://trusted/workers/renderer.js', {
        fetchImpl: vi.fn().mockResolvedValue(
          new Response('ignored', {
            headers: { 'content-length': String(MAX_PACKAGED_WORKER_BYTES + 1) },
            status: 200,
          })
        ),
      })
    ).rejects.toThrow(/size limit/u);
  });

  it('creates a page-owned Blob URL and preserves it through BFCache', () => {
    const createObjectURL = vi.fn().mockReturnValue('blob:https://www.youtube.com/worker');
    const revokeObjectURL = vi.fn();
    class TestUrl extends URL {}
    Object.defineProperties(TestUrl, {
      createObjectURL: { value: createObjectURL },
      revokeObjectURL: { value: revokeObjectURL },
    });
    vi.stubGlobal('URL', TestUrl);

    const workerUrl = createPageWorkerBlobUrl('self.postMessage({ type: "ready" });');
    retainWorkerBlobUrlForDocument(workerUrl);
    expect(createObjectURL).toHaveBeenCalledWith(
      expect.objectContaining({ size: expect.any(Number), type: 'text/javascript' })
    );

    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    expect(revokeObjectURL).not.toHaveBeenCalled();
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith(workerUrl);
  });
});
