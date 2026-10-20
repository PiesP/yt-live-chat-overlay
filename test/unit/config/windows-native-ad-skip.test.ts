// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { Script } from 'node:vm';

import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { FirefoxBidiCommandTimeout } from '../../../validation/windows/firefox-bidi.ts';
import {
  admitNativePublicAd,
  NativeAdAdmissionError,
} from '../../../validation/windows/native-ad-skip.ts';

const WATCH_URL = 'https://www.youtube.com/watch?v=public-live';
const LIVE_URL = 'https://www.youtube.com/live/public-live';
const point = { x: 200, y: 120 };
const state = (adShowing: boolean, skipPoint: typeof point | null = null) => ({
  routeMatched: true,
  responseIdentityMatched: true,
  adShowing,
  buttonKind: skipPoint ? ('modern' as const) : null,
  skipPoint,
});

function sessionFor(states: ReturnType<typeof state>[]) {
  let index = 0;
  const session = {
    context: 'owned-context',
    evaluateJson: vi.fn(
      async (_expression: string, _timeoutMs?: number) =>
        states[Math.min(index++, states.length - 1)]
    ),
    command: vi.fn(async (_method: string, _params?: unknown, _timeoutMs?: number) => ({})),
  };
  return session;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('native public ad admission', () => {
  it('checks the exact route, response identity, and native button hit target in the page', async () => {
    const session = sessionFor([state(false)]);
    await admitNativePublicAd(session, WATCH_URL, 'public-live');
    const expression = session.evaluateJson.mock.calls[0]?.[0];
    expect(expression).toBeDefined();
    const script = new Script(expression ?? 'null');
    const button = {
      getBoundingClientRect: () => ({ left: 180, top: 100, width: 40, height: 40 }),
      getAttribute: () => null,
      contains: (element: unknown) => element === button,
    };
    const page = (source: Script, href: string, videoId: string, hit: unknown) =>
      source.runInNewContext({
        URL: globalThis.URL,
        getComputedStyle: () => ({
          visibility: 'visible',
          display: 'block',
          pointerEvents: 'auto',
        }),
        location: { href },
        window: { ytInitialPlayerResponse: { videoDetails: { videoId } } },
        document: {
          querySelector: () => ({
            classList: { contains: () => true },
            querySelector: () => button,
          }),
          elementFromPoint: () => hit,
        },
      });
    expect(page(script, WATCH_URL, 'public-live', button)).toMatchObject({
      routeMatched: true,
      responseIdentityMatched: true,
      skipPoint: point,
    });
    expect(page(script, WATCH_URL, 'public-live', {})).toMatchObject({ skipPoint: null });
    expect(
      page(script, 'https://www.youtube.com/watch?v=other', 'public-live', button)
    ).toMatchObject({
      routeMatched: false,
      skipPoint: null,
    });
    expect(page(script, WATCH_URL, 'other', button)).toMatchObject({
      responseIdentityMatched: false,
      skipPoint: null,
    });
    const liveSession = sessionFor([state(false)]);
    await admitNativePublicAd(liveSession, LIVE_URL, 'public-live');
    const liveScript = new Script(liveSession.evaluateJson.mock.calls[0]?.[0] ?? 'null');
    expect(page(liveScript, WATCH_URL, 'public-live', button)).toMatchObject({
      routeMatched: true,
      responseIdentityMatched: true,
      skipPoint: point,
    });
    expect(page(liveScript, LIVE_URL, 'public-live', button)).toMatchObject({
      routeMatched: true,
    });
    expect(
      page(liveScript, 'https://www.youtube.com/watch?v=other', 'public-live', button)
    ).toMatchObject({ routeMatched: false, skipPoint: null });
    expect(
      page(liveScript, 'https://www.youtube.com/live/other', 'public-live', button)
    ).toMatchObject({ routeMatched: false, skipPoint: null });
    expect(
      page(liveScript, 'https://www.youtube.com/shorts/public-live', 'public-live', button)
    ).toMatchObject({ routeMatched: false, skipPoint: null });
  });

  it('passes no ad and natural ad completion without input', async () => {
    const noAd = sessionFor([{ ...state(false), responseIdentityMatched: false }]);
    expect(await admitNativePublicAd(noAd, WATCH_URL, 'public-live')).toBe('no-ad');
    expect(noAd.command).not.toHaveBeenCalled();

    vi.useFakeTimers();
    const natural = sessionFor([state(true), state(true), state(false)]);
    const result = admitNativePublicAd(natural, WATCH_URL, 'public-live');
    await vi.runAllTimersAsync();
    expect(await result).toBe('natural-end');
    expect(natural.command).not.toHaveBeenCalled();
  });

  it('uses one freshly hit-tested native input and one release, then observes ad end', async () => {
    vi.useFakeTimers();
    const session = sessionFor([state(true), state(true, point), state(true, point), state(false)]);
    const result = admitNativePublicAd(session, WATCH_URL, 'public-live');
    await vi.runAllTimersAsync();
    expect(await result).toBe('native-skip');
    expect(session.command.mock.calls.map(([method]) => method)).toEqual([
      'input.performActions',
      'input.releaseActions',
    ]);
    expect(session.command.mock.calls[0]?.[1]).toHaveProperty('context', 'owned-context');
    expect(session.command.mock.calls[0]?.[1]).toHaveProperty('actions.0.actions.0', {
      type: 'pointerMove',
      origin: 'viewport',
      x: 200,
      y: 120,
    });
    expect(
      session.command.mock.calls.every(
        ([, , timeout]) => typeof timeout === 'number' && timeout > 0 && timeout <= 20_000
      )
    ).toBe(true);
  });

  it('sends no input for a covered button that later ends naturally', async () => {
    vi.useFakeTimers();
    const session = sessionFor([state(true), state(true), state(false)]);
    const result = admitNativePublicAd(session, WATCH_URL, 'public-live');
    await vi.runAllTimersAsync();
    expect(await result).toBe('natural-end');
    expect(session.command).not.toHaveBeenCalled();
  });

  it('rejects a button that changes during the fresh target check', async () => {
    const session = sessionFor([state(true), state(true, point), state(true)]);
    await expect(admitNativePublicAd(session, WATCH_URL, 'public-live')).rejects.toThrow(
      'native-skip-target-changed'
    );
    expect(session.command).not.toHaveBeenCalled();
  });

  it('rejects a route or response identity change before input', async () => {
    for (const mismatch of [
      { ...state(true, point), routeMatched: false },
      { ...state(true, point), responseIdentityMatched: false },
    ]) {
      const session = sessionFor([state(true), state(true, point), mismatch]);
      await expect(admitNativePublicAd(session, WATCH_URL, 'public-live')).rejects.toThrow(
        NativeAdAdmissionError
      );
      expect(session.command).not.toHaveBeenCalled();
    }
  });

  it('never makes a second Skip attempt and bounds a second ad', async () => {
    vi.useFakeTimers();
    const session = sessionFor([state(true), state(true, point), state(true, point)]);
    const result = admitNativePublicAd(session, WATCH_URL, 'public-live');
    const rejection = expect(result).rejects.toThrow('deadline-expired');
    await vi.runAllTimersAsync();
    await rejection;
    expect(session.command.mock.calls.map(([method]) => method)).toEqual([
      'input.performActions',
      'input.releaseActions',
    ]);
  });

  it.each(['action', 'release'])(
    'preserves a %s command timeout and sends bounded calls',
    async (at) => {
      const session = sessionFor([state(true), state(true, point), state(true, point)]);
      const timeout = new FirefoxBidiCommandTimeout('input.performActions', 7, 100);
      session.command.mockImplementation(async (method) => {
        if (
          (at === 'action' && method === 'input.performActions') ||
          (at === 'release' && method === 'input.releaseActions')
        )
          throw timeout;
        if (at === 'release') throw new Error('action failed');
        return {};
      });
      await expect(admitNativePublicAd(session, WATCH_URL, 'public-live')).rejects.toBe(timeout);
      expect(session.command.mock.calls.map(([method]) => method)).toEqual([
        'input.performActions',
        'input.releaseActions',
      ]);
    }
  );
});
