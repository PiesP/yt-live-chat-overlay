// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/** Bounded #327 baseline: controlled viewing tasks, not a human usability verdict. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, win32 } from 'node:path';
import { promisify } from 'node:util';

import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';

import { mediaResponse } from './reload-feedback.ts';

const WATCH_URL = 'https://www.youtube.com/watch?v=windowsAcceptance';
const REPLAY_URL = 'https://www.youtube.com/watch?v=windowsAcceptanceReplay';
const SETTINGS_KEY = 'yt-live-chat-overlay-settings';
const MODAL = '#yt-chat-overlay-settings-backdrop';
const VIDEO_PREFIX = '/viewing-';
const IME_TITLE = 'YT Viewing IME Checkpoint';
const execFileAsync = promisify(execFile);
const MEDIA = {
  bright: 'de75569b7fd474c55080d8bc35aeb02b8a629010729de8dbd30dfe925522c14f',
  dark: '5c58845db4a7f37ddd3a15c7bd764e1cb05f28301ffe3d94234c9184f812d89a',
  detailed: 'dd98dd1a1b0a45847d1c199d4a1c74ea96867a813a9e79a9bcb987d737c0c484',
} as const;
type Scene = keyof typeof MEDIA;
type Case = { id: string; observations: unknown[]; screenshots: string[]; error?: string };
type PrimarySettingsGeometry = {
  controlsVisible: boolean;
  horizontalOverflow: boolean;
  paneScrollTop: number;
  pauseBesideEnabled: boolean;
  pauseTarget: boolean;
  pauseVisible: boolean;
  sampleInsidePane: boolean;
  sampleInsideStage: boolean;
};
type RouteState = {
  disconnected: boolean;
  faultStatus?: 403 | 503;
  faultRequests?: number;
  healthyPollRequests?: number;
  servedIds: string[];
  mediaRanges: string[];
  replayBatch?: string;
  replayRequests?: Array<{
    method: string;
    contentType: string | null;
    continuation: string | null;
    offsetMs: number | null;
    actions: number;
  }>;
};

declare global {
  interface Window {
    __ytViewingDenyWrites?: boolean;
    __ytViewingImeEvents?: Array<Record<string, unknown>>;
    __ytViewingImeTraceOverflow?: boolean;
    __ytViewingImeRecord?: (event: Record<string, unknown>) => void;
    __ytViewingPlayerSpaceHandler?: (event: KeyboardEvent) => void;
  }
}

export type ImeCheckpoint = {
  title: string;
  focus: string | null;
  input: string | null;
  editable?: string | null;
  settledInput?: string | null;
  settledEditable?: string | null;
  settledFocus?: string | null;
  events: Array<Record<string, unknown>>;
  traceOverflow?: boolean;
  videoPaused: boolean | null;
  videoTime: number | null;
  overlayPaused: boolean;
};
type NativeImeSequence =
  | 'ComposeCurrent'
  | 'ComposeToggleRoundTrip'
  | 'CtrlSpaceRoundTrip'
  | 'JapaneseCurrent'
  | 'JapaneseHiragana'
  | 'JapaneseDirect'
  | 'JapaneseDirectCtrlSpaceRoundTrip'
  | 'JapaneseToggleProbe'
  | 'JapaneseDuringComposition'
  | 'NativeSpace';
type NativeImeStage =
  | 'compose-initial'
  | 'compose-toggle'
  | 'ctrl-editable'
  | 'ctrl-noneditable'
  | 'compose-restoration'
  | 'japanese-initial'
  | 'japanese-textarea'
  | 'japanese-toggle-textarea'
  | 'japanese-toggle-confirm-textarea'
  | 'japanese-editable'
  | 'japanese-toggle-editable'
  | 'japanese-toggle-confirm-editable'
  | 'japanese-direct'
  | 'japanese-direct-editable'
  | 'japanese-direct-editable-shortcut'
  | 'japanese-composing-shortcut'
  | 'japanese-player-shortcut'
  | 'japanese-player-space'
  | 'japanese-player-space-resume'
  | 'japanese-after-pause'
  | 'japanese-toggle-after-pause'
  | 'japanese-toggle-confirm-after-pause'
  | 'japanese-mode-probe'
  | 'japanese-mode-restore'
  | 'japanese-restored-probe';
export type NativeControlSample = {
  atMs: number;
  focus: string | null;
  input: string | null;
  editable?: string | null;
  overlayPaused: boolean;
  videoPaused: boolean | null;
  videoTime: number | null;
};
type CompositionGate = {
  open: boolean;
  focus: string | null;
  eventCount: number;
  traceOverflow: boolean;
};
type DirectGate = {
  observed: boolean;
  focus: string | null;
  editable: string | null;
  eventCount: number;
  traceOverflow: boolean;
  atMs: number;
  overlayPaused: boolean;
  videoPaused: boolean | null;
  videoTime: number | null;
};
type NativeImeAction = {
  receiptFile: string;
  receipt: unknown;
  error: string | null;
  samples: NativeControlSample[];
  compositionGate: CompositionGate | undefined;
  directGate: DirectGate | undefined;
};

/** Require an unclosed trusted composition on the owned textarea at the key boundary. */
export function japaneseCompositionOpen(
  state: Pick<ImeCheckpoint, 'focus' | 'events' | 'traceOverflow'>
): boolean {
  if (state.focus !== 'yt-viewing-ime-input' || state.traceOverflow) return false;
  const events = state.events.filter((event) => event.target === 'yt-viewing-ime-input');
  const start = events.findLastIndex(
    (event) => event.type === 'compositionstart' && event.trusted === true
  );
  if (start < 0) return false;
  return (
    events
      .slice(start + 1)
      .some((event) => event.type === 'compositionupdate' && event.trusted === true) &&
    !events.slice(start + 1).some((event) => event.type === 'compositionend')
  );
}

/** Recognize the observed interruption of an open Japanese composition at Ctrl+Space. */
export function assertInterruptedJapaneseComposition(
  state: ImeCheckpoint,
  gate: CompositionGate | undefined
): {
  route: 'not-delivered-to-document';
  preGatePrefix: string;
  literalSpace: string;
  continuedComposition: string;
  committedText: string;
} {
  const target = 'yt-viewing-ime-input';
  assert(gate?.open === true && gate.focus === target && gate.traceOverflow === false);
  assert.equal(state.traceOverflow, false);
  assert(
    Number.isInteger(gate.eventCount) &&
      gate.eventCount > 0 &&
      gate.eventCount < state.events.length,
    'Open composition gate has no ordered event boundary'
  );
  const before = state.events.slice(0, gate.eventCount);
  const after = state.events.slice(gate.eventCount);
  assert(
    japaneseCompositionOpen({ focus: gate.focus, events: before, traceOverflow: false }),
    'Trusted Japanese composition was not open at the native shortcut gate'
  );
  const preUpdate = before.findLastIndex(
    (event) =>
      event.type === 'compositionupdate' &&
      event.target === target &&
      event.trusted === true &&
      typeof event.data === 'string'
  );
  const prefix = before[preUpdate]?.data;
  assert(
    typeof prefix === 'string' && prefix.length >= 2 && /[\u3040-\u309f]/u.test(prefix),
    'Open composition lacks a Japanese prefix'
  );
  assert(
    before.findIndex(
      (event, index) =>
        index > preUpdate &&
        event.type === 'input' &&
        event.target === target &&
        event.trusted === true &&
        event.inputType === 'insertCompositionText' &&
        event.data === prefix
    ) > preUpdate,
    'Open composition prefix was not delivered as trusted input'
  );
  const literalSpace = `${prefix} `;
  const spaceUpdate = after.findIndex(
    (event) =>
      event.type === 'compositionupdate' && event.target === target && event.trusted === true
  );
  const spaceInput = after.findIndex(
    (event, index) =>
      index > spaceUpdate &&
      event.type === 'input' &&
      event.target === target &&
      event.trusted === true &&
      event.inputType === 'insertCompositionText'
  );
  assert(
    spaceUpdate >= 0 &&
      after[spaceUpdate]?.data === literalSpace &&
      spaceInput > spaceUpdate &&
      after[spaceInput]?.data === literalSpace,
    'Native shortcut produced no trusted literal-space composition effect'
  );
  const continuedUpdate = after.findIndex(
    (event, index) =>
      index > spaceInput &&
      event.type === 'compositionupdate' &&
      event.target === target &&
      event.trusted === true &&
      typeof event.data === 'string' &&
      event.data.startsWith(literalSpace) &&
      event.data.length > literalSpace.length &&
      /[\u3040-\u309f\u4e00-\u9fff]/u.test(event.data.slice(literalSpace.length))
  );
  const continued = after[continuedUpdate]?.data;
  assert(typeof continued === 'string');
  assert(
    after
      .slice(spaceUpdate + 1, continuedUpdate)
      .every(
        (event) =>
          event.type !== 'compositionupdate' ||
          event.target !== target ||
          (event.trusted === true &&
            typeof event.data === 'string' &&
            event.data.startsWith(literalSpace))
      ),
    'Intermediate composition update lost the literal-space prefix'
  );
  const continuedInput = after.findIndex(
    (event, index) =>
      index > continuedUpdate &&
      event.type === 'input' &&
      event.target === target &&
      event.trusted === true &&
      event.inputType === 'insertCompositionText' &&
      event.data === continued
  );
  assert(
    continuedUpdate > spaceInput && continuedInput > continuedUpdate,
    'Japanese composition did not continue after the literal-space effect'
  );
  const commit = after.findLastIndex(
    (event, index) =>
      index > continuedInput &&
      event.type === 'compositionend' &&
      event.target === target &&
      typeof event.data === 'string' &&
      event.data.length > 0
  );
  const committed = after[commit]?.data;
  assert(
    typeof committed === 'string' &&
      committed !== prefix &&
      /[\u3040-\u309f\u4e00-\u9fff]/u.test(committed) &&
      committed === state.input &&
      committed === state.settledInput,
    'Actual Japanese commit and settled text differ'
  );
  assert(
    after.findIndex(
      (event, index) =>
        index > continuedInput &&
        index < commit &&
        event.type === 'input' &&
        event.target === target &&
        event.trusted === true &&
        event.inputType === 'insertCompositionText' &&
        event.data === committed
    ) > continuedInput,
    'Committed Japanese text lacks trusted input'
  );
  assert.equal(state.focus, target);
  assert.equal(state.settledFocus, target);
  assert.equal(state.overlayPaused, false);
  assert.equal(state.videoPaused, false);
  assert.equal(
    state.events.filter((event) => event.type === 'document-keydown').length,
    0,
    'Interrupted shortcut reached the document keydown listener'
  );
  assert.equal(state.events.filter((event) => event.type === 'post-ctrl-space').length, 0);
  return {
    route: 'not-delivered-to-document',
    preGatePrefix: prefix,
    literalSpace,
    continuedComposition: continued,
    committedText: committed,
  };
}

/** Require genuine direct Latin input in the owned editable before native shortcut dispatch. */
export function japaneseDirectGateObserved(
  state: Pick<
    ImeCheckpoint,
    'focus' | 'editable' | 'events' | 'traceOverflow' | 'overlayPaused' | 'videoPaused'
  >
): boolean {
  if (
    state.focus !== 'yt-viewing-ime-editable' ||
    state.editable !== 'nihongo' ||
    state.traceOverflow ||
    state.overlayPaused ||
    state.videoPaused !== false
  )
    return false;
  const target = state.events.filter((event) => event.target === 'yt-viewing-ime-editable');
  if (
    target.some((event) => String(event.type).startsWith('composition')) ||
    state.events.some((event) => event.type === 'document-keydown')
  )
    return false;
  let last = -1;
  for (const letter of 'nihongo') {
    const key = target.findIndex(
      (event, index) =>
        index > last &&
        event.type === 'keydown' &&
        event.trusted === true &&
        event.isComposing === false &&
        event.key === letter
    );
    const before = target.findIndex(
      (event, index) =>
        index > key &&
        event.type === 'beforeinput' &&
        event.trusted === true &&
        event.inputType === 'insertText' &&
        event.data === letter
    );
    const input = target.findIndex(
      (event, index) =>
        index > before &&
        event.type === 'input' &&
        event.trusted === true &&
        event.inputType === 'insertText' &&
        event.data === letter
    );
    if (key <= last || before <= key || input <= before) return false;
    last = input;
  }
  return true;
}

/** Accept only a fresh direct-control request shape; the native helper checks the matching ACK token. */
export function directControlGateToken(markerText: string): string {
  const request: unknown = JSON.parse(markerText);
  assert(request && typeof request === 'object' && !Array.isArray(request));
  assert('kind' in request && request.kind === 'direct-control');
  assert('target' in request && request.target === 'yt-viewing-ime-editable');
  assert(
    'token' in request && typeof request.token === 'string' && /^[0-9a-f]{32}$/u.test(request.token)
  );
  return request.token;
}

async function readNativeControlSample(page: Page): Promise<NativeControlSample> {
  return page.evaluate(() => {
    const input = document.querySelector<HTMLTextAreaElement>('#yt-viewing-ime-input');
    const editable = document.querySelector<HTMLElement>('#yt-viewing-ime-editable');
    const video = document.querySelector<HTMLVideoElement>('#movie_player video');
    return {
      atMs: performance.now(),
      focus: document.activeElement?.id ?? null,
      input: input?.value ?? null,
      editable: editable?.textContent ?? null,
      overlayPaused: Array.from(
        document.querySelectorAll<HTMLElement>('#yt-live-chat-overlay div')
      ).some((node) => node.textContent === 'Paused' && getComputedStyle(node).display !== 'none'),
      videoPaused: video?.paused ?? null,
      videoTime: video?.currentTime ?? null,
    };
  });
}

type ViewingImeSelection = 'not-run' | 'full' | 'only';

