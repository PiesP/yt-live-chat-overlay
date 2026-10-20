// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { FirefoxBidiCommandTimeout } from './firefox-bidi.ts';

const ADMISSION_TIMEOUT_MS = 45_000;
const COMMAND_TIMEOUT_MS = 20_000;
const RELEASE_RESERVE_MS = 2_000;
const POLL_INTERVAL_MS = 250;

type AdSession = {
  context: string;
  evaluateJson: (expression: string, timeoutMs?: number) => Promise<unknown>;
  command: (
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number
  ) => Promise<unknown>;
};

type AdState = {
  routeMatched: boolean;
  responseIdentityMatched: boolean;
  adShowing: boolean;
  buttonKind: 'modern' | 'legacy' | 'container' | null;
  skipPoint: { x: number; y: number } | null;
};

export class NativeAdAdmissionError extends Error {
  constructor(reason: string) {
    super(`Public ad admission unverified: ${reason}`);
    this.name = 'NativeAdAdmissionError';
  }
}

function admissionExpression(expectedUrl: string, expectedVideoId: string): string {
  return `(() => {
    const expected = new URL(${JSON.stringify(expectedUrl)});
    const current = new URL(location.href);
    const routeMatched = current.origin === expected.origin && (
      (current.pathname === '/watch' && current.searchParams.get('v') === ${JSON.stringify(expectedVideoId)}) ||
      current.pathname === '/live/' + ${JSON.stringify(expectedVideoId)}
    );
    const responseIdentityMatched =
      window.ytInitialPlayerResponse?.videoDetails?.videoId === ${JSON.stringify(expectedVideoId)};
    const player = document.querySelector('#movie_player');
    const adShowing = player?.classList.contains('ad-showing') === true;
    let buttonKind = null;
    let skipPoint = null;
    if (routeMatched && responseIdentityMatched && adShowing) {
      const selectors = [
        '.ytp-ad-skip-button-modern',
        '.ytp-ad-skip-button',
        '.ytp-ad-skip-button-container button'
      ];
      for (let index = 0; index < selectors.length; index++) {
        const button = player.querySelector(selectors[index]);
        const rect = button?.getBoundingClientRect();
        if (!button || !rect || rect.width <= 0 || rect.height <= 0 ||
            button.disabled || button.getAttribute('aria-disabled') === 'true') continue;
        const style = getComputedStyle(button);
        if (style.visibility === 'hidden' || style.display === 'none' ||
            style.pointerEvents === 'none') continue;
        const x = Math.floor(rect.left + rect.width / 2);
        const y = Math.floor(rect.top + rect.height / 2);
        const hit = document.elementFromPoint(x, y);
        if (!hit || !button.contains(hit)) continue;
        buttonKind = ['modern', 'legacy', 'container'][index];
        skipPoint = { x, y };
        break;
      }
    }
    return { routeMatched, responseIdentityMatched, adShowing, buttonKind, skipPoint };
  })()`;
}

function remaining(deadline: number, reserve = 0): number {
  const ms = deadline - Date.now() - reserve;
  if (ms <= 0) throw new NativeAdAdmissionError('deadline-expired');
  return Math.min(COMMAND_TIMEOUT_MS, ms);
}

function requireIdentity(state: AdState): void {
  if (!state.routeMatched) throw new NativeAdAdmissionError('route-changed');
  if (!state.responseIdentityMatched)
    throw new NativeAdAdmissionError('content-identity-unavailable');
}

/** Admit one public ad by natural completion or one native hit-tested Skip action. */
export async function admitNativePublicAd(
  session: AdSession,
  expectedUrl: string,
  expectedVideoId: string | null
): Promise<'no-ad' | 'natural-end' | 'native-skip'> {
  if (!expectedVideoId) throw new NativeAdAdmissionError('expected-video-id-unavailable');
  const deadline = Date.now() + ADMISSION_TIMEOUT_MS;
  const expression = admissionExpression(expectedUrl, expectedVideoId);
  const read = async (reserve = 0): Promise<AdState> =>
    (await session.evaluateJson(expression, remaining(deadline, reserve))) as AdState;
  const first = await read();
  if (!first.routeMatched) throw new NativeAdAdmissionError('route-changed');
  if (!first.adShowing) return 'no-ad';
  requireIdentity(first);
  let skipAttempted = false;
  while (true) {
    const state = await read();
    if (!state.routeMatched) throw new NativeAdAdmissionError('route-changed');
    if (!state.adShowing) return skipAttempted ? 'native-skip' : 'natural-end';
    requireIdentity(state);
    if (!skipAttempted && state.skipPoint) {
      // A second page read closes the gap between seeing and targeting the button.
      const fresh = await read(RELEASE_RESERVE_MS);
      if (!fresh.routeMatched) throw new NativeAdAdmissionError('route-changed');
      if (!fresh.adShowing) return 'natural-end';
      requireIdentity(fresh);
      if (!fresh.skipPoint || fresh.buttonKind !== state.buttonKind)
        throw new NativeAdAdmissionError('native-skip-target-changed');
      if (fresh.skipPoint) {
        skipAttempted = true;
        let actionError: unknown;
        try {
          await session.command(
            'input.performActions',
            {
              context: session.context,
              actions: [
                {
                  type: 'pointer',
                  id: 'acceptance-ad-skip',
                  parameters: { pointerType: 'mouse' },
                  actions: [
                    { type: 'pointerMove', origin: 'viewport', ...fresh.skipPoint },
                    { type: 'pointerDown', button: 0 },
                    { type: 'pointerUp', button: 0 },
                  ],
                },
              ],
            },
            remaining(deadline, RELEASE_RESERVE_MS)
          );
        } catch (error) {
          actionError = error;
        }
        try {
          await session.command(
            'input.releaseActions',
            { context: session.context },
            remaining(deadline)
          );
        } catch (releaseError) {
          if (!actionError || releaseError instanceof FirefoxBidiCommandTimeout) {
            if (!(actionError instanceof FirefoxBidiCommandTimeout)) actionError = releaseError;
          }
        }
        if (actionError) throw actionError;
      }
    }
    const pauseMs = Math.min(POLL_INTERVAL_MS, deadline - Date.now());
    if (pauseMs <= 0) throw new NativeAdAdmissionError('deadline-expired');
    await new Promise<void>((resolve) => setTimeout(resolve, pauseMs));
  }
}
