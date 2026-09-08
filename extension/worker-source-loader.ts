// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/** The packaged worker is currently under 100 KiB; leave bounded build headroom. */
export const MAX_PACKAGED_WORKER_BYTES = 512 * 1024;

interface WorkerSourceLoadOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

function workerSourceBytes(source: string): number {
  return new Blob([source]).size;
}

function assertBoundedWorkerSource(source: string): void {
  if (source.length === 0) throw new Error('Packaged worker source is empty');
  if (workerSourceBytes(source) > MAX_PACKAGED_WORKER_BYTES) {
    throw new Error('Packaged worker source exceeds the size limit');
  }
}

/** Load the caller-supplied, already authenticated extension resource. */
export async function loadPackagedWorkerSource(
  workerUrl: string,
  options: WorkerSourceLoadOptions = {}
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(workerUrl, {
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) throw new Error('Packaged worker source could not be loaded');

  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PACKAGED_WORKER_BYTES) {
    throw new Error('Packaged worker source exceeds the size limit');
  }

  const source = await response.text();
  assertBoundedWorkerSource(source);
  return source;
}

/** Create the worker URL in MAIN world so its Blob inherits the page origin. */
export function createPageWorkerBlobUrl(source: string): string {
  assertBoundedWorkerSource(source);
  return URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
}

/** Keep the Blob valid across BFCache and release it on permanent document teardown. */
export function retainWorkerBlobUrlForDocument(workerUrl: string): () => void {
  let retained = true;
  const release = (): void => {
    if (!retained) return;
    retained = false;
    window.removeEventListener('pagehide', handlePageHide);
    URL.revokeObjectURL(workerUrl);
  };
  const handlePageHide = (event: PageTransitionEvent): void => {
    if (!event.persisted) release();
  };
  window.addEventListener('pagehide', handlePageHide);
  return release;
}