/** An opt-in selector keeps ordinary baseline runs free of native input. */
export async function readViewingImeSelection(root: string): Promise<ViewingImeSelection> {
  let contents: string;
  try {
    contents = await readFile(
      join(root, 'validation/windows/inputs/viewing-experience-ime.json'),
      'utf8'
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'not-run';
    throw error;
  }
  const selection: unknown = JSON.parse(contents);
  if (selection && typeof selection === 'object' && 'only' in selection) {
    assert.deepEqual(selection, { enabled: true, only: true }, 'Invalid viewing IME selector');
    return 'only';
  }
  assert.deepEqual(selection, { enabled: true }, 'Invalid viewing IME selector');
  return 'full';
}

async function ownedBrowserIdentity(
  browser: Browser,
  profile: string
): Promise<{ pid: number; profile: string }> {
  assert(
    win32.isAbsolute(profile) && win32.basename(profile).startsWith('yt-viewing-ime-chrome-'),
    'Native IME requires the dedicated owned Chrome profile'
  );
  const session = await browser.newBrowserCDPSession();
  try {
    const processInfo = await session.send('SystemInfo.getProcessInfo');
    const browsers = processInfo.processInfo.filter((entry) => entry.type === 'browser');
    assert.equal(browsers.length, 1, 'CDP must expose exactly one browser process');
    const pid = browsers[0]?.id;
    assert(
      typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffffffff,
      'Invalid browser PID'
    );
    return { pid, profile };
  } finally {
    await session.detach();
  }
}

async function runNativeImeAction({
  page,
  root,
  output,
  identity,
  sequence,
  stage,
  focus,
  koreanLayout = false,
  japaneseLayout = false,
}: {
  page: Page;
  root: string;
  output: string;
  identity: { pid: number; profile: string };
  sequence: NativeImeSequence;
  stage: NativeImeStage;
  focus: 'textarea' | 'editable' | 'player';
  koreanLayout?: boolean;
  japaneseLayout?: boolean;
}): Promise<NativeImeAction> {
  assert.equal(process.platform, 'win32', 'Native IME requires the Windows runner');
  await page.bringToFront();
  const targetFocused = await page.evaluate(
    ({ target, title }) => {
      const input = document.querySelector<HTMLTextAreaElement>('#yt-viewing-ime-input');
      const editable = document.querySelector<HTMLElement>('#yt-viewing-ime-editable');
      const player = document.querySelector<HTMLElement>('#movie_player');
      if (document.title !== title || !input?.isConnected || !player?.isConnected) return false;
      if (target === 'textarea') {
        input.focus();
        return document.activeElement === input && !input.disabled && !input.readOnly;
      }
      if (target === 'editable') {
        if (!editable?.isContentEditable) return false;
        editable.focus();
        return document.activeElement === editable;
      }
      if (player.isContentEditable) return false;
      player.setAttribute('tabindex', '-1');
      player.focus();
      return document.activeElement === player;
    },
    { target: focus, title: IME_TITLE }
  );
  assert(targetFocused, `Owned ${focus} focus or IME checkpoint title was lost`);
  const receiptFile = `viewing-ime-${stage}.json`;
  const receiptPath = join(output, receiptFile);
  const systemRoot = process.env.SystemRoot;
  assert(systemRoot && win32.isAbsolute(systemRoot), 'Windows SystemRoot is unavailable');
  const powershell = win32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    join(root, 'validation/windows/native-ime.ps1'),
    '-Sequence',
    sequence,
    '-ExpectedWindowTitle',
    IME_TITLE,
    '-ExpectedProfileDirectory',
    identity.profile,
    '-OwnedOutputDirectory',
    output,
    '-ReceiptPath',
    receiptPath,
    '-ExpectedBrowserPID',
    String(identity.pid),
  ];
  if (koreanLayout) args.push('-RequestExistingKoreanLayout');
  if (japaneseLayout) args.push('-RequestExistingJapaneseLayout');
  let error: string | null = null;
  const samples: NativeControlSample[] = [];
  const sampleAction =
    sequence === 'CtrlSpaceRoundTrip' ||
    sequence === 'JapaneseDuringComposition' ||
    sequence === 'JapaneseDirectCtrlSpaceRoundTrip';
  let sampling = sampleAction;
  let samplingError: string | null = null;
  let compositionGate: CompositionGate | undefined;
  let directGate: DirectGate | undefined;
  let gateError: string | null = null;
  const sampler = (async () => {
    while (sampling && samples.length < 600) {
      samples.push(await readNativeControlSample(page));
      if (sampling) await new Promise((resolve) => setTimeout(resolve, 75));
    }
  })().catch((cause: unknown) => {
    samplingError = String(cause);
  });
  const gate =
    sequence === 'JapaneseDuringComposition' || sequence === 'JapaneseDirectCtrlSpaceRoundTrip'
      ? (async () => {
          const marker = `${receiptPath}.pending`;
          const acknowledgement = `${receiptPath}.ack`;
          const deadline = Date.now() + 30_000;
          while (Date.now() < deadline) {
            try {
              const markerText = await readFile(marker, 'utf8');
              const observationDeadline = Math.min(deadline, Date.now() + 1_500);
              let token: string | undefined;
              if (sequence === 'JapaneseDirectCtrlSpaceRoundTrip') {
                token = directControlGateToken(markerText);
                do {
                  const observed = await page.evaluate(() => {
                    const editable = document.querySelector<HTMLElement>(
                      '#yt-viewing-ime-editable'
                    );
                    const video = document.querySelector<HTMLVideoElement>('#movie_player video');
                    return {
                      atMs: performance.now(),
                      focus: document.activeElement?.id ?? null,
                      editable: editable?.textContent ?? null,
                      events: window.__ytViewingImeEvents ?? [],
                      traceOverflow: window.__ytViewingImeTraceOverflow === true,
                      overlayPaused: Array.from(
                        document.querySelectorAll<HTMLElement>('#yt-live-chat-overlay div')
                      ).some(
                        (node) =>
                          node.textContent === 'Paused' && getComputedStyle(node).display !== 'none'
                      ),
                      videoPaused: video?.paused ?? null,
                      videoTime: video?.currentTime ?? null,
                    };
                  });
                  directGate = {
                    observed: japaneseDirectGateObserved(observed),
                    focus: observed.focus,
                    editable: observed.editable,
                    eventCount: observed.events.length,
                    traceOverflow: observed.traceOverflow,
                    atMs: observed.atMs,
                    overlayPaused: observed.overlayPaused,
                    videoPaused: observed.videoPaused,
                    videoTime: observed.videoTime,
                  };
                  if (directGate.observed || directGate.traceOverflow) break;
                  await new Promise((resolve) => setTimeout(resolve, 50));
                } while (Date.now() < observationDeadline);
                assert(directGate);
              } else {
                do {
                  const observed = await page.evaluate(() => ({
                    focus: document.activeElement?.id ?? null,
                    events: window.__ytViewingImeEvents ?? [],
                    traceOverflow: window.__ytViewingImeTraceOverflow === true,
                  }));
                  compositionGate = {
                    open: japaneseCompositionOpen(observed),
                    focus: observed.focus,
                    eventCount: observed.events.length,
                    traceOverflow: observed.traceOverflow,
                  };
                  if (compositionGate.open || compositionGate.traceOverflow) break;
                  await new Promise((resolve) => setTimeout(resolve, 50));
                } while (Date.now() < observationDeadline);
                assert(compositionGate);
              }
              await writeFile(
                `${acknowledgement}.tmp`,
                JSON.stringify({
                  allow:
                    sequence === 'JapaneseDirectCtrlSpaceRoundTrip'
                      ? directGate?.observed === true
                      : compositionGate?.open === true,
                  ...(token ? { token } : {}),
                }),
                { flag: 'wx' }
              );
              await rename(`${acknowledgement}.tmp`, acknowledgement);
              return;
            } catch (cause) {
              if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
            }
            await new Promise((resolve) => setTimeout(resolve, 40));
          }
          throw new Error('Native composition gate marker did not arrive within 30 seconds');
        })().catch((cause: unknown) => {
          gateError = String(cause);
        })
      : Promise.resolve();
  try {
    await execFileAsync(powershell, args, { timeout: 45_000, maxBuffer: 4_096, windowsHide: true });
  } catch (cause) {
    const failure = cause as { code?: string | number; signal?: string; killed?: boolean };
    error = `Native helper failed (code=${String(failure.code ?? 'unknown')}, signal=${String(failure.signal ?? 'none')}, timedOut=${failure.killed === true})`;
  } finally {
    await gate;
    const directGateAtMs = directGate?.observed === true ? directGate.atMs : null;
    if (sequence === 'JapaneseDirectCtrlSpaceRoundTrip' && directGateAtMs !== null) {
      const until = Date.now() + 1_500;
      while (Date.now() < until && samplingError === null) {
        const postGate = samples.filter((sample) => sample.atMs >= directGateAtMs);
        const first = postGate[0];
        const last = postGate.at(-1);
        if (postGate.length >= 8 && first && last && last.atMs - first.atMs >= 500) break;
        await new Promise((resolve) => setTimeout(resolve, 75));
      }
    }
    sampling = false;
    await sampler;
    if (sampleAction && samplingError === null) {
      try {
        samples.push(await readNativeControlSample(page));
      } catch (cause) {
        samplingError = String(cause);
      }
    }
    if (samplingError !== null) error ??= `Native control sampler failed (${samplingError})`;
    if (gateError !== null) error ??= `Native composition gate failed (${gateError})`;
  }
  let receipt: unknown = null;
  try {
    receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  } catch (cause) {
    const failure = cause as NodeJS.ErrnoException;
    error ??= `Native helper left no readable receipt (${failure.code ?? 'invalid-json'})`;
  }
  return { receiptFile, receipt, error, samples, compositionGate, directGate };
}

function assertNativeImeAction(
  action: NativeImeAction,
  sequence: NativeImeSequence,
  koreanLayout: boolean,
  japaneseLayout = false
): void {
  assert.equal(action.error, null, `${sequence} native action failed`);
  const receipt = action.receipt as {
    status?: unknown;
    sequence?: unknown;
    requestedExistingKoreanLayout?: unknown;
    requestedExistingJapaneseLayout?: unknown;
    target?: { profileMatched?: unknown };
    layoutDelivery?: {
      requestPosted?: unknown;
      requestAcknowledged?: unknown;
      restorePosted?: unknown;
      restoreAcknowledged?: unknown;
      processingUncertain?: unknown;
    };
    cleanup?: {
      releasedKeys?: unknown;
      pressedKeysRemaining?: unknown;
      togglePending?: unknown;
      parityActionsBalanced?: unknown;
      hklRestored?: unknown;
    };
    sendCounts?: { acceptedEvents?: unknown };
    actions?: Array<{ kind?: unknown; label?: unknown; accepted?: unknown; atMs?: unknown }>;
    errors?: unknown;
  } | null;
  assert.equal(receipt?.status, 'action-dispatched');
  assert.equal(receipt?.sequence, sequence);
  assert.equal(receipt?.requestedExistingKoreanLayout, koreanLayout);
  assert.equal(receipt?.requestedExistingJapaneseLayout, japaneseLayout);
  assert.equal(receipt?.target?.profileMatched, true);
  assert.deepEqual(receipt?.errors, []);
  assert.equal(receipt?.cleanup?.releasedKeys, true);
  assert.equal(receipt?.cleanup?.pressedKeysRemaining, 0);
  assert.equal(receipt?.cleanup?.togglePending, null);
  assert.equal(receipt?.cleanup?.hklRestored, 'verified');
  assert.equal(
    receipt?.cleanup?.parityActionsBalanced,
    sequence === 'ComposeToggleRoundTrip' ||
      sequence === 'CtrlSpaceRoundTrip' ||
      sequence === 'JapaneseDirectCtrlSpaceRoundTrip'
      ? true
      : 'not-applicable'
  );
  assert.equal(receipt?.layoutDelivery?.processingUncertain, false);
  if (receipt?.layoutDelivery?.requestPosted) {
    assert.equal(receipt.layoutDelivery.requestAcknowledged, true);
  }
  if (receipt?.layoutDelivery?.restorePosted) {
    assert.equal(receipt.layoutDelivery.restoreAcknowledged, true);
  }
  if (sequence === 'CtrlSpaceRoundTrip') {
    assert.equal(receipt?.sendCounts?.acceptedEvents, 8);
    const actions = receipt?.actions?.filter((entry) => entry.kind === 'keyboard') ?? [];
    assert.deepEqual(
      actions.map((entry) => [entry.label, entry.accepted]),
      [
        ['Ctrl-Space-pause', 4],
        ['Ctrl-Space-resume', 4],
      ]
    );
    const firstAtMs = actions[0]?.atMs;
    const secondAtMs = actions[1]?.atMs;
    assert(typeof firstAtMs === 'number' && typeof secondAtMs === 'number');
    assert(secondAtMs - firstAtMs >= 500, 'Native Ctrl+Space actions were not separated by 500 ms');
  }
}

export function imeWordBehavior(state: ImeCheckpoint): 'hangul' | 'latin' | 'unknown' {
  const compositionTypes = ['compositionstart', 'compositionupdate', 'compositionend'];
  const trustedComposition = state.events.filter(
    (event) => event.trusted === true && compositionTypes.includes(String(event.type))
  );
  const start = state.events.findIndex(
    (event) => event.type === 'compositionstart' && event.trusted === true
  );
  const update = state.events.findIndex(
    (event, index) => index > start && event.type === 'compositionupdate' && event.trusted === true
  );
  const end = state.events.findIndex(
    (event, index) =>
      index > update &&
      event.type === 'compositionend' &&
      typeof event.data === 'string' &&
      event.data.length > 0
  );
  const keydowns = state.events.filter((event) => event.type === 'keydown');
  const lastKey = keydowns.at(-1);
  if (
    state.input?.trim() === '한글' &&
    state.settledInput === state.input &&
    state.settledFocus === 'yt-viewing-ime-input' &&
    start >= 0 &&
    update > start &&
    end > update &&
    state.events.some(
      (event) =>
        event.type === 'keydown' &&
        event.trusted === true &&
        event.key === 'Process' &&
        event.isComposing === true
    ) &&
    state.events.some((event) => event.type === 'input' && event.trusted === true) &&
    lastKey?.trusted === true &&
    lastKey.key === ' ' &&
    lastKey.isComposing === false
  ) {
    return 'hangul';
  }
  if (state.input?.trim() === 'gksrmf' && trustedComposition.length === 0) return 'latin';
  return 'unknown';
}

/** Classify actual committed text and trusted browser events, never the requested HKL alone. */
export function japaneseWordBehavior(
  state: ImeCheckpoint,
  target: 'textarea' | 'editable'
): 'converted-japanese' | 'direct-latin' | 'unknown' {
  if (state.traceOverflow) return 'unknown';
  const targetId = target === 'textarea' ? 'yt-viewing-ime-input' : 'yt-viewing-ime-editable';
  const text = target === 'textarea' ? state.input : state.editable;
  const settled = target === 'textarea' ? state.settledInput : state.settledEditable;
  const events = state.events.filter((event) => event.target === targetId);
  const trustedInput = events.some((event) => event.type === 'input' && event.trusted === true);
  if (!text || settled !== text || state.settledFocus !== targetId || !trustedInput)
    return 'unknown';
  const compositionStart = events.findIndex(
    (event) => event.type === 'compositionstart' && event.trusted === true
  );
  const compositionUpdate = events.findIndex(
    (event, index) =>
      index > compositionStart && event.type === 'compositionupdate' && event.trusted === true
  );
  const compositionEnd = events.findIndex(
    (event, index) =>
      index > compositionUpdate &&
      event.type === 'compositionend' &&
      typeof event.data === 'string' &&
      event.data.length > 0
  );
  let committedText = text === '日本語';
  if (
    target === 'textarea' &&
    text === '日本語\n' &&
    compositionEnd >= 0 &&
    events[compositionEnd]?.data === '日本語'
  ) {
    const enter = events.findIndex(
      (event, index) =>
        index > compositionEnd &&
        event.type === 'keydown' &&
        event.key === 'Enter' &&
        event.trusted === true &&
        event.isComposing === false
    );
    const beforeLineBreak = events.findIndex(
      (event, index) =>
        index > enter &&
        event.type === 'beforeinput' &&
        event.trusted === true &&
        event.inputType === 'insertLineBreak'
    );
    const lineBreak = events.findIndex(
      (event, index) =>
        index > beforeLineBreak &&
        event.type === 'input' &&
        event.trusted === true &&
        event.inputType === 'insertLineBreak'
    );
    committedText =
      enter > compositionEnd && beforeLineBreak > enter && lineBreak > beforeLineBreak;
  }
  if (
    committedText &&
    compositionStart >= 0 &&
    compositionUpdate > compositionStart &&
    compositionEnd > compositionUpdate
  )
    return 'converted-japanese';
  if (text.trim() === 'nihongo' && compositionStart === -1 && compositionUpdate === -1) {
    return 'direct-latin';
  }
  return 'unknown';
}

/** One IME on/off diagnostic is permitted only after direct text was observed. */
export function assertJapaneseToggleProbeAllowed(
  state: ImeCheckpoint,
  target: 'textarea' | 'editable'
): void {
  assert.equal(
    japaneseWordBehavior(state, target),
    'direct-latin',
    'Alt+Backquote requires observed direct Latin input in this target'
  );
}

/** A mode request alone cannot prove restoration; require a later unforced native word. */
export function japaneseModeRestored(
  initial: ReturnType<typeof japaneseWordBehavior>,
  probe: { sequence: NativeImeSequence; behavior: ReturnType<typeof japaneseWordBehavior> }
): boolean {
  return (
    initial !== 'unknown' && probe.sequence === 'JapaneseCurrent' && probe.behavior === initial
  );
}

/** Restoration alone does not prove that Japanese conversion survived the Pause actions. */
export function japaneseNativeBehaviorVerdict(
  postPauseBehavior: ReturnType<typeof japaneseWordBehavior>,
  modeRestored: boolean,
  capsLockComparison: 'same' | 'changed' | 'unverified'
): { status: 'Pass' | 'Fail' | 'Not run'; reason?: string } {
  if (postPauseBehavior !== 'converted-japanese') {
    return { status: 'Fail', reason: 'A committed Japanese word after Pause was not observed.' };
  }
  if (!modeRestored) {
    return { status: 'Fail', reason: 'The original observed input mode was not restored.' };
  }
  if (capsLockComparison === 'changed') {
    return { status: 'Fail', reason: 'Browser-observed Caps Lock state changed.' };
  }
  return capsLockComparison === 'same'
    ? { status: 'Pass' }
    : {
        status: 'Not run',
        reason: 'Caps Lock preservation was not observable in native key events.',
      };
}

/** Compare browser-observed Caps Lock state on native word keys, never helper-thread state. */
export function japaneseCapsLockComparison(
  initial: ImeCheckpoint,
  final: ImeCheckpoint
): 'same' | 'changed' | 'unverified' {
  const observed = (state: ImeCheckpoint): boolean | null => {
    if (state.traceOverflow) return null;
    const values = new Set(
      state.events
        .filter(
          (event) =>
            event.type === 'keydown' &&
            event.target === 'yt-viewing-ime-input' &&
            event.trusted === true &&
            typeof event.capsLock === 'boolean'
        )
        .map((event) => event.capsLock as boolean)
    );
    const sole = values.values().next().value;
    return values.size === 1 && typeof sole === 'boolean' ? sole : null;
  };
  const before = observed(initial);
  const after = observed(final);
  if (before === null || after === null) return 'unverified';
  return before === after ? 'same' : 'changed';
}

/** Every selected Japanese case must pass before the native run can claim verification. */
export function japaneseIncompleteVerdicts(
  verdicts: Record<string, { status: 'Pass' | 'Fail' | 'Not run'; reason?: string }>
): string[] {
  return (['JI-01', 'JI-02', 'JI-03', 'JI-04'] as const).flatMap((id) => {
    const verdict = verdicts[id];
    return verdict?.status === 'Pass'
      ? []
      : [`${id}: ${verdict?.status ?? 'missing'}${verdict?.reason ? ` (${verdict.reason})` : ''}`];
  });
}

