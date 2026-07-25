// SPDX-License-Identifier: MIT
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock bootstrapChatSession
vi.mock('@chat/youtube/api', () => ({
  bootstrapChatSession: vi.fn(),
}));

import { bootstrapChatSession } from '@chat/youtube/api';
import { resolveBootstrap, refreshBootstrap, logBootstrapFailure } from '@app/bootstrap-resolver';

const mockBootstrap = vi.mocked(bootstrapChatSession);

const mockReadyData = {
  status: 'ready' as const,
  data: {
    isReplay: false,
    videoId: 'test-video',
    initialContinuation: '',
    visitorData: '',
    screenData: '',
    clickTrackingParams: '',
    apiKey: 'test-key',

        clientContext: {},
    clientNameHeader: '',
    ytcfg: {},
  } as unknown as import('@chat/youtube/api').ChatBootstrapData,

};
const mockRetryable = (reason: string) => ({ status: 'retryable' as const, reason });
const mockWaiting = (reason: string) => ({ status: 'waiting' as const, reason });
const mockUnavailable = (reason: string) => ({ status: 'unavailable' as const, reason });

describe('resolveBootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns ready when bootstrap succeeds on first attempt', async () => {
    mockBootstrap.mockResolvedValueOnce(mockReadyData);

    const result = await resolveBootstrap();
    expect(result.status).toBe('ready');
    expect(result.data).toBeDefined();
  });

  it('returns waiting immediately (no retry)', async () => {
    mockBootstrap.mockResolvedValueOnce(mockWaiting('stream-offline'));

    const result = await resolveBootstrap();
    expect(result.status).toBe('waiting');
  });

  it('returns unavailable immediately (no retry)', async () => {
    mockBootstrap.mockResolvedValueOnce(mockUnavailable('no-chat-renderer'));

    const result = await resolveBootstrap();
    expect(result.status).toBe('unavailable');
  });

  it('retries up to 5 times for retryable failures then succeeds', async () => {
    for (let i = 0; i < 4; i++) {
      mockBootstrap.mockResolvedValueOnce(mockRetryable('timeout'));
    }
    mockBootstrap.mockResolvedValueOnce(mockReadyData);

    const result = await resolveBootstrap();
    expect(result.status).toBe('ready');
  });

  it('returns last retryable result after exhausting all 5 retries', async () => {
    for (let i = 0; i < 5; i++) {
      mockBootstrap.mockResolvedValueOnce(mockRetryable('timeout'));
    }

    const result = await resolveBootstrap();
    expect(result.status).toBe('retryable');
  });
});

describe('refreshBootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns data when bootstrap succeeds', async () => {
  mockBootstrap.mockResolvedValueOnce(mockReadyData);

  const result = await refreshBootstrap();
  expect(result).not.toBeNull();
  expect(result?.isReplay).toBe(false);
  });

  it('returns null when bootstrap is not ready', async () => {
    mockBootstrap.mockResolvedValueOnce(mockWaiting('offline'));

    const result = await refreshBootstrap();
    expect(result).toBeNull();
  });
});

describe('logBootstrapFailure', () => {
  it('handles all status types without throwing', () => {
    expect(() => logBootstrapFailure(mockWaiting('offline'))).not.toThrow();
    expect(() => logBootstrapFailure(mockRetryable('timeout'))).not.toThrow();
    expect(() => logBootstrapFailure(mockUnavailable('no-chat'))).not.toThrow();
  });
});
