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
      signal,
    });
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