function assertJapaneseNativeReceipt(action: NativeImeAction, sequence: NativeImeSequence): void {
  assertNativeImeAction(action, sequence, false, true);
  const receipt = action.receipt as {
    actions?: Array<{ kind?: string; label?: string; accepted?: number; atMs?: number }>;
    sendCounts?: { acceptedEvents?: number };
  };
  const keyboard = receipt.actions?.filter((entry) => entry.kind === 'keyboard') ?? [];
  const labels = keyboard.map((entry) => entry.label);
  assert(keyboard.every((entry) => entry.accepted === 2 || entry.accepted === 4));
  if (sequence === 'NativeSpace') {
    assert.deepEqual(labels, ['native-player-space']);
    assert.equal(receipt.sendCounts?.acceptedEvents, 2);
    return;
  }
  if (sequence === 'JapaneseDirect') {
    assert.equal(labels[0], 'Japanese-Shift-CapsLock-Alphanumeric');
    assert(!labels.includes('japanese-conversion-candidate'));
  }
  if (sequence === 'JapaneseDirectCtrlSpaceRoundTrip') {
    assert.deepEqual(labels, [
      'Japanese-Shift-CapsLock-Alphanumeric',
      ...[0x4e, 0x49, 0x48, 0x4f, 0x4e, 0x47, 0x4f].map(
        (key) => `japanese-word-vk-${key.toString(16).toUpperCase()}`
      ),
      'japanese-commit',
      'Ctrl-Space-pause',
      'Ctrl-Space-resume',
    ]);
    assert.equal(receipt.sendCounts?.acceptedEvents, 28);
    const gateLabels = receipt.actions
      ?.filter((entry) => entry.kind === 'direct-control-gate')
      .map((entry) => entry.label);
    assert.deepEqual(gateLabels, [
      'direct-observation-requested',
      'direct-observation-acknowledged',
    ]);
    const actions = receipt.actions ?? [];
    const acknowledged = actions.findIndex(
      (entry) => entry.label === 'direct-observation-acknowledged'
    );
    const pause = actions.findIndex((entry) => entry.label === 'Ctrl-Space-pause');
    const resume = actions.findIndex((entry) => entry.label === 'Ctrl-Space-resume');
    assert(
      acknowledged > 0 && pause === acknowledged + 1 && resume === pause + 1,
      'Native direct mode changed between browser observation and Ctrl+Space actions'
    );
    const pauseAt = actions[pause]?.atMs;
    const resumeAt = actions[resume]?.atMs;
    assert(
      typeof pauseAt === 'number' && typeof resumeAt === 'number' && resumeAt - pauseAt >= 500
    );
    return;
  }
  if (sequence === 'JapaneseHiragana') assert.equal(labels[0], 'Japanese-Ctrl-CapsLock-Hiragana');
  if (sequence === 'JapaneseToggleProbe') {
    assert.equal(labels[0], 'Japanese-Alt-Backquote-IME-toggle');
    assert.equal(labels.filter((label) => label === 'Japanese-Alt-Backquote-IME-toggle').length, 1);
  }
  if (sequence === 'JapaneseDuringComposition') {
    const pending = labels.indexOf('japanese-pending-vk-4E');
    const shortcut = labels.indexOf('Japanese-Ctrl-Space-during-composition');
    const finish = labels.indexOf('japanese-finish-vk-47');
    assert(pending >= 0 && shortcut > pending && finish > shortcut);
    const gateLabels = receipt.actions
      ?.filter((entry) => entry.kind === 'composition-gate')
      .map((entry) => entry.label);
    assert.deepEqual(gateLabels, [
      'pending-observation-requested',
      'open-observation-acknowledged',
    ]);
  }
  if (sequence !== 'JapaneseDirect' && sequence !== 'CtrlSpaceRoundTrip') {
    assert(labels.includes('japanese-conversion-candidate'));
  }
  if (sequence !== 'CtrlSpaceRoundTrip') assert.equal(labels.at(-1), 'japanese-commit');
}

export function assertJapaneseShortcut(
  state: ImeCheckpoint,
  samples: NativeControlSample[],
  focus: 'yt-viewing-ime-input' | 'yt-viewing-ime-editable' | 'movie_player',
  originalText: string | null
): 'delivered' | 'document-ignored' | 'not-delivered-to-document' {
  assert.equal(state.traceOverflow, false, 'Japanese IME trace overflowed');
  const targetText = focus === 'yt-viewing-ime-editable' ? state.editable : state.input;
  assert.equal(targetText, originalText, 'Japanese shortcut changed committed text');
  const presses = state.events.filter((event) => event.type === 'document-keydown');
  const settled = state.events.filter((event) => event.type === 'post-ctrl-space');
  assert.equal(presses.length, settled.length);
  assert(
    presses.length === 0 || presses.length === 2,
    'Incomplete Japanese native shortcut delivery'
  );
  assert.equal(state.focus, focus);
  assert.equal(state.overlayPaused, false);
  assert.equal(state.videoPaused, false);
  assert(samples.length >= 8, 'Native Japanese shortcut sampler missed an action');
  const first = samples[0];
  const last = samples.at(-1);
  assert(first && last && last.atMs - first.atMs >= 500);
  assert(
    samples.every(
      (sample) =>
        sample.focus === focus &&
        sample.videoPaused === false &&
        (focus === 'yt-viewing-ime-editable' ? sample.editable : sample.input) === originalText &&
        typeof sample.videoTime === 'number'
    ),
    'Focused text or video changed during Japanese shortcut'
  );
  const midpoint = Math.floor(samples.length / 2);
  for (const section of [samples.slice(0, midpoint + 1), samples.slice(midpoint)]) {
    assert(
      section.some((sample, index) => {
        const previous = section[index - 1];
        return (
          previous &&
          typeof sample.videoTime === 'number' &&
          typeof previous.videoTime === 'number' &&
          (sample.videoTime > previous.videoTime + 0.02 ||
            sample.videoTime < previous.videoTime - 1)
        );
      }),
      'Video did not advance across both Japanese shortcut actions'
    );
  }
  if (presses.length === 2) {
    assert(presses.every((event) => event.trusted === true && event.focus === focus));
    assert.deepEqual(
      settled.map((event) => event.overlayPaused),
      focus === 'movie_player' ? [true, false] : [false, false]
    );
    assert(settled.every((event) => event.videoPaused === false));
    return focus === 'movie_player' ? 'delivered' : 'document-ignored';
  }
  assert(samples.every((sample) => sample.overlayPaused === false));
  return 'not-delivered-to-document';
}

/** Compare both native Ctrl+Space actions to the direct text observed inside that same action. */
export function assertJapaneseDirectShortcut(
  state: ImeCheckpoint,
  samples: NativeControlSample[],
  gate: DirectGate | undefined
): 'delivered' | 'document-ignored' | 'not-delivered-to-document' {
  assert(
    gate?.observed === true &&
      gate.traceOverflow === false &&
      Number.isInteger(gate.eventCount) &&
      gate.eventCount > 0 &&
      gate.eventCount <= state.events.length &&
      Number.isFinite(gate.atMs),
    'Direct Latin input was not observed at the same native action boundary'
  );
  assert(
    japaneseDirectGateObserved({
      focus: gate.focus,
      editable: gate.editable,
      events: state.events.slice(0, gate.eventCount),
      traceOverflow: gate.traceOverflow,
      overlayPaused: gate.overlayPaused,
      videoPaused: gate.videoPaused,
    }),
    'Trusted direct Latin trace changed before Ctrl+Space'
  );
  assert.equal(state.settledEditable, gate.editable);
  assert.equal(state.settledFocus, gate.focus);
  assert(
    typeof gate.videoTime === 'number' &&
      typeof state.videoTime === 'number' &&
      (state.videoTime > gate.videoTime + 0.02 || state.videoTime < gate.videoTime - 1),
    'Video did not advance from the observed direct-input gate'
  );
  const shortcutSamples = samples.filter((sample) => sample.atMs >= gate.atMs);
  return assertJapaneseShortcut(state, shortcutSamples, 'yt-viewing-ime-editable', gate.editable);
}

/** The fixture player model must receive exactly one trusted native Space per action. */
export function assertJapanesePlayerSpace(state: ImeCheckpoint, expectedPaused: boolean): void {
  assert.equal(state.traceOverflow, false, 'Japanese IME trace overflowed');
  const events = state.events.filter((event) => event.type === 'fixture-native-player-space');
  assert.equal(events.length, 1, 'Fixture player did not receive exactly one native Space');
  assert.equal(events[0]?.trusted, true);
  assert.equal(events[0]?.focus, 'movie_player');
  assert.equal(state.focus, 'movie_player');
  assert.equal(state.videoPaused, expectedPaused);
  assert.equal(state.overlayPaused, false);
}

function observedCompositionEnds(state: ImeCheckpoint): Array<{ data: unknown; trusted: unknown }> {
  return state.events
    .filter((event) => event.type === 'compositionend')
    .map((event) => ({ data: event.data, trusted: event.trusted }));
}

export function assertNativeCtrlSpace(
  state: ImeCheckpoint,
  expectedFocus: 'yt-viewing-ime-input' | 'movie_player',
  expectedOverlay: boolean[]
): void {
  const presses = state.events.filter((event) => event.type === 'document-keydown');
  const settled = state.events.filter((event) => event.type === 'post-ctrl-space');
  assert.equal(presses.length, 2, 'Expected two native Ctrl+Space keydown events');
  assert(
    presses.every((event) => event.trusted === true && event.focus === expectedFocus),
    'Trusted native Ctrl+Space did not keep the expected focus'
  );
  assert.equal(settled.length, 2, 'Expected two settled native Ctrl+Space observations');
  assert(settled.every((event) => event.focus === expectedFocus));
  assert.deepEqual(
    settled.map((event) => event.overlayPaused),
    expectedOverlay
  );
  assert.deepEqual(
    settled.map((event) => event.videoPaused),
    [false, false]
  );
  assert(
    settled.every((event) => typeof event.videoTime === 'number'),
    'Video time was unavailable during native Ctrl+Space'
  );
  assert.equal(state.overlayPaused, false);
  assert.equal(state.videoPaused, false);
}

/** The Korean IME may consume Ctrl+Space before a document shortcut is dispatched. */
export function assertNativeEditableCtrlSpace(
  state: ImeCheckpoint,
  samples: NativeControlSample[],
  originalInput: string | null
): 'document-shortcut-ignored' | 'ime-consumed-before-document' {
  assert.equal(originalInput?.trim(), '한글');
  assert.equal(state.input, originalInput, 'Native Ctrl+Space changed the composed input');
  const documentPresses = state.events.filter((event) => event.type === 'document-keydown');
  const settledPresses = state.events.filter((event) => event.type === 'post-ctrl-space');
  if (documentPresses.length > 0 || settledPresses.length > 0) {
    assertNativeCtrlSpace(state, 'yt-viewing-ime-input', [false, false]);
    return 'document-shortcut-ignored';
  }

  assert.equal(state.focus, 'yt-viewing-ime-input');
  assert.equal(state.overlayPaused, false);
  assert.equal(state.videoPaused, false);
  assert(samples.length >= 8, 'Native Ctrl+Space sampler did not cover both actions');
  const first = samples[0];
  const last = samples.at(-1);
  assert(first && last && last.atMs - first.atMs >= 500);
  assert(
    samples.every(
      (sample) =>
        sample.focus === 'yt-viewing-ime-input' &&
        sample.input === originalInput &&
        sample.overlayPaused === false &&
        sample.videoPaused === false &&
        typeof sample.videoTime === 'number'
    ),
    'Focused input, overlay, or video changed during native Ctrl+Space'
  );
  const videoProgressed = (part: NativeControlSample[]): boolean =>
    part.some((sample, index) => {
      const previous = part[index - 1];
      return (
        previous &&
        typeof previous.videoTime === 'number' &&
        typeof sample.videoTime === 'number' &&
        (sample.videoTime > previous.videoTime + 0.02 || sample.videoTime < previous.videoTime - 1)
      );
    });
  const midpoint = Math.floor(samples.length / 2);
  assert(
    videoProgressed(samples.slice(0, midpoint + 1)) && videoProgressed(samples.slice(midpoint)),
    'Video did not advance across both native Ctrl+Space actions'
  );
  return 'ime-consumed-before-document';
}

/** Preserve the native shortcut outcome even when the Korean IME owns it outside text input. */
export function assertNativePlayerCtrlSpace(
  state: ImeCheckpoint,
  samples: NativeControlSample[],
  originalInput: string | null
): 'delivered' | 'unavailable-ime-consumed' {
  const documentPresses = state.events.filter((event) => event.type === 'document-keydown');
  const settledPresses = state.events.filter((event) => event.type === 'post-ctrl-space');
  if (documentPresses.length > 0 || settledPresses.length > 0) {
    assertNativeCtrlSpace(state, 'movie_player', [true, false]);
    return 'delivered';
  }

  assert.equal(state.focus, 'movie_player');
  assert.equal(state.input, originalInput);
  assert.equal(state.overlayPaused, false);
  assert.equal(state.videoPaused, false);
  assert(samples.length >= 8, 'Native player shortcut sampler did not cover both actions');
  const first = samples[0];
  const last = samples.at(-1);
  assert(first && last && last.atMs - first.atMs >= 500);
  assert(
    samples.every(
      (sample) =>
        sample.focus === 'movie_player' &&
        sample.input === originalInput &&
        sample.overlayPaused === false &&
        sample.videoPaused === false &&
        typeof sample.videoTime === 'number'
    ),
    'Player, overlay, or video changed during the unavailable native shortcut'
  );
  const midpoint = Math.floor(samples.length / 2);
  for (const part of [samples.slice(0, midpoint + 1), samples.slice(midpoint)]) {
    assert(
      part.some((sample, index) => {
        const previous = part[index - 1];
        return (
          previous &&
          typeof previous.videoTime === 'number' &&
          typeof sample.videoTime === 'number' &&
          (sample.videoTime > previous.videoTime + 0.02 ||
            sample.videoTime < previous.videoTime - 1)
        );
      }),
      'Video did not advance across the native player shortcut attempt'
    );
  }
  return 'unavailable-ime-consumed';
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function watchPage(html: string): string {
  assert.match(html, /<video aria-label="Acceptance fixture video"/u);
  return html
    .replace(
      '</head>',
      '<style>body.yt-viewing-theater .player-wrapper{max-width:none!important;width:100vw!important}' +
        'body.yt-viewing-theater #movie_player{height:85vh!important}' +
        '#yt-viewing-controls{position:fixed;right:8px;bottom:8px;z-index:1000}</style></head>'
    )
    .replace(
      '</body>',
      '<div id="yt-viewing-controls"><button id="yt-viewing-theater" type="button">Theater</button>' +
        '<button id="yt-viewing-fullscreen" type="button">Fullscreen</button></div></body>'
    );
}

function chatItem(id: string, kind: 'text' | 'paid', text: string): unknown {
  const authorName = { simpleText: `Viewing author ${id}` };
  if (kind === 'paid') {
    return {
      addChatItemAction: {
        item: {
          liveChatPaidMessageRenderer: {
            id,
            authorName,
            purchaseAmountText: { simpleText: '$5.00' },
            message: { runs: [{ text }] },
          },
        },
      },
    };
  }
  return {
    addChatItemAction: {
      item: { liveChatTextMessageRenderer: { id, authorName, message: { runs: [{ text }] } } },
    },
  };
}

function messages(batch: string, count: number, replay: boolean, offsetMs = 0): unknown[] {
  const texts = [
    'Short',
    'A long English comment about keeping the subtitle and player controls readable while comments move across the detailed footage.',
    '😀🌟 긴 한국어 댓글에서 자막과 재생 버튼을 가리지 않고 핵심 내용을 끝까지 읽을 수 있는지 확인합니다.',
    '有料メッセージと字幕の読みやすさを確認する長い日本語コメントです。',
    'Original chat for the controlled English to Korean translation example.',
  ];
  return Array.from({ length: count }, (_, index) => {
    const id = `viewing-${batch}-${index}`;
    const item = chatItem(id, index % 5 === 3 ? 'paid' : 'text', texts[index % texts.length] ?? '');
    return replay
      ? { replayChatItemAction: { videoOffsetTimeMsec: offsetMs, actions: [item] } }
      : item;
  });
}

async function installFixture(
  context: BrowserContext,
  userscript: string,
  html: string,
  media: Record<Scene, Buffer>,
  state: RouteState,
  language = 'en'
): Promise<void> {
  await context.route(/^https?:\/\//u, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'www.youtube.com') {
      await route.fulfill({ status: 204 });
      return;
    }
    if (route.request().resourceType() === 'document') {
      await route.fulfill({ status: 200, contentType: 'text/html', body: html });
      return;
    }
    const scene = url.pathname.slice(VIDEO_PREFIX.length, -'.mp4'.length) as Scene;
    if (url.pathname.startsWith(VIDEO_PREFIX) && Object.hasOwn(MEDIA, scene)) {
      const bytes = media[scene];
      const range = route.request().headers()['range'] ?? null;
      if (state.mediaRanges.length < 30) state.mediaRanges.push(range ?? 'none');
      await route.fulfill({ ...mediaResponse(bytes, range), contentType: 'video/mp4' });
      return;
    }
    if (url.pathname.startsWith('/youtubei/v1/live_chat/get_live_chat')) {
      if (state.disconnected) {
        state.faultRequests = (state.faultRequests ?? 0) + 1;
        await route.fulfill({ status: state.faultStatus ?? 503, body: 'Controlled disconnection' });
        return;
      }
      if (!url.searchParams.has('fixture-batch')) {
        state.healthyPollRequests = (state.healthyPollRequests ?? 0) + 1;
      }
      const replay = url.pathname.endsWith('get_live_chat_replay');
      let batch = url.searchParams.get('fixture-batch');
      let count = Math.min(15, Math.max(0, Number(url.searchParams.get('fixture-count') ?? 0)));
      let offsetMs = 0;
      if (replay && state.replayBatch) {
        const body: unknown =
          route.request().method() === 'POST' ? route.request().postDataJSON() : null;
        const requestBody =
          body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
        const playerState = requestBody.currentPlayerState;
        const rawOffset =
          playerState && typeof playerState === 'object'
            ? (playerState as Record<string, unknown>).playerOffsetMs
            : null;
        const parsedOffset = typeof rawOffset === 'string' ? Number(rawOffset) : null;
        const validOffset =
          parsedOffset !== null && Number.isFinite(parsedOffset) && parsedOffset >= 0;
        if (validOffset && parsedOffset < 5_000) {
          batch = state.replayBatch;
          count = 2;
          offsetMs = parsedOffset;
        }
        state.replayRequests ??= [];
        if (state.replayRequests.length < 30) {
          state.replayRequests.push({
            method: route.request().method(),
            contentType: route.request().headers()['content-type'] ?? null,
            continuation:
              typeof requestBody.continuation === 'string' ? requestBody.continuation : null,
            offsetMs: validOffset ? parsedOffset : null,
            actions: batch ? count : 0,
          });
        }
      }
      const actions = batch ? messages(batch, count, replay, offsetMs) : [];
      if (batch) {
        for (let index = 0; index < count; index++) {
          const id = `viewing-${batch}-${index}`;
          if (!state.servedIds.includes(id)) state.servedIds.push(id);
        }
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: {
          continuationContents: {
            liveChatContinuation: {
              actions,
              continuations: [
                replay
                  ? { playerSeekContinuationData: { continuation: 'viewing-replay' } }
                  : { timedContinuationData: { continuation: 'viewing-live', timeoutMs: 1_000 } },
              ],
            },
          },
        },
      });
      return;
    }
    await route.fulfill({ status: 204 });
  });
  await context.addInitScript(
    ({ key, selectedLanguage }) => {
      (window as Window & { unsafeWindow?: Window }).unsafeWindow = window;
      window.ytcfg = {
        data_: {
          INNERTUBE_API_KEY: 'viewing-fixture-key',
          INNERTUBE_CONTEXT_CLIENT_NAME: '1',
          INNERTUBE_CONTEXT_CLIENT_VERSION: '1.0',
          INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '1.0' } },
        },
      };
      const replay = location.search.includes('windowsAcceptanceReplay');
      window.ytInitialData = {
        currentVideoEndpoint: {
          watchEndpoint: { videoId: replay ? 'windowsAcceptanceReplay' : 'windowsAcceptance' },
        },
        contents: {
          twoColumnWatchNextResults: {
            conversationBar: {
              liveChatRenderer: {
                isReplay: replay,
                continuations: [
                  replay
                    ? { playerSeekContinuationData: { continuation: 'viewing-replay' } }
                    : {
                        timedContinuationData: { continuation: 'viewing-live', timeoutMs: 1_000 },
                      },
                ],
              },
            },
          },
        },
      };
      if (localStorage.getItem(key) === null) {
        localStorage.setItem(
          key,
          JSON.stringify({
            language: selectedLanguage,
            livePollFailureLimit: 3,
            livePollFallbackMs: 500,
          })
        );
      }
      const originalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (storageKey: string, value: string): void {
        if (storageKey === key && window.__ytViewingDenyWrites) {
          throw new DOMException('Controlled write denial', 'QuotaExceededError');
        }
        originalSetItem.call(this, storageKey, value);
      };
      Object.defineProperty(window, 'Translator', {
        configurable: true,
        value: {
          availability: async () => 'available',
          create: async () => ({
            translate: async (text: string) => `번역: ${text}`,
            destroy() {},
          }),
        },
      });
      document.addEventListener('DOMContentLoaded', () => {
        document.querySelector('#yt-viewing-theater')?.addEventListener('click', () => {
          document.body.classList.toggle('yt-viewing-theater');
        });
        document.querySelector('#yt-viewing-fullscreen')?.addEventListener('click', () => {
          const player = document.querySelector<HTMLElement>('#movie_player');
          if (document.fullscreenElement) void document.exitFullscreen();
          else if (player) void player.requestFullscreen();
        });
      });
    },
    { key: SETTINGS_KEY, selectedLanguage: language }
  );
  await context.addInitScript({ content: userscript });
}

async function openPage(context: BrowserContext, replay = false): Promise<Page> {
  const page = await context.newPage();
  await page.goto(replay ? REPLAY_URL : WATCH_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await page
    .locator('#yt-live-chat-overlay canvas')
    .waitFor({ state: 'attached', timeout: 15_000 });
  await setScene(page, 'bright');
  return page;
}

async function setScene(page: Page, scene: Scene): Promise<void> {
  await page.evaluate(async (name) => {
    const video = document.querySelector<HTMLVideoElement>('#movie_player video');
    if (!video) throw new Error('Owned video is missing');
    video.src = `/viewing-${name}.mp4`;
    video.muted = true;
    video.loop = true;
    video.controls = true;
    await video.play();
  }, scene);
  await page.waitForFunction(
    (name) => {
      const video = document.querySelector<HTMLVideoElement>('#movie_player video');
      return Boolean(
        video &&
        video.readyState >= 2 &&
        video.currentTime > 0.05 &&
        video.currentSrc.endsWith(`/viewing-${name}.mp4`)
      );
    },
    scene,
    { timeout: 15_000 }
  );
}

async function assertVideoAdvances(page: Page): Promise<void> {
  const start = await page.evaluate(
    () => document.querySelector<HTMLVideoElement>('#movie_player video')?.currentTime ?? -1
  );
  await page.waitForFunction(
    (before) => {
      const video = document.querySelector<HTMLVideoElement>('#movie_player video');
      return Boolean(
        video &&
        !video.paused &&
        (video.currentTime > before + 0.25 || video.currentTime < before - 1)
      );
    },
    start,
    { timeout: 5_000 }
  );
}

/** Compare settings values while treating only valid hex color letter case as equivalent. */
export function canonicalSettingsForPauseComparison(serialized: string): unknown {
  const settings: unknown = JSON.parse(serialized);
  assert(settings && typeof settings === 'object' && !Array.isArray(settings));
  for (const groupName of ['colors', 'backgroundColors']) {
    const group: unknown = (settings as Record<string, unknown>)[groupName];
    if (!group || typeof group !== 'object' || Array.isArray(group)) continue;
    for (const [key, value] of Object.entries(group)) {
      if (typeof value === 'string' && /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6,8})$/iu.test(value)) {
        (group as Record<string, unknown>)[key] = value.toLowerCase();
      }
    }
  }
  return settings;
}

async function exercisePauseButton(
  page: Page,
  result: Case,
  output: string,
  verifyDisableEnable = false
): Promise<void> {
  await openSettings(page);
  try {
    const button = page.locator(`${MODAL} #yt-chat-overlay-pause-button`);
    await button.waitFor({ state: 'visible' });
    assert.equal(await button.isEnabled(), true, 'Session pause button is unavailable');
    assert.equal(await button.getAttribute('aria-pressed'), 'false');
    const bounds = await button.boundingBox();
    assert(bounds && bounds.width >= 44 && bounds.height >= 44, 'Pause target is below 44 px');
    const settingsBefore = await page.evaluate(() =>
      JSON.stringify(window.__ytChatOverlay?.getSettings?.())
    );
    const storedBefore = await page.evaluate((key) => localStorage.getItem(key), SETTINGS_KEY);

    await button.click();
    await page
      .locator('#yt-live-chat-overlay')
      .getByText('Paused', { exact: true })
      .waitFor({ state: 'visible' });
    assert.equal(await button.getAttribute('aria-pressed'), 'true');
    result.observations.push({
      stage: 'pause-button-pointer',
      bounds,
      state: await snapshot(page),
    });
    result.screenshots.push(await screenshot(page, output, 'viewing-y04-pause-button'));
    await assertVideoAdvances(page);

    await button.focus();
    await page.keyboard.press('Enter');
    await page
      .locator('#yt-live-chat-overlay')
      .getByText('Paused', { exact: true })
      .waitFor({ state: 'hidden' });
    assert.equal(await button.getAttribute('aria-pressed'), 'false');
    result.observations.push({ stage: 'pause-button-keyboard', state: await snapshot(page) });
    await assertVideoAdvances(page);
    assert.equal(
      await page.evaluate(() => JSON.stringify(window.__ytChatOverlay?.getSettings?.())),
      settingsBefore,
      'Session pause modified settings'
    );
    assert.equal(
      await page.evaluate((key) => localStorage.getItem(key), SETTINGS_KEY),
      storedBefore,
      'Session pause wrote settings storage'
    );
    if (verifyDisableEnable) {
      assert(storedBefore, 'Original persisted settings are unavailable');
      const originalSettings: unknown = JSON.parse(settingsBefore);
      assert(
        originalSettings && typeof originalSettings === 'object' && !Array.isArray(originalSettings)
      );
      const assertStoredEnabled = async (expectedEnabled: boolean): Promise<void> => {
        await page.waitForFunction(
          ({ key, enabled }) => {
            const serialized = localStorage.getItem(key);
            if (!serialized) return false;
            const settings: unknown = JSON.parse(serialized);
            return (
              settings !== null &&
              typeof settings === 'object' &&
              'enabled' in settings &&
              settings.enabled === enabled
            );
          },
          { key: SETTINGS_KEY, enabled: expectedEnabled },
          { timeout: 5_000 }
        );
        const stored = await page.evaluate((key) => localStorage.getItem(key), SETTINGS_KEY);
        assert(stored, 'Persisted settings disappeared after changing comment availability');
        const storedSettings: unknown = JSON.parse(stored);
        assert(
          storedSettings && typeof storedSettings === 'object' && '_version' in storedSettings
        );
        const { _version: version, ...storedValues } = storedSettings;
        assert(
          typeof version === 'number' && Number.isInteger(version) && version > 0,
          'Committed settings have no schema version'
        );
        assert.deepEqual(
          canonicalSettingsForPauseComparison(JSON.stringify(storedValues)),
          canonicalSettingsForPauseComparison(
            JSON.stringify({ ...originalSettings, enabled: expectedEnabled })
          ),
          'Changing comment availability persisted another setting'
        );
      };
      const enabled = page.locator(`${MODAL} input[name="enabled"]`);
      assert(await enabled.isChecked(), 'Comments unexpectedly start disabled');
      await enabled.click();
      await page.waitForFunction(() => {
        const button = document.querySelector<HTMLButtonElement>('#yt-chat-overlay-pause-button');
        return button?.disabled === true;
      });
      assert.equal(await button.getAttribute('aria-pressed'), 'false');
      assert.equal(
        await page.evaluate((key) => localStorage.getItem(key), SETTINGS_KEY),
        storedBefore,
        'Disabling comments wrote storage before the settings dialog closed'
      );
      assert.notEqual(
        await button.evaluate((node) => document.activeElement === node),
        true,
        'Disabled pause retained keyboard focus'
      );
      result.observations.push({ stage: 'pause-comments-disabled', state: await snapshot(page) });
      await assertVideoAdvances(page);
      await closeSettings(page);
      await assertStoredEnabled(false);
      await openSettings(page);
      assert.equal(await button.isEnabled(), false);
      const storedDisabled = await page.evaluate((key) => localStorage.getItem(key), SETTINGS_KEY);
      await enabled.click();
      await page.waitForFunction(() => {
        const button = document.querySelector<HTMLButtonElement>('#yt-chat-overlay-pause-button');
        return button?.disabled === false;
      });
      assert.equal(await button.getAttribute('aria-pressed'), 'false');
      assert.equal(
        await page.evaluate((key) => localStorage.getItem(key), SETTINGS_KEY),
        storedDisabled,
        'Re-enabling comments wrote storage before the settings dialog closed'
      );
      assert.deepEqual(
        canonicalSettingsForPauseComparison(
          await page.evaluate(() => JSON.stringify(window.__ytChatOverlay?.getSettings?.()))
        ),
        canonicalSettingsForPauseComparison(settingsBefore),
        'Disable and re-enable changed another setting'
      );
      await closeSettings(page);
      await assertStoredEnabled(true);
      await openSettings(page);
      assert.equal(await button.isEnabled(), true);
      await button.focus();
      assert(await button.evaluate((node) => document.activeElement === node));
      result.observations.push({ stage: 'pause-comments-reenabled', state: await snapshot(page) });
      await assertVideoAdvances(page);
      await page.keyboard.press('Enter');
      await page
        .locator('#yt-live-chat-overlay')
        .getByText('Paused', { exact: true })
        .waitFor({ state: 'visible' });
      assert.equal(await button.getAttribute('aria-pressed'), 'true');
      result.observations.push({ stage: 'reenabled-pause-keyboard', state: await snapshot(page) });
      await assertVideoAdvances(page);
      await button.click();
      await page
        .locator('#yt-live-chat-overlay')
        .getByText('Paused', { exact: true })
        .waitFor({ state: 'hidden' });
      assert.equal(await button.getAttribute('aria-pressed'), 'false');
      result.observations.push({ stage: 'reenabled-resume-pointer', state: await snapshot(page) });
      await assertVideoAdvances(page);
      await assertStoredEnabled(true);
      assert.deepEqual(
        canonicalSettingsForPauseComparison(
          await page.evaluate(() => JSON.stringify(window.__ytChatOverlay?.getSettings?.()))
        ),
        canonicalSettingsForPauseComparison(settingsBefore),
        'Pause after re-enabling comments changed another setting'
      );
    }
  } finally {
    if (verifyDisableEnable) {
      if (!(await page.locator(MODAL).isVisible())) await openSettings(page);
      const enabled = page.locator(`${MODAL} input[name="enabled"]`);
      if ((await enabled.count()) && !(await enabled.isChecked())) await enabled.click();
    }
    if (await page.locator(MODAL).isVisible()) await closeSettings(page);
  }
}

async function waitForMovingChatFrame(page: Page): Promise<void> {
  const start = await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('#movie_player video');
    return video?.currentTime ?? -1;
  });
  assert(start >= 0, 'Owned moving video is unavailable');
  await page.waitForFunction(
    (before) => {
      const video = document.querySelector<HTMLVideoElement>('#movie_player video');
      if (!video || video.paused || video.readyState < 2 || !Number.isFinite(video.duration)) {
        return false;
      }
      const advanced =
        video.currentTime >= before
          ? video.currentTime - before
          : video.currentTime + video.duration - before;
      return advanced >= 2.2;
    },
    start,
    { timeout: 8_000 }
  );
}

async function openSettings(page: Page, tab = 'comments'): Promise<void> {
  await page.locator('#movie_player').hover();
  await page.locator('#yt-chat-overlay-settings-button').click();
  await page.locator(`${MODAL} #tab-${tab}`).click();
}

async function closeSettings(page: Page): Promise<void> {
  await page.locator(`${MODAL} button.yt-chat-overlay-settings-close`).click();
  await page.locator(MODAL).waitFor({ state: 'hidden' });
}

async function setNumber(
  page: Page,
  name: string,
  displayValue: string,
  storedValue = Number(displayValue)
): Promise<void> {
  await page.locator(`${MODAL} input[name="${name}"]`).fill(displayValue);
  await page.waitForFunction(
    ({ key, expected }) => {
      const settings = window.__ytChatOverlay?.getSettings?.();
      const value = key.startsWith('outline-')
        ? settings?.outline[key.slice('outline-'.length) as keyof typeof settings.outline]
        : settings?.[key as keyof typeof settings];
      return Number(value) === expected;
    },
    { key: name, expected: storedValue },
    { timeout: 10_000 }
  );
}

async function feed(page: Page, batch: string, count: number, replay = false): Promise<string[]> {
  const ids = Array.from({ length: count }, (_, index) => `viewing-${batch}-${index}`);
  await page.evaluate(
    async ({ name, size, endpoint }) => {
      const response = await fetch(
        `/youtubei/v1/live_chat/${endpoint}?fixture-batch=${encodeURIComponent(name)}&fixture-count=${size}`
      );
      if (!response.ok) throw new Error(`Owned chat route returned ${response.status}`);
      await response.json();
    },
    { name: batch, size: count, endpoint: replay ? 'get_live_chat_replay' : 'get_live_chat' }
  );
  return ids;
}

async function waitForAnyRow(page: Page, ids: string[]): Promise<void> {
  await page.waitForFunction(
    (expected) =>
      expected.some((id) =>
        Array.from(
          document.querySelectorAll<HTMLElement>(
            '#yt-live-chat-overlay .yt-live-chat-overlay-live-region > p'
          )
        ).some((row) => row.dataset.messageId === id)
      ),
    ids,
    { timeout: 10_000 }
  );
}

async function assertNoticeTooltipClear(page: Page): Promise<unknown> {
  const states = [];
  for (const target of ['settings', 'reload'] as const) {
    await page.locator(`#yt-chat-overlay-${target}-button`).focus();
    const state = await page.evaluate(() => {
      const settings = document.querySelector<HTMLButtonElement>(
        '#yt-chat-overlay-settings-button'
      );
      const reload = document.querySelector<HTMLButtonElement>('#yt-chat-overlay-reload-button');
      const notice = document.querySelector<HTMLElement>(
        '.yt-chat-overlay-settings-persistence-notice'
      );
      return {
        focused: document.activeElement?.id ?? null,
        settingsInterest: settings?.hasAttribute('interestfor') ?? false,
        settingsTitle: settings?.hasAttribute('title') ?? false,
        reloadInterest: reload?.hasAttribute('interestfor') ?? false,
        reloadTitle: reload?.hasAttribute('title') ?? false,
        noticeVisible: Boolean(notice && getComputedStyle(notice).display !== 'none'),
        openTooltips: document.querySelectorAll(
          '#yt-chat-overlay-settings-tooltip:popover-open, #yt-chat-overlay-reload-tooltip:popover-open'
        ).length,
      };
    });
    assert.equal(state.focused, `yt-chat-overlay-${target}-button`);
    assert.equal(state.noticeVisible, true, 'Persistence notice was not visible');
    assert.equal(state.settingsInterest, false, 'Settings tooltip remained enabled by notice');
    assert.equal(state.settingsTitle, false, 'Settings title remained enabled by notice');
    assert.equal(state.reloadInterest, false, 'Reload tooltip remained enabled by notice');
    assert.equal(state.reloadTitle, false, 'Reload title remained enabled by notice');
    assert.equal(state.openTooltips, 0, 'A tooltip obscured persistence notice');
    states.push({ target, ...state });
  }
  await page.locator('#yt-chat-overlay-settings-button').focus();
  assert.equal(
    await page
      .locator(
        '#yt-chat-overlay-settings-tooltip:popover-open, #yt-chat-overlay-reload-tooltip:popover-open'
      )
      .count(),
    0,
    'A tooltip reopened when Settings focus returned'
  );
  return states;
}

async function assertToastClearOfActions(page: Page, required: boolean): Promise<unknown> {
  const state = await page.evaluate(() => {
    const modal = document.querySelector<HTMLDialogElement>('#yt-chat-overlay-settings-backdrop');
    const toast = modal?.querySelector<HTMLElement>('.yt-chat-overlay-settings-toast');
    const importButton = modal?.querySelector<HTMLButtonElement>(
      '.yt-chat-overlay-settings-actions button[data-action="import"]'
    );
    if (!modal || !toast || !importButton) return null;
    const toastBounds = toast.getBoundingClientRect();
    const modalBounds = modal.getBoundingClientRect();
    const buttons = Array.from(
      modal.querySelectorAll<HTMLButtonElement>('.yt-chat-overlay-settings-actions button')
    );
    const buttonBounds = buttons.map((button) => button.getBoundingClientRect());
    return {
      importFocused: document.activeElement === importButton,
      toastBounds: { top: toastBounds.top, bottom: toastBounds.bottom },
      buttonsVisible: buttonBounds.every(
        (bounds) =>
          bounds.top >= modalBounds.top - 1 &&
          bounds.bottom <= modalBounds.bottom + 1 &&
          bounds.bottom <= innerHeight + 1
      ),
      overlapsButtons: buttonBounds.some(
        (bounds) =>
          toastBounds.left < bounds.right &&
          toastBounds.right > bounds.left &&
          toastBounds.top < bounds.bottom &&
          toastBounds.bottom > bounds.top
      ),
    };
  });
  if (required) assert(state, 'Import toast disappeared before layout capture');
  if (state) {
    assert.equal(state.importFocused, true, 'Import focus was lost with toast visible');
    assert.equal(state.buttonsVisible, true, 'Footer actions moved outside the visible modal');
    assert.equal(state.overlapsButtons, false, 'Import toast obscured a footer action');
  }
  return state;
}

async function exerciseConnectionFault({
  page,
  routeState,
  result,
  stage,
  capture,
}: {
  page: Page;
  routeState: RouteState;
  result: Case;
  stage: string;
  capture: () => Promise<string>;
}): Promise<void> {
  const settingsButton = page.locator('#yt-chat-overlay-settings-button');
  await settingsButton.focus();
  routeState.faultStatus = 403;
  routeState.disconnected = true;
  const statusAction = page.locator('#yt-chat-overlay-status-action');
  await page
    .locator(
      '.yt-chat-overlay-reload-feedback[data-phase="recovering"], .yt-chat-overlay-reload-feedback[data-phase="failed"]'
    )
    .waitFor({ state: 'visible', timeout: 30_000 });
  const feedback = page.locator('.yt-chat-overlay-reload-feedback');
  const tooltipState = await page.evaluate(() => {
    const settings = document.querySelector<HTMLButtonElement>('#yt-chat-overlay-settings-button');
    const reload = document.querySelector<HTMLButtonElement>('#yt-chat-overlay-reload-button');
    return {
      settingsFocused: document.activeElement === settings,
      settingsInterest: settings?.hasAttribute('interestfor') ?? false,
      settingsTitle: settings?.hasAttribute('title') ?? false,
      reloadInterest: reload?.hasAttribute('interestfor') ?? false,
      reloadTitle: reload?.hasAttribute('title') ?? false,
      openTooltips: document.querySelectorAll(
        '#yt-chat-overlay-settings-tooltip:popover-open, #yt-chat-overlay-reload-tooltip:popover-open'
      ).length,
    };
  });
  assert.equal(tooltipState.settingsFocused, true, 'Settings focus was lost during recovery');
  assert.equal(tooltipState.settingsInterest, false, 'Settings tooltip remained enabled');
  assert.equal(tooltipState.settingsTitle, false, 'Settings title tooltip remained enabled');
  assert.equal(tooltipState.reloadInterest, false, 'Reload tooltip remained enabled');
  assert.equal(tooltipState.reloadTitle, false, 'Reload title tooltip remained enabled');
  assert.equal(tooltipState.openTooltips, 0, 'A tooltip obscured recovery feedback');
  const actionVisible = await statusAction.isVisible();
  const status = await page.evaluate(() => {
    const action = document.querySelector<HTMLButtonElement>('#yt-chat-overlay-status-action');
    const region = document.querySelector<HTMLElement>('#yt-live-chat-overlay [role="status"]');
    return {
      actionText: action?.textContent ?? null,
      actionLabel: action?.getAttribute('aria-label') ?? null,
      actionDisplay: action ? getComputedStyle(action).display : null,
      liveRegion: region?.textContent ?? null,
    };
  });
  result.observations.push({
    stage: `${stage}-fault`,
    requestedHttpStatus: 403,
    faultRequests: routeState.faultRequests ?? 0,
    actionVisible,
    legacyStatusAction: 'not-applicable-under-managed-restart',
    automaticRecoveryPhase: await feedback.getAttribute('data-phase'),
    automaticRecoveryText: await feedback.textContent(),
    tooltipState,
    status,
    state: await snapshot(page),
  });
  result.screenshots.push(await capture());
  assert((routeState.faultRequests ?? 0) > 0, 'Controlled chat fault was never requested');

  await page.locator('#movie_player').hover();
  const recovery = page.locator('#yt-chat-overlay-reload-button');
  const healthyResponse = page.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      return (
        url.pathname.startsWith('/youtubei/v1/live_chat/get_live_chat') &&
        !url.searchParams.has('fixture-batch') &&
        response.status() === 200
      );
    },
    { timeout: 12_000 }
  );
  routeState.disconnected = false;
  await Promise.all([healthyResponse, recovery.click({ timeout: 12_000 })]);
  const recoveredIds = await feed(page, `${stage}-recovered`, 1);
  await waitForAnyRow(page, recoveredIds);
  result.observations.push({
    stage: `${stage}-recovery`,
    action: 'reload-button',
    faultRequests: routeState.faultRequests ?? 0,
    healthyPollRequests: routeState.healthyPollRequests ?? 0,
    recoveredIds,
    state: await snapshot(page),
  });
  assert((routeState.healthyPollRequests ?? 0) > 0, 'Controlled chat did not resume polling');
}

async function snapshot(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('#movie_player video');
    const canvas = document.querySelector<HTMLCanvasElement>('#yt-live-chat-overlay canvas');
    const modal = document.querySelector<HTMLDialogElement>('#yt-chat-overlay-settings-backdrop');
    const player = document.querySelector<HTMLElement>('#movie_player');
    const active = document.activeElement;
    const settings = window.__ytChatOverlay?.getSettings?.() ?? null;
    const rect = (element: Element | null) => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        right: box.right,
        bottom: box.bottom,
      };
    };
    let context: CanvasRenderingContext2D | null = null;
    try {
      context = canvas?.getContext('2d') ?? null;
    } catch {
      // A transferred OffscreenCanvas is measured by its DOM geometry only.
    }
    let opaqueBottom = -1;
    let sampledOpaquePixels = 0;
    if (canvas && context && canvas.width && canvas.height) {
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      for (let y = 0; y < canvas.height; y += 4) {
        for (let x = 0; x < canvas.width; x += 4) {
          if ((pixels.data[(y * canvas.width + x) * 4 + 3] ?? 0) > 20) {
            opaqueBottom = y;
            sampledOpaquePixels++;
          }
        }
      }
    }
    return {
      viewport: {
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
        documentScrollWidth: document.documentElement.scrollWidth,
      },
      mediaPreferences: {
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        forcedColors: matchMedia('(forced-colors: active)').matches,
      },
      video: video
        ? {
            src: video.currentSrc,
            time: video.currentTime,
            paused: video.paused,
            readyState: video.readyState,
            controls: video.controls,
            width: video.videoWidth,
            height: video.videoHeight,
          }
        : null,
      player: rect(player),
      canvas: canvas
        ? {
            ...rect(canvas),
            width: canvas.width,
            height: canvas.height,
            opaqueBottom,
            sampledOpaquePixels,
            safeBottomStart: Math.round(canvas.height * (1 - (settings?.safeBottom ?? 0))),
          }
        : null,
      rows: Array.from(
        document.querySelectorAll<HTMLElement>(
          '#yt-live-chat-overlay .yt-live-chat-overlay-live-region > p'
        ),
        (row) => ({ id: row.dataset.messageId, text: row.textContent })
      ).slice(-10),
      pauseVisible: Array.from(
        document.querySelectorAll<HTMLElement>('#yt-live-chat-overlay div')
      ).some((node) => node.textContent === 'Paused' && getComputedStyle(node).display !== 'none'),
      settings,
      modal: modal
        ? {
            open: modal.open,
            bounds: rect(modal),
            scrollWidth: modal.scrollWidth,
            clientWidth: modal.clientWidth,
            scrollHeight: modal.scrollHeight,
            clientHeight: modal.clientHeight,
            activeTab: modal.querySelector('[role="tab"][aria-selected="true"]')?.id ?? null,
            status:
              modal.querySelector('.yt-chat-overlay-settings-runtime-status')?.textContent ?? null,
          }
        : null,
      pauseButton: (() => {
        const button = modal?.querySelector<HTMLButtonElement>('#yt-chat-overlay-pause-button');
        return button
          ? {
              text: button.textContent,
              pressed: button.getAttribute('aria-pressed'),
              disabled: button.disabled,
              bounds: rect(button),
            }
          : null;
      })(),
      notice: (() => {
        const element = document.querySelector<HTMLElement>(
          '.yt-chat-overlay-settings-persistence-notice'
        );
        return element
          ? {
              text: element.textContent,
              bounds: rect(element),
              action: element.querySelector('button')?.textContent ?? null,
            }
          : null;
      })(),
      recovery: (() => {
        const feedback = document.querySelector<HTMLElement>('.yt-chat-overlay-reload-feedback');
        const button = document.querySelector<HTMLButtonElement>('#yt-chat-overlay-reload-button');
        return feedback
          ? {
              phase: feedback.dataset.phase ?? null,
              text: feedback.textContent,
              visible: !feedback.hidden && getComputedStyle(feedback).display !== 'none',
              bounds: rect(feedback),
              buttonLabel: button?.getAttribute('aria-label') ?? null,
            }
          : null;
      })(),
      focus: active
        ? {
            tag: active.tagName,
            id: active.id,
            bounds: rect(active),
            outlineWidth: getComputedStyle(active).outlineWidth,
          }
        : null,
      fullscreen: Boolean(document.fullscreenElement),
    };
  });
}

async function screenshot(page: Page, output: string, name: string): Promise<string> {
  const file = `${name}.png`;
  await page.screenshot({ path: join(output, file), timeout: 10_000 });
  return file;
}

async function nativeZoomScreenshot(page: Page, output: string, name: string) {
  const file = `${name}.png`;
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Page.bringToFront');
    // A clipped Playwright screenshot can retain pre-zoom CSS dimensions.
    const { data } = await session.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const bytes = Buffer.from(data, 'base64');
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    await writeFile(join(output, file), bytes);
    return {
      file,
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
      sha256: sha256(bytes),
      method: 'cdp-page-capture-screenshot-no-clip',
    };
  } finally {
    await session.detach();
  }
}

async function runCase(id: string, work: (result: Case) => Promise<void>): Promise<Case> {
  const result: Case = { id, observations: [], screenshots: [] };
  try {
    await work(result);
  } catch (error) {
    result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  }
  return result;
}

/** Prepare an owned browser focus target for an in-process native Windows input helper. */
async function prepareViewingImeCheckpoint(page: Page, japanese = false): Promise<void> {
  await page.evaluate((includeEditable) => {
    document.title = 'YT Viewing IME Checkpoint';
    const input = document.createElement('textarea');
    input.id = 'yt-viewing-ime-input';
    input.setAttribute('aria-label', 'Native IME composition checkpoint');
    input.style.cssText =
      'position:fixed;left:12px;top:12px;width:320px;height:80px;z-index:2147483647';
    document.body.appendChild(input);
    const editable = document.createElement('div');
    if (includeEditable) {
      editable.id = 'yt-viewing-ime-editable';
      editable.contentEditable = 'true';
      editable.setAttribute('role', 'textbox');
      editable.setAttribute('aria-label', 'Native Japanese editable checkpoint');
      editable.style.cssText =
        'position:fixed;left:12px;top:100px;width:320px;height:80px;z-index:2147483647;background:white;color:black';
      document.body.appendChild(editable);
    }
    window.__ytViewingImeEvents = [];
    window.__ytViewingImeTraceOverflow = false;
    window.__ytViewingImeRecord = (event) => {
      const events = window.__ytViewingImeEvents;
      if (!events) return;
      if (events.length >= 200) {
        window.__ytViewingImeTraceOverflow = true;
        return;
      }
      events.push(event);
    };
    const types = [
      'compositionstart',
      'compositionupdate',
      'compositionend',
      'beforeinput',
      'input',
      'keydown',
    ];
    for (const target of includeEditable ? [input, editable] : [input]) {
      for (const type of types)
        target.addEventListener(type, (event) => {
          const keyboard = event instanceof KeyboardEvent ? event : null;
          const composition = event instanceof CompositionEvent ? event : null;
          const inputEvent = event instanceof InputEvent ? event : null;
          window.__ytViewingImeRecord?.({
            type,
            target: target.id,
            trusted: event.isTrusted,
            isComposing: keyboard?.isComposing ?? null,
            key: keyboard?.key ?? null,
            capsLock: keyboard?.getModifierState('CapsLock') ?? null,
            data: composition?.data ?? inputEvent?.data ?? null,
            inputType: inputEvent?.inputType ?? null,
            atMs: performance.now(),
          });
        });
    }
    document.addEventListener(
      'keydown',
      (event) => {
        if (!event.ctrlKey || event.code !== 'Space') return;
        const focus = document.activeElement?.id ?? null;
        window.__ytViewingImeRecord?.({
          type: 'document-keydown',
          trusted: event.isTrusted,
          isComposing: event.isComposing,
          focus,
          atMs: performance.now(),
        });
        setTimeout(() => {
          const video = document.querySelector<HTMLVideoElement>('#movie_player video');
          window.__ytViewingImeRecord?.({
            type: 'post-ctrl-space',
            focus,
            overlayPaused: Array.from(
              document.querySelectorAll<HTMLElement>('#yt-live-chat-overlay div')
            ).some(
              (node) => node.textContent === 'Paused' && getComputedStyle(node).display !== 'none'
            ),
            videoPaused: video?.paused ?? null,
            videoTime: video?.currentTime ?? null,
            atMs: performance.now(),
          });
        }, 50);
      },
      true
    );
    if (includeEditable) {
      const handler = (event: KeyboardEvent) => {
        if (
          !event.isTrusted ||
          event.key !== ' ' ||
          event.ctrlKey ||
          event.altKey ||
          event.isComposing ||
          document.activeElement?.id !== 'movie_player'
        )
          return;
        const video = document.querySelector<HTMLVideoElement>('#movie_player video');
        if (!video) return;
        event.preventDefault();
        if (video.paused) void video.play();
        else video.pause();
        window.__ytViewingImeRecord?.({
          type: 'fixture-native-player-space',
          trusted: event.isTrusted,
          focus: document.activeElement?.id,
          videoPaused: video.paused,
          atMs: performance.now(),
        });
      };
      window.__ytViewingPlayerSpaceHandler = handler;
      document.addEventListener('keydown', handler);
    }
    input.focus();
  }, japanese);
}

/** Read evidence after native input; this function never synthesizes a key event. */
async function readViewingImeCheckpoint(
  page: Page,
  settle = false,
  target: 'textarea' | 'editable' = 'textarea'
): Promise<ImeCheckpoint> {
  return page.evaluate(
    ({ settleComposition, focusedTarget }) => {
      const input = document.querySelector<HTMLTextAreaElement>('#yt-viewing-ime-input');
      const editable = document.querySelector<HTMLElement>('#yt-viewing-ime-editable');
      const inputBeforeBlur = input?.value ?? null;
      const editableBeforeBlur = editable?.textContent ?? null;
      const selected = focusedTarget === 'editable' ? editable : input;
      if (settleComposition && selected) {
        selected.blur();
        selected.focus();
      }
      return {
        title: document.title,
        focus: document.activeElement?.id ?? null,
        input: inputBeforeBlur,
        editable: editableBeforeBlur,
        settledInput: settleComposition ? (input?.value ?? null) : null,
        settledEditable: settleComposition ? (editable?.textContent ?? null) : null,
        settledFocus: settleComposition ? (document.activeElement?.id ?? null) : null,
        events: window.__ytViewingImeEvents ?? [],
        traceOverflow: window.__ytViewingImeTraceOverflow === true,
        videoPaused:
          document.querySelector<HTMLVideoElement>('#movie_player video')?.paused ?? null,
        videoTime:
          document.querySelector<HTMLVideoElement>('#movie_player video')?.currentTime ?? null,
        overlayPaused: Array.from(
          document.querySelectorAll<HTMLElement>('#yt-live-chat-overlay div')
        ).some(
          (node) => node.textContent === 'Paused' && getComputedStyle(node).display !== 'none'
        ),
      };
    },
    { settleComposition: settle, focusedTarget: target }
  );
}

async function resetViewingImeTrace(page: Page, clearInput = false): Promise<void> {
  await page.evaluate((clear) => {
    const input = document.querySelector<HTMLTextAreaElement>('#yt-viewing-ime-input');
    if (clear && input) input.value = '';
    const editable = document.querySelector<HTMLElement>('#yt-viewing-ime-editable');
    if (clear && editable) editable.textContent = '';
    window.__ytViewingImeEvents = [];
    window.__ytViewingImeTraceOverflow = false;
  }, clearInput);
}

async function exerciseJapaneseIme(
  page: Page,
  root: string,
  output: string,
  identity: { pid: number; profile: string },
  result: Case
): Promise<void> {
  const verdicts: Record<string, { status: 'Pass' | 'Fail' | 'Not run'; reason?: string }> = {
    'JI-01': { status: 'Not run' },
    'JI-02': { status: 'Not run' },
    'JI-03': { status: 'Not run' },
    'JI-04': { status: 'Not run' },
  };
  const errors: unknown[] = [];
  let initialBehavior: ReturnType<typeof japaneseWordBehavior> = 'unknown';
  let initialCapsState: ImeCheckpoint | null = null;
  const act = async (
    sequence: NativeImeSequence,
    stage: NativeImeStage,
    focus: 'textarea' | 'editable' | 'player',
    settle = false
  ) => {
    const action = await runNativeImeAction({
      page,
      root,
      output,
      identity,
      sequence,
      stage,
      focus,
      japaneseLayout: true,
    });
    await page.waitForTimeout(100);
    const state = await readViewingImeCheckpoint(
      page,
      settle,
      focus === 'editable' ? 'editable' : 'textarea'
    );
    result.observations.push({ stage, native: action, state });
    assertJapaneseNativeReceipt(action, sequence);
    assert.equal(state.traceOverflow, false, 'Japanese IME trace overflowed');
    if (sequence === 'JapaneseDuringComposition') {
      assert.equal(action.compositionGate?.open, true, 'Composition was not open at shortcut gate');
    }
    if (sequence === 'JapaneseDirectCtrlSpaceRoundTrip') {
      assert.equal(
        action.directGate?.observed,
        true,
        'Trusted direct Latin input was not observed before Ctrl+Space'
      );
    }
    return { action, state };
  };
  const convertedWord = async (
    focus: 'textarea' | 'editable',
    stages: {
      selection: NativeImeStage;
      toggle: NativeImeStage;
      confirmation: NativeImeStage;
    }
  ) => {
    await resetViewingImeTrace(page, true);
    let attempt = await act('JapaneseHiragana', stages.selection, focus, true);
    let behavior = japaneseWordBehavior(attempt.state, focus);
    if (behavior === 'direct-latin') {
      assertJapaneseToggleProbeAllowed(attempt.state, focus);
      await resetViewingImeTrace(page, true);
      const toggled = await act('JapaneseToggleProbe', stages.toggle, focus, true);
      const toggledBehavior = japaneseWordBehavior(toggled.state, focus);
      result.observations.push({
        stage: 'japanese-ime-on-diagnostic',
        focus,
        before: behavior,
        afterOneToggle: toggledBehavior,
      });
      assert.equal(
        toggledBehavior,
        'converted-japanese',
        'One Alt+Backquote diagnostic did not start Japanese composition'
      );
      await resetViewingImeTrace(page, true);
      attempt = await act('JapaneseCurrent', stages.confirmation, focus, true);
      behavior = japaneseWordBehavior(attempt.state, focus);
    }
    assert.equal(behavior, 'converted-japanese', 'Japanese conversion was not observed');
    return attempt;
  };

  try {
    try {
      const initial = await act('JapaneseCurrent', 'japanese-initial', 'textarea', true);
      initialCapsState = initial.state;
      initialBehavior = japaneseWordBehavior(initial.state, 'textarea');
      assert.notEqual(initialBehavior, 'unknown', 'Original Japanese input mode was not observed');
      result.observations.push({
        stage: 'japanese-initial-mode',
        observedBehavior: initialBehavior,
      });

      const textarea = await convertedWord('textarea', {
        selection: 'japanese-textarea',
        toggle: 'japanese-toggle-textarea',
        confirmation: 'japanese-toggle-confirm-textarea',
      });
      assert.equal(textarea.state.overlayPaused, false);
      assert.equal(textarea.state.videoPaused, false);

      const editable = await convertedWord('editable', {
        selection: 'japanese-editable',
        toggle: 'japanese-toggle-editable',
        confirmation: 'japanese-toggle-confirm-editable',
      });
      assert.equal(editable.state.overlayPaused, false);
      assert.equal(editable.state.videoPaused, false);

      await resetViewingImeTrace(page, true);
      const direct = await act('JapaneseDirect', 'japanese-direct', 'textarea', true);
      assert.equal(japaneseWordBehavior(direct.state, 'textarea'), 'direct-latin');
      assert.equal(direct.state.videoPaused, false);
      await resetViewingImeTrace(page, true);
      const editableDirect = await act(
        'JapaneseDirect',
        'japanese-direct-editable',
        'editable',
        true
      );
      assert.equal(japaneseWordBehavior(editableDirect.state, 'editable'), 'direct-latin');
      verdicts['JI-01'] = { status: 'Pass' };
      await assertVideoAdvances(page);
    } catch (error) {
      verdicts['JI-01'] = { status: 'Fail', reason: String(error) };
      errors.push(error);
    }

    if (verdicts['JI-01']?.status === 'Pass') {
      try {
        await resetViewingImeTrace(page, true);
        const editable = await act(
          'JapaneseDirectCtrlSpaceRoundTrip',
          'japanese-direct-editable-shortcut',
          'editable',
          true
        );
        const editableRoute = assertJapaneseDirectShortcut(
          editable.state,
          editable.action.samples,
          editable.action.directGate
        );
        result.observations.push({
          stage: 'japanese-direct-editable-shortcut-route',
          route: editableRoute,
          directGate: editable.action.directGate,
          postGateSampleCount: editable.action.samples.filter(
            (sample) => sample.atMs >= (editable.action.directGate?.atMs ?? Infinity)
          ).length,
        });
        await assertVideoAdvances(page);

        await resetViewingImeTrace(page, true);
        const composing = await act(
          'JapaneseDuringComposition',
          'japanese-composing-shortcut',
          'textarea',
          true
        );
        const interruption = assertInterruptedJapaneseComposition(
          composing.state,
          composing.action.compositionGate
        );
        result.observations.push({
          stage: 'japanese-composing-shortcut-route',
          ...interruption,
          nativeEffect: 'literal-space-in-composition',
          trustedDocumentPresses: 0,
        });
        await assertVideoAdvances(page);

        await resetViewingImeTrace(page);
        const playerBefore = await readViewingImeCheckpoint(page);
        const player = await act('CtrlSpaceRoundTrip', 'japanese-player-shortcut', 'player');
        const playerRoute = assertJapaneseShortcut(
          player.state,
          player.action.samples,
          'movie_player',
          playerBefore.input
        );
        result.observations.push({ stage: 'japanese-player-shortcut-route', route: playerRoute });
        await assertVideoAdvances(page);
        verdicts['JI-02'] = { status: 'Pass' };
      } catch (error) {
        verdicts['JI-02'] = { status: 'Fail', reason: String(error) };
        errors.push(error);
      }
    }

    try {
      const textarea = page.locator('#yt-viewing-ime-input');
      await textarea.evaluate((node) => {
        (node as HTMLTextAreaElement).hidden = true;
      });
      await exercisePauseButton(page, result, output, true);
      verdicts['JI-03'] = { status: 'Pass' };
    } catch (error) {
      verdicts['JI-03'] = { status: 'Fail', reason: String(error) };
      errors.push(error);
    }

    if (initialBehavior !== 'unknown') {
      try {
        await resetViewingImeTrace(page);
        const firstSpace = await act('NativeSpace', 'japanese-player-space', 'player');
        assertJapanesePlayerSpace(firstSpace.state, true);
        await resetViewingImeTrace(page);
        const secondSpace = await act('NativeSpace', 'japanese-player-space-resume', 'player');
        assertJapanesePlayerSpace(secondSpace.state, false);
        await assertVideoAdvances(page);

        await page.locator('#yt-viewing-ime-input').evaluate((node) => {
          (node as HTMLTextAreaElement).hidden = false;
        });
        let postPauseBehavior: ReturnType<typeof japaneseWordBehavior> = 'unknown';
        try {
          const postPause = await convertedWord('textarea', {
            selection: 'japanese-after-pause',
            toggle: 'japanese-toggle-after-pause',
            confirmation: 'japanese-toggle-confirm-after-pause',
          });
          assert.equal(postPause.state.overlayPaused, false);
          assert.equal(postPause.state.videoPaused, false);
          await assertVideoAdvances(page);
          postPauseBehavior = japaneseWordBehavior(postPause.state, 'textarea');
        } catch (error) {
          errors.push(error);
          result.observations.push({
            stage: 'japanese-after-pause-incomplete',
            reason: String(error),
          });
        }
        // Attempt the original observed mode even when the post-Pause composition failed.
        await resetViewingImeTrace(page, true);
        const unforced = await act('JapaneseCurrent', 'japanese-mode-probe', 'textarea', true);
        let finalCapsState = unforced.state;
        let finalBehavior = japaneseWordBehavior(unforced.state, 'textarea');
        const beforeRepair = finalBehavior;
        let restorationRequested = false;
        if (
          !japaneseModeRestored(initialBehavior, {
            sequence: 'JapaneseCurrent',
            behavior: finalBehavior,
          })
        ) {
          const restoreSequence =
            initialBehavior === 'direct-latin' ? 'JapaneseDirect' : 'JapaneseHiragana';
          await resetViewingImeTrace(page, true);
          const restoration = await act(restoreSequence, 'japanese-mode-restore', 'textarea', true);
          restorationRequested = true;
          assert.equal(japaneseWordBehavior(restoration.state, 'textarea'), initialBehavior);
          await resetViewingImeTrace(page, true);
          const followup = await act(
            'JapaneseCurrent',
            'japanese-restored-probe',
            'textarea',
            true
          );
          finalCapsState = followup.state;
          finalBehavior = japaneseWordBehavior(followup.state, 'textarea');
        }
        assert(
          japaneseModeRestored(initialBehavior, {
            sequence: 'JapaneseCurrent',
            behavior: finalBehavior,
          }),
          'Unforced Japanese input did not match the original observed mode'
        );
        const capsLockComparison = initialCapsState
          ? japaneseCapsLockComparison(initialCapsState, finalCapsState)
          : 'unverified';
        result.observations.push({
          stage: 'japanese-observed-mode-restored',
          initialBehavior,
          beforeRepair,
          restorationRequested,
          finalUnforcedBehavior: finalBehavior,
          capsLockComparison,
          postPauseBehavior,
          tsfFlagsObserved: false,
        });
        assert.notEqual(capsLockComparison, 'changed', 'Browser-observed Caps Lock state changed');
        verdicts['JI-04'] = japaneseNativeBehaviorVerdict(
          postPauseBehavior,
          japaneseModeRestored(initialBehavior, {
            sequence: 'JapaneseCurrent',
            behavior: finalBehavior,
          }),
          capsLockComparison
        );
      } catch (error) {
        verdicts['JI-04'] = { status: 'Fail', reason: String(error) };
        errors.push(error);
      }
    } else {
      verdicts['JI-04'] = {
        status: 'Not run',
        reason: 'The original Japanese input mode was not observed; native retries are withheld.',
      };
    }
  } finally {
    result.observations.push({ stage: 'japanese-case-verdicts', verdicts });
  }
  const incomplete = japaneseIncompleteVerdicts(verdicts);
  if (incomplete.length) {
    errors.push(new Error(`Required Japanese evidence incomplete: ${incomplete.join('; ')}`));
  }
  if (errors.length) throw new AggregateError(errors, 'Japanese native IME cases failed');
}

/** Run the source-bound baseline in the prepared Windows browser. */
export async function runViewingExperienceFixture({
  browser,
  root,
  output,
  userscript,
  watchHtml,
  readPrimaryGeometry,
  japaneseIme = false,
}: {
  browser: Browser;
  root: string;
  output: string;
  userscript: string;
  watchHtml: string;
  readPrimaryGeometry: (modal: Locator) => Promise<PrimarySettingsGeometry>;
  japaneseIme?: boolean;
}) {
  const media = {} as Record<Scene, Buffer>;
  for (const scene of Object.keys(MEDIA) as Scene[]) {
    const bytes = await readFile(join(root, `validation/windows/fixtures/viewing-${scene}.mp4`));
    assert.equal(sha256(bytes), MEDIA[scene], `${scene} owned media changed`);
    media[scene] = bytes;
  }
  const imeSelection = await readViewingImeSelection(root);
  if (japaneseIme) {
    assert.equal(
      imeSelection,
      'not-run',
      'Japanese and Korean IME selectors are mutually exclusive'
    );
  }
  const imeRequested = japaneseIme || imeSelection !== 'not-run';
  const nativeOnly = japaneseIme || imeSelection === 'only';
  let nativeImeInput: 'not-run' | 'failed' | 'verified' = imeRequested ? 'failed' : 'not-run';
  let nativeShortcut: 'not-run' | 'delivered' | 'unavailable-ime-consumed' = 'not-run';
  const cases: Case[] = [];
  const pageErrors: string[] = [];
  const state: RouteState = { disconnected: false, servedIds: [], mediaRanges: [] };
  const html = watchPage(watchHtml);
  if (!nativeOnly) {
    const context = await browser.newContext({
      locale: 'en-US',
      viewport: { width: 1280, height: 720 },
    });
    try {
      await installFixture(context, userscript, html, media, state);
      const page = await openPage(context);
      page.on('pageerror', (error) => pageErrors.push(error.message));
      cases.push(
        await runCase('Y04-live-controls', async (result) => {
          result.observations.push({
            stage: 'fresh',
            state: await snapshot(page),
            firstTimeHumanObserved: false,
          });
          await openSettings(page);
          const modal = page.locator(MODAL);
          await modal.evaluate(async (element) => {
            await Promise.allSettled(
              element.getAnimations().map((animation) => animation.finished)
            );
          });
          for (const viewport of [
            { width: 1280, height: 720 },
            { width: 401, height: 592 },
          ]) {
            await page.setViewportSize(viewport);
            const geometry = await readPrimaryGeometry(modal);
            assert.equal(geometry.paneScrollTop, 0, 'Primary settings scrolled before editing');
            assert.equal(
              geometry.horizontalOverflow,
              false,
              'Primary settings overflow horizontally'
            );
            assert(geometry.controlsVisible, 'A primary settings control starts clipped');
            assert(geometry.pauseVisible, 'Session pause starts clipped');
            assert(geometry.pauseTarget, 'Session pause target is below 44 px');
            assert(geometry.pauseBesideEnabled, 'Session pause is not beside Enabled');
            assert(geometry.sampleInsidePane, 'The default opacity sample starts clipped');
            assert(geometry.sampleInsideStage, 'The default sample overflows its preview stage');
            result.observations.push({ stage: 'default-primary-geometry', viewport, geometry });
          }
          await page.setViewportSize({ width: 1280, height: 720 });
          await setNumber(page, 'fontSize', '26');
          await setNumber(page, 'opacity', '70', 0.7);
          result.observations.push({
            stage: 'size-opacity',
            state: await snapshot(page),
            actionPath: 'gear > Comments > Size / Text opacity',
            shortcutHintPresent: await page
              .locator(MODAL)
              .evaluate((node) => (node.textContent ?? '').includes('Ctrl+Space')),
          });
          result.screenshots.push(await screenshot(page, output, 'viewing-y04-comments-controls'));
          await closeSettings(page);
          const beforePause = await snapshot(page);
          await page.keyboard.press('Control+Space');
          await page
            .locator('#yt-live-chat-overlay')
            .getByText('Paused', { exact: true })
            .waitFor({ state: 'visible' });
          await assertVideoAdvances(page);
          result.observations.push({
            stage: 'overlay-paused',
            beforePause,
            state: await snapshot(page),
            actionPath: 'Ctrl+Space',
          });
          result.screenshots.push(await screenshot(page, output, 'viewing-y04-paused'));
          await page.keyboard.press('Control+Space');
          await page
            .locator('#yt-live-chat-overlay')
            .getByText('Paused', { exact: true })
            .waitFor({ state: 'hidden' });
          result.observations.push({ stage: 'overlay-resumed', state: await snapshot(page) });
          await openSettings(page);
          await page.locator(`${MODAL} input[name="enabled"]`).uncheck();
          await page.waitForFunction(
            () => window.__ytChatOverlay?.getSettings?.().enabled === false
          );
          result.observations.push({ stage: 'disabled', state: await snapshot(page) });
          await page.locator(`${MODAL} input[name="enabled"]`).check();
          await page.waitForFunction(
            () => window.__ytChatOverlay?.getSettings?.().enabled === true
          );
          await page.locator(`${MODAL} #tab-advanced`).click();
          await page.emulateMedia({ reducedMotion: 'reduce' });
          result.observations.push({
            stage: 'reduced-motion-control',
            label: await page
              .locator(`${MODAL} input[name="ignoreReducedMotion"]`)
              .evaluate((node) => node.closest('label')?.textContent ?? ''),
            state: await snapshot(page),
          });
          await page.emulateMedia({ reducedMotion: 'no-preference' });
          await closeSettings(page);
        })
      );
    } finally {
      await context.close();
    }
  }
  const viewingState: RouteState = { disconnected: false, servedIds: [], mediaRanges: [] };
  if (!nativeOnly) {
    const viewingContext = await browser.newContext({
      locale: 'en-US',
      viewport: { width: 1280, height: 720 },
    });
    try {
      await installFixture(viewingContext, userscript, html, media, viewingState);
      let page = await openPage(viewingContext);
      page.on('pageerror', (error) => pageErrors.push(error.message));
      cases.push(
        await runCase('Y05-moving-video', async (result) => {
          for (const scene of Object.keys(MEDIA) as Scene[]) {
            const baselinePage = await openPage(viewingContext);
            try {
              await setScene(baselinePage, scene);
              const ids = await feed(baselinePage, `low-${scene}`, 2);
              await waitForAnyRow(baselinePage, ids);
              await waitForMovingChatFrame(baselinePage);
              result.observations.push({
                stage: `${scene}-normal-default-mid`,
                ids,
                state: await snapshot(baselinePage),
              });
              result.screenshots.push(
                await screenshot(baselinePage, output, `viewing-y05-${scene}-normal`)
              );
            } finally {
              await baselinePage.close();
            }
          }
          await setScene(page, 'detailed');
          await page.locator('#yt-viewing-theater').click();
          const highIds = await feed(page, 'high-theater', 12);
          await waitForAnyRow(page, highIds);
          await waitForMovingChatFrame(page);
          result.observations.push({
            stage: 'detailed-theater-high',
            state: await snapshot(page),
            inputCount: 12,
          });
          result.screenshots.push(await screenshot(page, output, 'viewing-y05-theater-high'));
          await page.locator('#yt-viewing-fullscreen').click();
          await page.waitForFunction(() => Boolean(document.fullscreenElement));
          result.observations.push({ stage: 'detailed-fullscreen', state: await snapshot(page) });
          result.screenshots.push(await screenshot(page, output, 'viewing-y05-fullscreen'));
          await page.keyboard.press('Escape');
          await page.close();
          page = await openPage(viewingContext);
          await setScene(page, 'detailed');
          await openSettings(page);
          await page
            .locator(`${MODAL} details`)
            .first()
            .evaluate((element) => {
              (element as HTMLDetailsElement).open = true;
            });
          await setNumber(page, 'safeBottom', '25', 0.25);
          await page.locator(`${MODAL} #tab-colors`).click();
          await setNumber(page, 'outline-widthPx', '3');
          await page.locator(`${MODAL} #tab-comments`).click();
          const preview = page.locator(
            `${MODAL} #pane-comments .yt-chat-overlay-settings-font-preview`
          );
          await preview
            .locator('.yt-chat-overlay-settings-font-preview-text')
            .scrollIntoViewIfNeeded();
          const previewGeometry = await preview.evaluate((element) => {
            const pane = element.closest<HTMLElement>('#pane-comments');
            const stage = element.querySelector<HTMLElement>(
              '.yt-chat-overlay-settings-font-preview-stage'
            );
            const text = element.querySelector<HTMLElement>(
              '.yt-chat-overlay-settings-font-preview-text'
            );
            const topZone = element.querySelector<HTMLElement>(
              '.yt-chat-overlay-settings-font-preview-zone[data-preview-zone="top"]'
            );
            const bottomZone = element.querySelector<HTMLElement>(
              '.yt-chat-overlay-settings-font-preview-zone[data-preview-zone="bottom"]'
            );
            if (!pane || !stage || !text || !topZone || !bottomZone)
              throw new Error('Adjusted preview DOM is incomplete');
            const paneBounds = pane.getBoundingClientRect();
            const previewBounds = element.getBoundingClientRect();
            const stageBounds = stage.getBoundingClientRect();
            const textBounds = text.getBoundingClientRect();
            const topBounds = topZone.getBoundingClientRect();
            const bottomBounds = bottomZone.getBoundingClientRect();
            return {
              paneScrollTop: pane.scrollTop,
              paneBounds: { top: paneBounds.top, bottom: paneBounds.bottom },
              previewBounds: { top: previewBounds.top, bottom: previewBounds.bottom },
              stageBounds: { top: stageBounds.top, bottom: stageBounds.bottom },
              textBounds: { top: textBounds.top, bottom: textBounds.bottom },
              topZoneBottom: topBounds.bottom,
              bottomZoneTop: bottomBounds.top,
              bottomFraction: bottomBounds.height / stageBounds.height,
              previewText: text.textContent,
              metrics: element.querySelector('[data-preview-metrics]')?.textContent ?? null,
            };
          });
          result.observations.push({
            stage: 'adjusted-preview',
            previewGeometry,
            state: await snapshot(page),
          });
          result.screenshots.push(await screenshot(page, output, 'viewing-y05-preview-adjusted'));
          assert(previewGeometry.previewText, 'Adjusted preview text is missing');
          assert(
            previewGeometry.textBounds.top >= previewGeometry.paneBounds.top - 1 &&
              previewGeometry.textBounds.bottom <= previewGeometry.paneBounds.bottom + 1,
            'Adjusted preview text is outside the Comments pane'
          );
          assert(
            previewGeometry.textBounds.top >= previewGeometry.stageBounds.top - 1 &&
              previewGeometry.textBounds.bottom <= previewGeometry.stageBounds.bottom + 1,
            'Adjusted preview text is outside its stage'
          );
          assert(
            previewGeometry.textBounds.top >= previewGeometry.topZoneBottom - 1 &&
              previewGeometry.textBounds.bottom <= previewGeometry.bottomZoneTop + 1,
            'Adjusted preview text overlaps a safe zone'
          );
          assert(
            Math.abs(previewGeometry.bottomFraction - 0.25) < 0.02,
            'Adjusted bottom safe zone does not match the chosen 25%'
          );
          await closeSettings(page);
          const adjustedIds = await feed(page, 'adjusted', 2);
          await waitForAnyRow(page, adjustedIds);
          await waitForMovingChatFrame(page);
          result.observations.push({
            stage: 'adjusted-video',
            adjustedIds,
            state: await snapshot(page),
            pairedWith: 'detailed-normal-default-mid',
          });
          result.screenshots.push(await screenshot(page, output, 'viewing-y05-video-adjusted'));

          await openSettings(page, 'translation');
          await page.locator(`${MODAL} select[name="translationSource"]`).selectOption('en');
          await page.locator(`${MODAL} select[name="translationTarget"]`).selectOption('ko');
          await page.locator(`${MODAL} input[name="translationEnabled"]`).check();
          await page.waitForFunction(
            () =>
              document.querySelector<HTMLElement>('.yt-chat-overlay-settings-runtime-status')
                ?.dataset.phase === 'active',
            null,
            { timeout: 10_000 }
          );
          result.observations.push({
            stage: 'controlled-translation-active',
            state: await snapshot(page),
          });
          await closeSettings(page);
          const translatedIds = await feed(page, 'translated', 5);
          await waitForAnyRow(page, translatedIds);
          await waitForMovingChatFrame(page);
          result.observations.push({
            stage: 'translated-chat-over-video',
            translatedIds,
            state: await snapshot(page),
          });
          result.screenshots.push(await screenshot(page, output, 'viewing-y05-translated'));

          await page.emulateMedia({ reducedMotion: 'reduce' });
          result.observations.push({ stage: 'reduced-motion', state: await snapshot(page) });
          result.screenshots.push(await screenshot(page, output, 'viewing-y05-reduced-motion'));
          await page.emulateMedia({ reducedMotion: 'no-preference' });
        })
      );
    } finally {
      await viewingContext.close();
    }
  }
  const replayState: RouteState = {
    disconnected: false,
    servedIds: [],
    mediaRanges: [],
    replayBatch: 'replay',
    replayRequests: [],
  };
  const nativeReplayProfile =
    imeRequested && process.platform === 'win32'
      ? await mkdtemp(join(root, 'yt-viewing-ime-chrome-'))
      : null;
  let replayContext: BrowserContext | undefined;
  try {
    replayContext = nativeReplayProfile
      ? await browser.browserType().launchPersistentContext(nativeReplayProfile, {
          channel: 'chrome',
          headless: false,
          args: ['--mute-audio'],
          locale: 'en-US',
          viewport: { width: 1280, height: 720 },
        })
      : await browser.newContext({
          locale: 'en-US',
          viewport: { width: 1280, height: 720 },
        });
    const activeReplayContext = replayContext;
    await installFixture(activeReplayContext, userscript, html, media, replayState);
    const replayPage = await openPage(activeReplayContext, true);
    const replayConsole: string[] = [];
    replayPage.on('pageerror', (error) => pageErrors.push(error.message));
    replayPage.on('console', (message) => {
      if (['warning', 'error'].includes(message.type()) && replayConsole.length < 20) {
        replayConsole.push(`${message.type()}: ${message.text().slice(0, 500)}`);
      }
    });
    cases.push(
      await runCase('Y04-replay-controls', async (result) => {
        const ids = ['viewing-replay-0', 'viewing-replay-1'];
        try {
          await waitForAnyRow(replayPage, ids);
        } catch (error) {
          result.observations.push({
            stage: 'replay-admission-timeout',
            route: {
              servedIds: [...replayState.servedIds],
              replayRequests: [...(replayState.replayRequests ?? [])],
              mediaRanges: [...replayState.mediaRanges],
            },
            state: await snapshot(replayPage),
            bootstrap: await replayPage.evaluate(() =>
              JSON.stringify(window.ytInitialData).slice(0, 1_200)
            ),
            pageErrors: [...pageErrors],
            console: [...replayConsole],
          });
          result.screenshots.push(
            await screenshot(replayPage, output, 'viewing-y04-replay-admission-error')
          );
          throw error;
        }
        result.observations.push({
          stage: 'fresh-replay',
          ids,
          state: await snapshot(replayPage),
          route: { replayRequests: [...(replayState.replayRequests ?? [])] },
          firstTimeHumanObserved: false,
        });
        await replayPage.keyboard.press('Control+Space');
        await replayPage
          .locator('#yt-live-chat-overlay')
          .getByText('Paused', { exact: true })
          .waitFor({ state: 'visible' });
        await assertVideoAdvances(replayPage);
        result.observations.push({
          stage: 'replay-overlay-paused',
          state: await snapshot(replayPage),
        });
        await replayPage.keyboard.press('Control+Space');
        await replayPage
          .locator('#yt-live-chat-overlay')
          .getByText('Paused', { exact: true })
          .waitFor({ state: 'hidden' });
        result.observations.push({
          stage: 'replay-overlay-resumed',
          state: await snapshot(replayPage),
        });
        if (!imeRequested) {
          result.observations.push({
            stage: 'native-ime-not-run',
            reason: 'Optional viewing-experience-ime.json selector is absent',
          });
          await exercisePauseButton(replayPage, result, output);
        } else {
          assert.equal(
            process.platform,
            'win32',
            'Requested native IME requires the Windows runner'
          );
          const originalTitle = await replayPage.title();
          const originalPlayerTabindex = await replayPage
            .locator('#movie_player')
            .getAttribute('tabindex');
          try {
            await prepareViewingImeCheckpoint(replayPage, japaneseIme);
            assert(nativeReplayProfile, 'Native IME profile was not created');
            const replayBrowser = activeReplayContext.browser();
            assert(replayBrowser, 'Native IME browser is unavailable');
            const identity = await ownedBrowserIdentity(replayBrowser, nativeReplayProfile);
            if (japaneseIme) {
              await exerciseJapaneseIme(replayPage, root, output, identity, result);
            } else {
              const current = await runNativeImeAction({
                page: replayPage,
                root,
                output,
                identity,
                sequence: 'ComposeCurrent',
                stage: 'compose-initial',
                focus: 'textarea',
                koreanLayout: true,
              });
              const currentState = await readViewingImeCheckpoint(replayPage, true);
              const initialBehavior = imeWordBehavior(currentState);
              result.observations.push({
                stage: 'native-ime-current-layout',
                ...current,
                state: currentState,
                behavior: initialBehavior,
                compositionEnds: observedCompositionEnds(currentState),
              });
              assertNativeImeAction(current, 'ComposeCurrent', true);
              assert.notEqual(
                initialBehavior,
                'unknown',
                'Initial Korean layout behavior is unclear'
              );
              if (initialBehavior === 'latin') {
                await resetViewingImeTrace(replayPage, true);
                const toggled = await runNativeImeAction({
                  page: replayPage,
                  root,
                  output,
                  identity,
                  sequence: 'ComposeToggleRoundTrip',
                  stage: 'compose-toggle',
                  focus: 'textarea',
                  koreanLayout: true,
                });
                const toggledState = await readViewingImeCheckpoint(replayPage, true);
                result.observations.push({
                  stage: 'native-ime-existing-korean-layout',
                  ...toggled,
                  state: toggledState,
                  compositionEnds: observedCompositionEnds(toggledState),
                });
                assertNativeImeAction(toggled, 'ComposeToggleRoundTrip', true);
                assert.equal(
                  imeWordBehavior(toggledState),
                  'hangul',
                  'Native Korean composition and committed 한글 text were not observed'
                );
              }
              let controlError: unknown;
              try {
                await resetViewingImeTrace(replayPage);
                const editableBefore = await readViewingImeCheckpoint(replayPage);
                const editableControls = await runNativeImeAction({
                  page: replayPage,
                  root,
                  output,
                  identity,
                  sequence: 'CtrlSpaceRoundTrip',
                  stage: 'ctrl-editable',
                  focus: 'textarea',
                  koreanLayout: true,
                });
                await replayPage.waitForTimeout(100);
                const editableState = await readViewingImeCheckpoint(replayPage);
                result.observations.push({
                  stage: 'native-ime-editable-control',
                  ...editableControls,
                  state: editableState,
                });
                assertNativeImeAction(editableControls, 'CtrlSpaceRoundTrip', true);
                const editableRoute = assertNativeEditableCtrlSpace(
                  editableState,
                  editableControls.samples,
                  editableBefore.input
                );
                result.observations.push({
                  stage: 'native-ime-editable-route',
                  route: editableRoute,
                });
                await assertVideoAdvances(replayPage);

                await resetViewingImeTrace(replayPage);
                const noneditableBefore = await readViewingImeCheckpoint(replayPage);
                const noneditableControls = await runNativeImeAction({
                  page: replayPage,
                  root,
                  output,
                  identity,
                  sequence: 'CtrlSpaceRoundTrip',
                  stage: 'ctrl-noneditable',
                  focus: 'player',
                  koreanLayout: true,
                });
                await replayPage.waitForTimeout(100);
                const noneditableState = await readViewingImeCheckpoint(replayPage);
                result.observations.push({
                  stage: 'native-ime-noneditable-control',
                  ...noneditableControls,
                  state: noneditableState,
                });
                assertNativeImeAction(noneditableControls, 'CtrlSpaceRoundTrip', true);
                nativeShortcut = assertNativePlayerCtrlSpace(
                  noneditableState,
                  noneditableControls.samples,
                  noneditableBefore.input
                );
                result.observations.push({
                  stage: 'native-ime-player-shortcut-route',
                  route: nativeShortcut,
                  functional: nativeShortcut === 'delivered',
                });
                await assertVideoAdvances(replayPage);
              } catch (error) {
                controlError = error;
              }

              let restorationError: unknown;
              try {
                await resetViewingImeTrace(replayPage, true);
                const restored = await runNativeImeAction({
                  page: replayPage,
                  root,
                  output,
                  identity,
                  sequence: 'ComposeCurrent',
                  stage: 'compose-restoration',
                  focus: 'textarea',
                  koreanLayout: true,
                });
                const restoredState = await readViewingImeCheckpoint(replayPage, true);
                const restoredBehavior = imeWordBehavior(restoredState);
                result.observations.push({
                  stage: 'native-ime-mode-behavior-restoration',
                  ...restored,
                  state: restoredState,
                  initialBehavior,
                  restoredBehavior,
                  compositionEnds: observedCompositionEnds(restoredState),
                  tsfModeVerified: false,
                });
                assertNativeImeAction(restored, 'ComposeCurrent', true);
                assert.equal(
                  restoredBehavior,
                  initialBehavior,
                  'Observed IME behavior changed after round trips'
                );
              } catch (error) {
                restorationError = error;
              }
              let pauseButtonError: unknown;
              try {
                await replayPage.locator('#yt-viewing-ime-input').evaluate((input) => {
                  (input as HTMLTextAreaElement).hidden = true;
                });
                await exercisePauseButton(replayPage, result, output);
              } catch (error) {
                pauseButtonError = error;
              }
              if (controlError || restorationError || pauseButtonError) {
                throw new AggregateError(
                  [controlError, restorationError, pauseButtonError].filter(
                    (error) => error !== undefined
                  ),
                  'Native shortcut, IME restoration, or pause button failed'
                );
              }
            }
          } finally {
            const cleanup = await replayPage.evaluate(
              ({ title, playerTabindex }) => {
                document.querySelector('#yt-viewing-ime-input')?.remove();
                document.querySelector('#yt-viewing-ime-editable')?.remove();
                if (window.__ytViewingPlayerSpaceHandler) {
                  document.removeEventListener('keydown', window.__ytViewingPlayerSpaceHandler);
                  delete window.__ytViewingPlayerSpaceHandler;
                }
                delete window.__ytViewingImeEvents;
                delete window.__ytViewingImeTraceOverflow;
                delete window.__ytViewingImeRecord;
                const player = document.querySelector<HTMLElement>('#movie_player');
                if (playerTabindex === null) player?.removeAttribute('tabindex');
                else player?.setAttribute('tabindex', playerTabindex);
                document.title = title;
                return {
                  title: document.title,
                  inputRemoved: document.querySelector('#yt-viewing-ime-input') === null,
                  editableRemoved: document.querySelector('#yt-viewing-ime-editable') === null,
                  traceRemoved: !('__ytViewingImeEvents' in window),
                  playerTabindex: player?.getAttribute('tabindex') ?? null,
                };
              },
              { title: originalTitle, playerTabindex: originalPlayerTabindex }
            );
            result.observations.push({ stage: 'native-ime-dom-cleanup', cleanup });
            assert.deepEqual(cleanup, {
              title: originalTitle,
              inputRemoved: true,
              editableRemoved: true,
              traceRemoved: true,
              playerTabindex: originalPlayerTabindex,
            });
          }
          nativeImeInput = 'verified';
        }
      })
    );
  } finally {
    if (replayContext) {
      await replayContext.close();
      if (nativeReplayProfile) await rm(nativeReplayProfile, { recursive: true, force: true });
    }
  }
  if (!nativeOnly) {
    for (const language of [
      { id: 'en', locale: 'en-US' },
      { id: 'ko', locale: 'ko-KR' },
      { id: 'ja', locale: 'ja-JP' },
      { id: 'ar', locale: 'ar-SA' },
    ]) {
      const localState: RouteState = { disconnected: false, servedIds: [], mediaRanges: [] };
      const localContext = await browser.newContext({
        locale: language.locale,
        viewport: { width: 390, height: 720 },
      });
      try {
        await installFixture(localContext, userscript, html, media, localState, language.id);
        const localPage = await openPage(localContext);
        localPage.on('pageerror', (error) => pageErrors.push(error.message));
        cases.push(
          await runCase(`Y06-${language.id}-narrow`, async (result) => {
            if (language.id === 'ar') await localPage.emulateMedia({ forcedColors: 'active' });
            if (language.id === 'ja') await localPage.emulateMedia({ reducedMotion: 'reduce' });
            await openSettings(localPage);
            for (const tab of ['comments', 'colors', 'advanced', 'translation']) {
              await localPage.locator(`${MODAL} #tab-${tab}`).click();
              result.observations.push({ stage: tab, state: await snapshot(localPage) });
              if (language.id === 'en') {
                result.screenshots.push(
                  await screenshot(localPage, output, `viewing-y06-en-${tab}`)
                );
              }
            }
            if (language.id !== 'en') {
              result.screenshots.push(
                await screenshot(localPage, output, `viewing-y06-${language.id}-translation`)
              );
            }
            if (language.id === 'en') {
              const [chooser] = await Promise.all([
                localPage.waitForEvent('filechooser'),
                localPage.locator(`${MODAL} button[data-action="import"]`).click(),
              ]);
              await chooser.setFiles({
                name: 'invalid.json',
                mimeType: 'application/json',
                buffer: Buffer.from('{'),
              });
              await localPage
                .locator(`${MODAL} .yt-chat-overlay-settings-toast`)
                .waitFor({ state: 'visible' });
              await localPage.locator(`${MODAL} button[data-action="import"]`).focus();
              result.observations.push({
                stage: 'import-failure',
                toast: await localPage
                  .locator(`${MODAL} .yt-chat-overlay-settings-toast`)
                  .textContent(),
                toastLayout: await assertToastClearOfActions(localPage, true),
                state: await snapshot(localPage),
              });
              result.screenshots.push(
                await screenshot(localPage, output, 'viewing-y06-import-failure')
              );
              await localPage.locator(`${MODAL} button[data-action="reset"]`).click();
              const confirm = localPage.locator('dialog.yt-chat-overlay-settings-confirm');
              await confirm.waitFor({ state: 'visible' });
              result.observations.push({
                stage: 'reset-confirm',
                text: await confirm.textContent(),
                focus: await confirm.evaluate(() => document.activeElement?.className ?? null),
                state: await snapshot(localPage),
              });
              result.screenshots.push(
                await screenshot(localPage, output, 'viewing-y06-reset-confirm')
              );
              await confirm.locator('button.yt-chat-overlay-settings-confirm-cancel').click();
            }
            await localPage
              .locator(`${MODAL} select[name="translationService"]`)
              .selectOption('off');
            await localPage.locator(`${MODAL} input[name="translationEnabled"]`).check();
            result.observations.push({
              stage: 'translation-inactive',
              state: await snapshot(localPage),
            });
            await closeSettings(localPage);
            const ids = await feed(localPage, `localized-${language.id}`, 5);
            await waitForAnyRow(localPage, ids);
            await exerciseConnectionFault({
              page: localPage,
              routeState: localState,
              result,
              stage: `${language.id}-narrow`,
              capture: () => screenshot(localPage, output, `viewing-y06-${language.id}-fault`),
            });
          })
        );
      } finally {
        await localContext.close();
      }
    }
    cases.push(
      await runCase('Y06-unsaved-conflict-narrow', async (result) => {
        const recoveryState: RouteState = { disconnected: false, servedIds: [], mediaRanges: [] };
        const recoveryContext = await browser.newContext({
          locale: 'en-US',
          viewport: { width: 390, height: 720 },
        });
        try {
          await installFixture(recoveryContext, userscript, html, media, recoveryState);
          const page = await openPage(recoveryContext);
          page.on('pageerror', (error) => pageErrors.push(error.message));
          await openSettings(page);
          await setNumber(page, 'fontSize', '44');
          await page.evaluate(() => {
            window.__ytViewingDenyWrites = true;
          });
          await closeSettings(page);
          const notice = page.locator('.yt-chat-overlay-settings-persistence-notice');
          await notice.locator('button').waitFor({ state: 'visible' });
          result.observations.push({
            stage: 'unsaved',
            tooltipState: await assertNoticeTooltipClear(page),
            state: await snapshot(page),
          });
          result.screenshots.push(await screenshot(page, output, 'viewing-y06-unsaved-narrow'));
          const remote = await recoveryContext.newPage();
          await remote.goto(WATCH_URL, { waitUntil: 'domcontentloaded' });
          await remote.evaluate((key) => {
            const previous = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<
              string,
              unknown
            >;
            localStorage.setItem(key, JSON.stringify({ ...previous, fontSize: 52 }));
          }, SETTINGS_KEY);
          await notice.locator('button').getByText('Save my values').waitFor({ state: 'visible' });
          result.observations.push({
            stage: 'conflict',
            tooltipState: await assertNoticeTooltipClear(page),
            state: await snapshot(page),
          });
          result.screenshots.push(await screenshot(page, output, 'viewing-y06-conflict-narrow'));
        } finally {
          await recoveryContext.close();
        }
      })
    );
    cases.push(
      await runCase('Y06-real-200-percent-chrome', async (result) => {
        const bundle: unknown = JSON.parse(await readFile(join(root, 'bundle.json'), 'utf8'));
        assert(
          bundle && typeof bundle === 'object' && 'mode' in bundle && bundle.mode === 'desktop'
        );
        const profilePath = await mkdtemp(join(root, 'yt-viewing-zoom-chrome-'));
        let zoomContext: BrowserContext | undefined;
        let settingsPage: Page | undefined;
        let previousZoom: string | undefined;
        let primaryError: unknown;
        const cleanupErrors: unknown[] = [];
        let zoomRestored = false;
        let contextClosed = false;
        let profileRemoved = false;
        try {
          zoomContext = await browser.browserType().launchPersistentContext(profilePath, {
            channel: 'chrome',
            headless: false,
            args: ['--mute-audio'],
            locale: 'ko-KR',
            viewport: { width: 780, height: 720 },
          });
          const zoomState: RouteState = { disconnected: false, servedIds: [], mediaRanges: [] };
          await installFixture(zoomContext, userscript, html, media, zoomState, 'ko');
          const page = await openPage(zoomContext);
          page.on('pageerror', (error) => pageErrors.push(error.message));
          const baseline = await page.evaluate(() => ({
            dpr: devicePixelRatio,
            width: innerWidth,
          }));
          settingsPage = await zoomContext.newPage();
          await settingsPage.goto('chrome://settings/appearance');
          const zoom = settingsPage.locator('select#zoomLevel');
          previousZoom = await zoom.inputValue();
          assert.equal(Number(previousZoom), 1, 'Owned Chrome profile did not start at 100% zoom');
          await zoom.selectOption('2');
          await page.bringToFront();
          await page.waitForFunction(
            (before) =>
              Math.abs(devicePixelRatio / before.dpr - 2) < 0.02 &&
              Math.abs(innerWidth / before.width - 0.5) < 0.02,
            baseline,
            { timeout: 10_000 }
          );
          await openSettings(page);
          for (const tab of ['comments', 'colors', 'advanced', 'translation']) {
            await page.locator(`${MODAL} #tab-${tab}`).click();
            result.observations.push({ stage: `ko-200-${tab}`, state: await snapshot(page) });
          }
          const capture = await nativeZoomScreenshot(
            page,
            output,
            'viewing-y06-ko-200-translation'
          );
          result.screenshots.push(capture.file);
          result.observations.push({ screenshot: capture });
          const [chooser] = await Promise.all([
            page.waitForEvent('filechooser'),
            page.locator(`${MODAL} button[data-action="import"]`).click(),
          ]);
          await chooser.setFiles({
            name: 'invalid.json',
            mimeType: 'application/json',
            buffer: Buffer.from('{'),
          });
          await page
            .locator(`${MODAL} .yt-chat-overlay-settings-toast`)
            .waitFor({ state: 'visible' });
          await page.locator(`${MODAL} button[data-action="import"]`).focus();
          result.observations.push({
            stage: 'ko-200-import-failure',
            toastLayout: await assertToastClearOfActions(page, true),
            state: await snapshot(page),
          });
          const importCapture = await nativeZoomScreenshot(
            page,
            output,
            'viewing-y06-ko-200-import'
          );
          result.screenshots.push(importCapture.file);
          result.observations.push({ screenshot: importCapture });
          await page.locator(`${MODAL} button[data-action="reset"]`).click();
          const reset = page.locator('dialog.yt-chat-overlay-settings-confirm');
          await reset.waitFor({ state: 'visible' });
          result.observations.push({
            stage: 'ko-200-reset-confirm',
            text: await reset.textContent(),
            state: await snapshot(page),
          });
          await reset.locator('button.yt-chat-overlay-settings-confirm-cancel').click();
          await page.locator(`${MODAL} select[name="translationService"]`).selectOption('off');
          await page.locator(`${MODAL} input[name="translationEnabled"]`).check();
          result.observations.push({
            stage: 'ko-200-translation-inactive',
            state: await snapshot(page),
          });
          await page.locator(`${MODAL} select[name="language"]`).selectOption('ja');
          await page.locator(`${MODAL} button[data-action="import"]`).focus();
          result.observations.push({
            stage: 'ja-200-translation',
            toastLayout: await assertToastClearOfActions(page, false),
            state: await snapshot(page),
          });
          const japaneseCapture = await nativeZoomScreenshot(
            page,
            output,
            'viewing-y06-ja-200-translation'
          );
          result.screenshots.push(japaneseCapture.file);
          result.observations.push({ screenshot: japaneseCapture });
          await closeSettings(page);
          const ids = await feed(page, 'zoom-ja-long', 5);
          await waitForAnyRow(page, ids);
          await exerciseConnectionFault({
            page,
            routeState: zoomState,
            result,
            stage: 'ja-200',
            capture: async () => {
              const capture = await nativeZoomScreenshot(page, output, 'viewing-y06-ja-200-fault');
              result.observations.push({ screenshot: capture });
              return capture.file;
            },
          });
        } catch (error) {
          primaryError = error;
        } finally {
          if (settingsPage && previousZoom) {
            try {
              await settingsPage.locator('select#zoomLevel').selectOption(previousZoom);
              zoomRestored = true;
            } catch (error) {
              cleanupErrors.push(error);
            }
          }
          try {
            await zoomContext?.close();
            contextClosed = true;
          } catch (error) {
            cleanupErrors.push(error);
          }
          if (contextClosed) {
            try {
              assert(basename(profilePath).startsWith('yt-viewing-zoom-chrome-'));
              await rm(profilePath, { recursive: true });
              profileRemoved = true;
            } catch (error) {
              cleanupErrors.push(error);
            }
          }
        }
        result.observations.push({ cleanup: { zoomRestored, contextClosed, profileRemoved } });
        if (primaryError || cleanupErrors.length > 0) {
          const failures = [...(primaryError ? [primaryError] : []), ...cleanupErrors];
          throw new AggregateError(
            failures,
            `Owned Chrome zoom case or cleanup failed: ${failures.map(String).join(' | ')}`
          );
        }
      })
    );
  }
  const notRun = nativeOnly
    ? [
        'Y04-live-controls',
        'Y05-moving-video',
        'Y06-en-narrow',
        'Y06-ko-narrow',
        'Y06-ja-narrow',
        'Y06-ar-narrow',
        'Y06-unsaved-conflict-narrow',
        'Y06-real-200-percent-chrome',
      ]
    : [];
  const result = {
    checks: {
      sourceBoundMovingMedia: true,
      builtUserscriptFixture: true,
      sustainedViewingLifecycle: false,
      firstTimeHumanObservation: false,
      humanReadabilityJudgment: nativeOnly ? 'not-run' : 'pending-review',
      nativeImeInput,
      nativeShortcut,
      spokenScreenReaderCheck: 'not-run',
      nativeYouTubeControls: 'not-run',
      installedApplication: false,
      liveYouTube: false,
      failedCases: cases.filter((entry) => entry.error).map((entry) => entry.id),
      notRun,
      pageErrors,
    },
    observations: {
      profileMode: japaneseIme ? 'japanese-ime-only' : nativeOnly ? 'native-ime-only' : 'full',
      mediaSha256: MEDIA,
      browserVersion: browser.version(),
      cases,
      operatorTasks: [
        'Make comments smaller and less opaque',
        'Freeze comments while video continues, then resume',
        'Disable comments, then restore',
        'Explain and change reduced-motion behavior',
      ].map((task) => ({
        task,
        observed: false,
        timeToFindMs: null,
        wrongActions: null,
        helpRequests: null,
      })),
      servedIds: [...state.servedIds, ...viewingState.servedIds, ...replayState.servedIds],
      mediaRanges: [
        ...state.mediaRanges,
        ...viewingState.mediaRanges,
        ...replayState.mediaRanges,
      ].slice(0, 30),
      scope:
        'built userscript; controlled parser-fed chat and owned moving video in prepared Windows browser',
    },
  };
  await writeFile(join(output, 'viewing-experience.json'), JSON.stringify(result, null, 2));
  if (nativeOnly) {
    assert.equal(
      nativeImeInput,
      'verified',
      'Native-only diagnostic did not verify native IME input'
    );
  }
  assert.equal(
    cases.filter((entry) => entry.error).length,
    0,
    'Viewing baseline case failed; inspect viewing-experience.json'
  );
  assert.deepEqual(pageErrors, [], 'Viewing baseline page errors');
  return result;
}
