// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BrowserContext, Page } from '@playwright/test';

import {
  installNativePageScriptProbe,
  type NativePageScriptProbe,
} from './native-page-script-probe.ts';
import {
  canvasProbePrelude,
  instrumentCardPlanCalls,
  instrumentCanvasPageScript,
  workerProbePrelude,
} from './placement-timing.ts';
import { mediaResponse } from './reload-feedback.ts';
import { buildVisibleWatchHtml } from './visible-watch.ts';

const FIXTURE_URL = 'https://www.youtube.com/watch?v=windows380CommentDisplay';
const EMOJI_URL = 'https://yt3.ggpht.com/windows380-emoji';
const EMOJI_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR4nGP8z8DwnwEJMDGgAcICAIPRAgYCkO9YAAAAAElFTkSuQmCC',
  'base64'
);
const STICKER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAYAAACzzX7wAAAAEklEQVR4nGP4f0fjPz7MQHsFAN2sYEGbnrNjAAAAAElFTkSuQmCC',
  'base64'
);
const IDS = [
  'WINDOWS380_COMBINING',
  'WINDOWS380_MODIFIER',
  'WINDOWS380_ZWJ',
  'WINDOWS380_EMOJI',
  'WINDOWS380_RTL',
  'WINDOWS380_PAID',
  'WINDOWS380_MOTION',
  'WINDOWS380_ZERO',
  'WINDOWS380_RESTORED',
  'WINDOWS380_REDUCED',
  'WINDOWS380_RATE_ZERO_FIRST',
  'WINDOWS380_RATE_ZERO_LAST',
  'WINDOWS380_RATE_POS_FIRST',
  'WINDOWS380_RATE_POS_LAST',
] as const;
const SCENES = ['bright', 'dark', 'detailed'] as const;
type Scene = (typeof SCENES)[number];
const PRESENTATION_IDS = Object.fromEntries(
  SCENES.map((scene) => [
    scene,
    {
      paid: `WINDOWS380_${scene.toUpperCase()}_PAID`,
      sticker: `WINDOWS380_${scene.toUpperCase()}_STICKER`,
      membership: `WINDOWS380_${scene.toUpperCase()}_MEMBERSHIP`,
      ordinary: `WINDOWS380_${scene.toUpperCase()}_ORDINARY`,
    },
  ])
) as Record<Scene, { paid: string; sticker: string; membership: string; ordinary: string }>;
const PROBE_IDS = [...IDS, ...Object.values(PRESENTATION_IDS).flatMap(Object.values)];
const MAX_RECORDS = 48;
const MAX_FRAME_DRAWS = 240;
// Extra translated-frame and production-preview waits remain under a hard backend deadline.
const MAX_RUN_MS = 60_000;
const MAX_PHASES_PER_BACKEND = 16;
const MAX_CAPTURES_PER_BACKEND = 12;
const MAX_OVERLOAD_MS = 120_000;
const MAX_OVERLOAD_RECORDS = 128;

export type MatrixMode = 'baseline' | 'candidate';
type Backend = 'worker' | 'main';
type MatrixDraw = {
  id: string;
  kind?: string;
  section?: 'body' | 'translation' | 'regular';
  alpha: number;
  rect: Rect | null;
  textSnippet?: string | null;
};
type Rect = { left: number; top: number; right: number; bottom: number };
type CardPlanObservation = {
  id: string;
  kind: string;
  height: number;
  maxBodyLines: number;
  bodyRows: number;
  bodyY: number | null;
  bodyHeight: number;
  translationRows: number;
  translationY: number | null;
  translationHeight: number;
  borderAlpha: number | null;
  borderStyle: string | null;
};
type MatrixFrame = {
  frameId: number;
  startedAtEpochMs: number;
  complete: boolean;
  cleared: boolean;
  truncated: boolean;
  logicalWidth: number | null;
  logicalHeight: number | null;
  backingRatioX: number;
  backingRatioY: number;
  active: Array<{ id: string; x: number; y: number; width: number; height: number }>;
  draws: MatrixDraw[];
  cardPlans: CardPlanObservation[];
  config: { reducedMotion?: boolean | null; ignoreReducedMotion?: boolean | null };
};
type MatrixSnapshot = {
  backend: Backend;
  sourcePrefixed: boolean;
  sourceHooked: boolean;
  canvasSourceHooked: boolean;
  workerReady: boolean;
  viewport: { width: number; height: number; dpr: number };
  overlay: { width: number; height: number; left: number; top: number } | null;
  frame: MatrixFrame | null;
  layout: string | null;
  firstEntry: Record<string, number>;
  ingress: Record<string, number>;
  dispositions: Array<{
    id: string;
    kind: string;
    reason: string | null;
    atEpochMs: number | null;
    queueResidenceMs: number | null;
    isBacklog: boolean | null;
  }>;
  pendingNow: string[];
  queuedNow: Array<{ id: string; atEpochMs: number }>;
  retained: Record<string, number | null> | null;
  activeNow: Array<{
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    isScrolling?: boolean | null;
    slotCount?: number | null;
    startAtEpochMs?: number | null;
    endAtEpochMs?: number | null;
    durationMs?: number | null;
    actualVelocityPxPerMs?: number | null;
  }>;
  frames: Array<{ workMs: number; preClearMs?: number | null }>;
  drains: Array<{ workMs: number; pendingBefore: number | null }>;
  ink: Array<{
    id: string;
    left: number;
    top: number;
    right: number;
    bottom: number;
    kind: string | null;
  }>;
  stats: Array<{
    totalRendered: number | null;
    totalPresented: number | null;
    pendingQueueDepth: number | null;
  }>;
  accessibility: Record<string, string>;
  fixtureText: Record<string, string>;
  measuredPlans: Record<string, { width: number; height: number; maxBodyLines: number }>;
  presentationCount: number | null;
  totalPresentationUnknown: number | null;
  presentationCounterAvailable: boolean;
  overflow: number;
};
type PreviewSample = {
  label: string;
  ariaLabel: string;
  width: number;
  height: number;
  alphaPixels: number;
};

export function assertPreviewComparison(stacked: PreviewSample[], wide: PreviewSample[]) {
  assert.equal(stacked.length, 3, 'Production preview needs three card samples');
  assert.equal(wide.length, 3, 'Production preview needs three card samples');
  for (const sample of [...stacked, ...wide]) {
    assert(sample.label && sample.ariaLabel, 'Preview sample lacks an accessible label');
    assert(sample.width > 0 && sample.height > 0 && sample.alphaPixels > 0);
  }
  assert(wide[0]?.ariaLabel.includes('A very long author 이름'));
  assert(wide[1]?.ariaLabel.includes('長い名前 مرحبا'));
  assert(wide[2]?.ariaLabel.includes('Member 회원'));
  assert(
    stacked.some(
      (sample, index) =>
        sample.width !== wide[index]?.width || sample.height !== wide[index]?.height
    ),
    'Production preview did not respond to the stacked/wide setting'
  );
}

function textAction(id: string, body: string) {
  return {
    addChatItemAction: {
      item: {
        liveChatTextMessageRenderer: {
          id,
          authorName: { simpleText: `Fixture viewer ${id}` },
          message: { runs: [{ text: `${id} ${body}` }] },
        },
      },
    },
  };
}

function paidAction() {
  return {
    addChatItemAction: {
      item: {
        liveChatPaidMessageRenderer: {
          id: IDS[5],
          authorName: { simpleText: 'Fixture donor' },
          purchaseAmountText: { simpleText: '$5.00' },
          message: { simpleText: `${IDS[5]} paid body` },
        },
      },
    },
  };
}

function emojiAction() {
  const emoji = (index: number) => ({
    emoji: {
      shortcuts: [':fixture:'],
      image: {
        thumbnails: [
          {
            url: `${EMOJI_URL}-${index}`,
            width: 48,
            height: 48,
          },
        ],
      },
    },
  });
  return {
    addChatItemAction: {
      item: {
        liveChatTextMessageRenderer: {
          id: IDS[3],
          authorName: { simpleText: 'Fixture emoji viewer' },
          message: {
            runs: [
              { text: `${IDS[3]} 東京の夜空\n` },
              emoji(1),
              emoji(2),
              emoji(3),
              { text: ' fallback 😀' },
            ],
          },
        },
      },
    },
  };
}

function presentationActions(scene: Scene) {
  const ids = PRESENTATION_IDS[scene];
  return [
    {
      addChatItemAction: {
        item: {
          liveChatPaidMessageRenderer: {
            id: ids.paid,
            authorName: { simpleText: 'أميرة東京LongAuthorName🌙🌙🌙' },
            authorPhoto: {
              thumbnails: [{ url: `${EMOJI_URL}-missing-author`, width: 48, height: 48 }],
            },
            purchaseAmountText: { simpleText: '١٬٢٣٤٬٥٦٧٫٨٩ د.إ' },
            message: {
              simpleText: `${ids.paid} 한국어 original text with a long localized amount CANONICAL_END`,
            },
          },
        },
      },
    },
    {
      addChatItemAction: {
        item: {
          liveChatPaidMessageRenderer: {
            id: ids.sticker,
            purchaseAmountText: { simpleText: '¥12,345' },
            sticker: {
              accessibility: { accessibilityData: { label: `${ids.sticker} sticker` } },
              thumbnails: [{ url: `${EMOJI_URL}-sticker`, width: 96, height: 48 }],
            },
          },
        },
      },
    },
    {
      addChatItemAction: {
        item: {
          liveChatMembershipItemRenderer: {
            id: ids.membership,
            authorName: { simpleText: 'メンバー 회원' },
            headerPrimaryText: { simpleText: 'Member for 12 months' },
            message: { simpleText: `${ids.membership} ありがとう` },
          },
        },
      },
    },
    textAction(ids.ordinary, 'Ordinary comment near paid cards'),
  ];
}

const COMBINING_ACTION = textAction(
  IDS[0],
  `${'A'.repeat(78 - IDS[0].length - 1)}e\u0301ZZZ CANONICAL_END`
);

export const MATRIX_BATCHES = Object.freeze({
  content: [
    COMBINING_ACTION,
    textAction(IDS[1], `${'A'.repeat(78 - IDS[1].length - 1)}👍🏽Z CANONICAL_END`),
    textAction(IDS[2], `${'A'.repeat(77 - IDS[2].length - 1)}👨‍👩‍👧‍👦Z CANONICAL_END`),
    emojiAction(),
    textAction(IDS[4], 'مرحبا بالعالم 한국어 English'),
    paidAction(),
  ],
  narrow: [COMBINING_ACTION],
  motion: [textAction(IDS[6], 'Moving comment with stable source identity')],
  zero: [textAction(IDS[7], 'Zero-capacity row must remain pending')],
  restored: [textAction(IDS[8], 'Rows become available again')],
  reduced: [textAction(IDS[9], `${'W'.repeat(100)} fixed by reduced motion`)],
  rateZero: Array.from({ length: 51 }, (_, index) =>
    textAction(
      index === 0 ? IDS[10] : index === 50 ? IDS[11] : `WINDOWS380_RATE_ZERO_${index}`,
      'Bounded initial backlog with conflicting minimum and zero maximum'
    )
  ),
  ratePositive: Array.from({ length: 51 }, (_, index) =>
    textAction(
      index === 0 ? IDS[12] : index === 50 ? IDS[13] : `WINDOWS380_RATE_POS_${index}`,
      'Bounded later backlog with positive maximum'
    )
  ),
  presentationBright: presentationActions('bright'),
  presentationDark: presentationActions('dark'),
  presentationDetailed: presentationActions('detailed'),
});

function overloadPaidAction(id: string, body: string) {
  return {
    addChatItemAction: {
      item: {
        liveChatPaidMessageRenderer: {
          id,
          authorName: { simpleText: `Paid fixture ${id}` },
          purchaseAmountText: { simpleText: '$25.00' },
          message: { simpleText: `${id} ${body}` },
        },
      },
    },
  };
}

const OVERFLOW_SEED_BATCHES = Object.fromEntries(
  Array.from({ length: 20 }, (_, batch) => [
    `overflowSeed${batch}`,
    Array.from({ length: 4 }, (_, offset) =>
      textAction(
        `WINDOWS380_LOAD_OVERFLOW_OLD_${batch * 4 + offset}`,
        'Equal priority waiting content'
      )
    ),
  ])
) as Record<`overflowSeed${number}`, ReturnType<typeof textAction>[]>;

export const OVERLOAD_BATCHES = Object.freeze({
  vacancySeed: [
    ...Array.from({ length: 4 }, (_, index) =>
      overloadPaidAction(`WINDOWS380_LOAD_VACANCY_PAID_${index}`, 'Recurring paid arrival')
    ),
    textAction('WINDOWS380_LOAD_VACANCY_ORDINARY', 'Compatible waiting ordinary'),
  ],
  vacancyMoreA: [
    ...Array.from({ length: 4 }, (_, index) =>
      overloadPaidAction(`WINDOWS380_LOAD_VACANCY_MORE_A_PAID_${index}`, 'Paid after a vacancy')
    ),
    textAction('WINDOWS380_LOAD_VACANCY_LATE_ORDINARY', 'Ordinary after renewed paid pressure'),
  ],
  vacancyMoreB: Array.from({ length: 4 }, (_, index) =>
    overloadPaidAction(`WINDOWS380_LOAD_VACANCY_MORE_B_PAID_${index}`, 'Paid after another vacancy')
  ),
  impossible: [
    overloadPaidAction('WINDOWS380_LOAD_IMPOSSIBLE_PAID', 'Tall paid body '.repeat(45)),
    ...Array.from({ length: 4 }, (_, index) =>
      textAction(`WINDOWS380_LOAD_IMPOSSIBLE_ORDINARY_${index}`, 'Fits a narrow lane')
    ),
  ],
  // Four actions per real response stay on the live path even under high
  // utilization; the combined cohort exceeds the 30 active/50 pending caps.
  ...OVERFLOW_SEED_BATCHES,
  overflowLate: Array.from({ length: 4 }, (_, index) =>
    textAction(`WINDOWS380_LOAD_OVERFLOW_NEW_${index}`, 'Later equal priority content')
  ),
  pause: [
    overloadPaidAction('WINDOWS380_LOAD_PAUSE_PAID', 'Paid while paused and hidden'),
    textAction('WINDOWS380_LOAD_PAUSE_ORDINARY', 'Ordinary while paused and hidden'),
  ],
  future: [
    textAction('WINDOWS380_LOAD_FUTURE_DUE', 'Replay due now'),
    {
      addChatItemAction: {
        item: {
          liveChatMembershipItemRenderer: {
            id: 'WINDOWS380_LOAD_FUTURE_MEMBERSHIP',
            authorName: { simpleText: 'Future member' },
            headerPrimaryText: { simpleText: 'Member for 12 months' },
            message: { simpleText: 'WINDOWS380_LOAD_FUTURE_MEMBERSHIP held until due' },
          },
        },
      },
    },
  ],
  zeroMembership: [
    {
      addChatItemAction: {
        item: {
          liveChatMembershipItemRenderer: {
            id: 'WINDOWS380_LOAD_ZERO_MEMBERSHIP',
            authorName: { simpleText: 'Zero-row member' },
            headerPrimaryText: { simpleText: 'Membership' },
            message: { simpleText: 'WINDOWS380_LOAD_ZERO_MEMBERSHIP must remain reserved' },
          },
        },
      },
    },
  ],
});

const OVERLOAD_IDS = Object.values(OVERLOAD_BATCHES).flatMap((batch) =>
  batch.map((action) => {
    const renderer = Object.values(action.addChatItemAction.item)[0] as { id: string } | undefined;
    assert(renderer?.id, 'Overload action requires a source ID');
    return renderer.id;
  })
);

type ManagerProbeRead = {
  installed: boolean;
  probeError: string | null;
  ownerCaptured: boolean;
  workerHooked: boolean;
  atEpochMs: number;
  manager: {
    latestWorkerPendingDepth: number;
    minimumWorkerPendingPriority: number | null;
    unacknowledgedBatches: Array<{
      sequence: number;
      count: number;
      epoch: number;
      saturationProbe: boolean;
    }> | null;
    pendingBatchCount: number | null;
    pendingBatch: Array<{
      id: string;
      priority: number;
      batchSequence: number;
      epoch: number;
    }> | null;
    deferredIngressCount: number | null;
    deferredIngress: Array<{ id: string; priority: number; epoch: number }> | null;
    currentEpoch: number;
    lastWorkerReceiptSequence: number | null;
    nextBatchSequence: number | null;
    pendingBatchSequence: number | null;
    sentMessagesSize: number | null;
    projectedWork: number | null;
  } | null;
  events: Array<Record<string, string | number | boolean | string[] | null>>;
  omittedEvents: number;
};

/** Pure entry insertion observes the real manager and native Worker transport. */
export function attachWorkerManagerProbe(
  Manager: { prototype: object },
  target: Record<string, unknown>,
  ids: readonly string[],
  requireCurrentState = true
): void {
  const knownIds = new Set(ids);
  const prototype = Manager.prototype as Record<string, unknown>;
  const nativeSend = prototype.sendToWorker;
  const nativeReceipt = prototype.applyBatchReceipt;
  const events: ManagerProbeRead['events'] = [];
  let omittedEvents = 0;
  let probeError: string | null = null;
  let owner: Record<string, unknown> | null = null;
  let hookedWorker: Record<string, unknown> | null = null;
  const epochNow = () => performance.timeOrigin + performance.now();
  const fail = (code: string) => {
    probeError ??= code;
  };
  const observe = (code: string, action: () => void) => {
    try {
      action();
    } catch {
      fail(code);
    }
  };
  const record = (event: ManagerProbeRead['events'][number]) => {
    if (events.length === 64) {
      events.shift();
      omittedEvents++;
    }
    events.push({ ...event, atEpochMs: epochNow() });
  };
  const asRecord = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  const finite = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  const captureOwner = (value: unknown) => {
    const next = asRecord(value);
    if (!next) fail('manager-instance-unavailable');
    else if (owner && owner !== next) fail('manager-instance-changed');
    else owner = next;
  };
  const hookWorker = (manager: Record<string, unknown>) => {
    const worker = asRecord(manager.worker);
    if (!worker || worker === hookedWorker) return;
    const originalPost = worker.postMessage;
    if (typeof originalPost !== 'function') {
      fail('native-post-unavailable');
      return;
    }
    const recordPost = (value: unknown, outcome: 'returned' | 'threw') => {
      const message = asRecord(value);
      if (message?.type !== 'addMessages') return;
      const rawMessages = Array.isArray(message.messages) ? message.messages : [];
      const fixtureMessageIds = rawMessages
        .map((item) => asRecord(item)?.id)
        .filter((id): id is string => typeof id === 'string' && knownIds.has(id))
        .slice(0, 128);
      record({
        kind: 'native-post',
        outcome,
        batchSequence: finite(message.batchSequence),
        epoch: finite(message.epoch),
        messageCount: rawMessages.length,
        fixtureMessageIds,
      });
    };
    const wrappedPost = function (this: unknown, ...args: unknown[]) {
      try {
        const result = Reflect.apply(originalPost, this, args);
        observe('native-post-record', () => recordPost(args[0], 'returned'));
        return result;
      } catch (error) {
        observe('native-post-record', () => recordPost(args[0], 'threw'));
        throw error;
      }
    };
    observe('native-post-hook', () => {
      worker.postMessage = wrappedPost;
      if (worker.postMessage !== wrappedPost) throw new Error('Native post hook unavailable');
      hookedWorker = worker;
    });
  };
  const read = (): ManagerProbeRead => {
    let manager: ManagerProbeRead['manager'] = null;
    observe('manager-state-shape', () => {
      if (!owner) return;
      const pending = owner.pendingBatch;
      const deferred = owner.deferredIngress;
      const unacknowledged = owner.unacknowledgedBatches;
      const sent = owner.sentMessages;
      const projected = owner.getProjectedWorkerWork;
      const depth = finite(owner.latestWorkerPendingDepth);
      const epoch = finite(owner.currentEpoch);
      if (depth === null || epoch === null) throw new Error('Manager counters changed');
      const projectedWork =
        typeof projected === 'function' ? finite(Reflect.apply(projected, owner, [])) : null;
      const currentStateAvailable =
        Array.isArray(pending) &&
        Array.isArray(deferred) &&
        unacknowledged instanceof Map &&
        sent instanceof Map &&
        projectedWork !== null &&
        finite(owner.lastWorkerReceiptSequence) !== null &&
        finite(owner.nextBatchSequence) !== null &&
        finite(owner.pendingBatchSequence) !== null;
      if (requireCurrentState && !currentStateAvailable)
        throw new Error('Manager state shape changed');
      const unacknowledgedBatches: NonNullable<
        ManagerProbeRead['manager']
      >['unacknowledgedBatches'] = unacknowledged instanceof Map ? [] : null;
      if (unacknowledgedBatches && unacknowledged instanceof Map) {
        for (const [sequence, value] of unacknowledged) {
          const entry = asRecord(value);
          const count = finite(entry?.count);
          const batchEpoch = finite(entry?.epoch);
          if (finite(sequence) === null || count === null || batchEpoch === null)
            throw new Error('Manager receipt state changed');
          if (unacknowledgedBatches.length === 128) unacknowledgedBatches.shift();
          unacknowledgedBatches.push({
            sequence,
            count,
            epoch: batchEpoch,
            saturationProbe: entry?.saturationProbe === true,
          });
        }
      }
      const fixtureRows = (rows: unknown[]) =>
        rows
          .map(asRecord)
          .filter((entry): entry is Record<string, unknown> =>
            Boolean(entry && typeof entry.id === 'string' && knownIds.has(entry.id))
          )
          .slice(0, 128);
      const requiredNumber = (value: unknown): number => {
        const measured = finite(value);
        if (measured === null) throw new Error('Manager row shape changed');
        return measured;
      };
      manager = {
        latestWorkerPendingDepth: depth,
        minimumWorkerPendingPriority: finite(owner.minimumWorkerPendingPriority),
        unacknowledgedBatches,
        pendingBatchCount: Array.isArray(pending) ? pending.length : null,
        pendingBatch: Array.isArray(pending)
          ? fixtureRows(pending).map((entry) => ({
              id: String(entry.id),
              priority: requiredNumber(entry.priority),
              batchSequence: requiredNumber(entry.batchSequence),
              epoch: requiredNumber(entry.epoch),
            }))
          : null,
        deferredIngressCount: Array.isArray(deferred) ? deferred.length : null,
        deferredIngress: Array.isArray(deferred)
          ? fixtureRows(deferred).map((entry) => ({
              id: String(entry.id),
              priority: requiredNumber(entry.priority),
              epoch: requiredNumber(entry.epoch),
            }))
          : null,
        currentEpoch: epoch,
        lastWorkerReceiptSequence: finite(owner.lastWorkerReceiptSequence),
        nextBatchSequence: finite(owner.nextBatchSequence),
        pendingBatchSequence: finite(owner.pendingBatchSequence),
        sentMessagesSize: sent instanceof Map ? sent.size : null,
        projectedWork,
      };
    });
    return {
      installed: true,
      probeError,
      ownerCaptured: owner !== null,
      workerHooked: hookedWorker !== null,
      atEpochMs: epochNow(),
      manager,
      events: events.slice(),
      omittedEvents,
    };
  };
  if (target.__ytMatrixManagerProbe !== undefined) {
    fail('manager-probe-already-installed');
    return;
  }
  target.__ytMatrixManagerProbe = { read };
  if (typeof nativeSend !== 'function' || typeof nativeReceipt !== 'function') {
    fail('manager-prototype-shape');
    return;
  }
  prototype.sendToWorker = function (this: unknown, ...args: unknown[]) {
    observe('manager-send-before', () => {
      captureOwner(this);
      if (owner) hookWorker(owner);
      const id = typeof args[1] === 'string' ? args[1] : asRecord(args[0])?.id;
      if (typeof id === 'string' && knownIds.has(id)) record({ kind: 'manager-send-before', id });
    });
    try {
      const result = Reflect.apply(nativeSend, this, args);
      observe('manager-send-after', () => {
        const id = typeof args[1] === 'string' ? args[1] : asRecord(args[0])?.id;
        if (typeof id === 'string' && knownIds.has(id))
          record({ kind: 'manager-send-after', id, accepted: result === true });
      });
      return result;
    } catch (error) {
      observe('manager-send-after', () => record({ kind: 'manager-send-threw' }));
      throw error;
    }
  };
  prototype.applyBatchReceipt = function (this: unknown, ...args: unknown[]) {
    observe('manager-receipt-before', () => {
      captureOwner(this);
      if (owner) hookWorker(owner);
      const receipt = asRecord(args[0]);
      record({
        kind: 'manager-receipt-before',
        batchSequence: finite(receipt?.batchSequence),
        epoch: finite(receipt?.epoch),
        pendingQueueDepth: finite(receipt?.pendingQueueDepth),
        minimumPendingPriority: finite(receipt?.minimumPendingPriority),
      });
    });
    try {
      const result = Reflect.apply(nativeReceipt, this, args);
      observe('manager-receipt-after', () => {
        const receipt = asRecord(args[0]);
        record({
          kind: 'manager-receipt-after',
          batchSequence: finite(receipt?.batchSequence),
          epoch: finite(receipt?.epoch),
          pendingQueueDepth: finite(receipt?.pendingQueueDepth),
          minimumPendingPriority: finite(receipt?.minimumPendingPriority),
        });
      });
      return result;
    } catch (error) {
      observe('manager-receipt-after', () => record({ kind: 'manager-receipt-threw' }));
      throw error;
    }
  };
}

export function instrumentWorkerManagerPageScript(source: string, mode: MatrixMode): string | null {
  const marker = '\n\tmain();\n';
  if (
    source.split(marker).length !== 2 ||
    !source.includes('var RenderWorkerManager = class RenderWorkerManager {') ||
    !source.includes('sendToWorker(message, msgId, trackDrops = true) {') ||
    !source.includes('applyBatchReceipt(receipt) {') ||
    source.includes('__ytMatrixManagerProbe')
  )
    return null;
  return source.replace(
    marker,
    `\n\t;(${attachWorkerManagerProbe.toString()})(RenderWorkerManager, globalThis, ${JSON.stringify(OVERLOAD_IDS.filter((id) => id.includes('_OVERFLOW_')))}, ${mode === 'candidate'});` +
      marker
  );
}

export function validateMatrixMode(value: unknown): asserts value is MatrixMode {
  assert(value === 'baseline' || value === 'candidate', 'Matrix mode must be explicit');
}

export function classifyPlanProbeCapability(mode: MatrixMode, pageScript: string) {
  if (instrumentCardPlanCalls(pageScript)) return 'instrumented' as const;
  if (
    mode === 'baseline' &&
    instrumentCanvasPageScript(pageScript) !== null &&
    !pageScript.includes('preparePaidCardPlan') &&
    !pageScript.includes('superChatLayout')
  )
    return 'unsupported-legacy-planless' as const;
  return 'invalid' as const;
}

/** Source SHA remains provenance; both observed backends decide runtime capability. */
export function classifyMatrixRuntime(
  mode: MatrixMode,
  sourceSha: string,
  cases: readonly {
    backend: Backend;
    status: 'passed' | 'failed';
    layoutSupport: 'stacked-and-wide' | 'legacy-stacked-only' | 'unavailable';
  }[]
) {
  assert(/^[a-f0-9]{40}$/u.test(sourceSha), 'Runtime classification needs bound source identity');
  const supports = (layout: 'stacked-and-wide' | 'legacy-stacked-only') =>
    cases.length === 2 &&
    (['worker', 'main'] as const).every((backend) =>
      cases.some(
        (entry) =>
          entry.backend === backend && entry.status === 'passed' && entry.layoutSupport === layout
      )
    );
  const kind = supports('stacked-and-wide')
    ? mode === 'baseline'
      ? 'wide-capable-baseline'
      : 'wide-capable-candidate'
    : mode === 'baseline' && supports('legacy-stacked-only')
      ? 'legacy-stacked-baseline'
      : 'invalid-capability';
  return {
    kind,
    sourceSha,
    runtimeCapability:
      kind === 'legacy-stacked-baseline'
        ? 'legacy-stacked-only'
        : kind === 'invalid-capability'
          ? 'unavailable-or-mixed'
          : 'stacked-and-wide',
  } as const;
}

export function bindMatrixIdentity(
  bundle: unknown,
  profileSha256: string,
  pageScriptSha256: string,
  fixtureSha256: Record<string, string>
) {
  assert(bundle && typeof bundle === 'object', 'Controller bundle identity is unavailable');
  const record = bundle as Record<string, unknown>;
  assert.equal(record.profile, 'yt-visual');
  assert.equal(record.installation, 'extension');
  assert(/^[a-f0-9]{40}$/u.test(String(record.source_sha)), 'Invalid source commit identity');
  assert(/^[a-f0-9]{40}$/u.test(String(record.core_sha)), 'Invalid core commit identity');
  assert(/^[a-f0-9]{64}$/u.test(String(record.build_log_sha256)), 'Invalid build log identity');
  const files = record.files;
  assert(Array.isArray(files), 'Controller bundle file identities are unavailable');
  const fileDigest = (path: string) => {
    const matches = files.filter(
      (file: unknown) =>
        file && typeof file === 'object' && (file as Record<string, unknown>).file === path
    );
    assert.equal(matches.length, 1, `Controller bundle requires one ${path}`);
    return (matches[0] as Record<string, unknown>).sha256;
  };
  assert.equal(fileDigest('validation/windows/profile.json'), profileSha256);
  assert.equal(fileDigest('dist-extension/page-script.js'), pageScriptSha256);
  for (const [path, digest] of Object.entries(fixtureSha256)) {
    assert(/^[a-f0-9]{64}$/u.test(digest), `Invalid fixture digest for ${path}`);
    assert.equal(fileDigest(path), digest);
  }
  return {
    sourceSha: record.source_sha as string,
    coreSha: record.core_sha as string,
    buildLogSha256: record.build_log_sha256 as string,
    profileId: 'yt-visual',
    profileSha256,
    pageScriptSha256,
    fixtureSha256,
    installation: 'extension',
    browser: record.browser,
  };
}

export function assertRestoredVisibility(
  snapshot: MatrixSnapshot,
  deferredId: string,
  newId: string
) {
  assertCoherentVisibleFrame(snapshot, deferredId);
  assertCoherentVisibleFrame(snapshot, newId);
}

export function assertCoherentVisibleFrame(snapshot: MatrixSnapshot, id: string): MatrixDraw {
  const frame = snapshot.frame;
  assert(
    frame?.complete && frame.cleared && !frame.truncated,
    'Complete overlay frame is required'
  );
  assert(snapshot.overlay, 'Overlay viewport is unavailable');
  assert(Math.abs(Number(frame.logicalWidth) - snapshot.overlay.width) <= 1);
  assert(Math.abs(Number(frame.logicalHeight) - snapshot.overlay.height) <= 1);
  assert(Number.isFinite(frame.backingRatioX) && frame.backingRatioX > 0);
  assert(Number.isFinite(frame.backingRatioY) && frame.backingRatioY > 0);
  assert(Number.isFinite(frame.logicalWidth) && Number.isFinite(frame.logicalHeight));
  const draw = frame.draws.find(
    (entry) =>
      entry.id === id &&
      entry.alpha > 0 &&
      entry.rect &&
      entry.rect.left < Number(frame.logicalWidth) &&
      entry.rect.right > 0 &&
      entry.rect.top < Number(frame.logicalHeight) &&
      entry.rect.bottom > 0
  );
  assert(draw, `${id} lacks a positive-alpha viewport draw in a complete frame`);
  assert(Number.isFinite(snapshot.firstEntry[id]), `${id} lacks a first-visible timestamp`);
  return draw;
}

export function assertCommittedVisibleItem(snapshot: MatrixSnapshot, id: string) {
  const draw = assertCoherentVisibleFrame(snapshot, id);
  const row = snapshot.activeNow.find((entry) => entry.id === id);
  assert(row && draw.rect && snapshot.frame, `${id} lacks committed bounds or ink`);
  const width = Number(snapshot.frame.logicalWidth);
  const height = Number(snapshot.frame.logicalHeight);
  assert(
    row.width > 0 &&
      row.height > 0 &&
      row.x < width &&
      row.x + row.width > 0 &&
      row.y < height &&
      row.y + row.height > 0,
    `${id} has no committed viewport overlap`
  );
  assert(
    draw.rect.left >= row.x - 2 &&
      draw.rect.right <= row.x + row.width + 2 &&
      draw.rect.top >= row.y - 2 &&
      draw.rect.bottom <= row.y + row.height + 2,
    `${id} ink exceeds its committed card bounds`
  );
  return { draw, row, frameId: snapshot.frame.frameId };
}

/** Keep an already painted moving row inside the viewport after a narrower reflow. */
export function assertResizeSafeMotion(
  snapshot: MatrixSnapshot,
  id: string
): ReturnType<typeof assertCommittedVisibleItem> {
  const proof = assertCommittedVisibleItem(snapshot, id);
  assert(snapshot.frame?.active.some((entry) => entry.id === id));
  assert(
    proof.row.x >= 0 && proof.row.x < Number(snapshot.frame?.logicalWidth) / 2,
    `${id} has not reached the resize-safe viewport half`
  );
  return proof;
}

export function assertBackend(
  snapshot: MatrixSnapshot,
  backend: Backend,
  phase: 'before-input' | 'after-input' = 'after-input'
): void {
  assert.equal(snapshot.backend, backend);
  if (backend === 'worker') {
    assert(snapshot.workerReady && snapshot.sourcePrefixed && snapshot.sourceHooked);
    if (phase === 'before-input') {
      assert(snapshot.frame?.complete && snapshot.frame.cleared && !snapshot.frame.truncated);
      assert(snapshot.activeNow.length === 0 && Object.keys(snapshot.ingress).length === 0);
    } else assert(snapshot.drains.length > 0, 'Exact packaged Worker drain is required');
  } else {
    assert(!snapshot.workerReady && snapshot.canvasSourceHooked);
  }
}

export async function snapshot(
  page: Page,
  backend: Backend,
  maxRecords = MAX_RECORDS,
  dueFrame?: { id: string; layout: 'stacked' | 'wide' }
): Promise<MatrixSnapshot> {
  if (backend === 'worker') {
    const requestId = await page.evaluate(() => {
      const probe = window.__ytPlacementProbe;
      const id = (probe.flushSequence ?? 0) + 1;
      probe.flushSequence = id;
      for (const record of probe.workers)
        record.worker.postMessage({ type: 'ytPlacementFlush', requestId: id });
      return id;
    });
    await page.waitForFunction(
      (id) =>
        window.__ytPlacementProbe?.workers.some((record) => record.ready && record.flushId === id),
      requestId,
      { timeout: 5000 }
    );
  }
  const observed = await page.evaluate(
    ({ selectedBackend, recordLimit, frameDrawLimit, requestedFrame }) => {
      const probe = window.__ytPlacementProbe;
      const worker = probe.workers.find((record) => record.ready);
      const selected = selectedBackend === 'worker' ? worker?.sample : probe;
      const exact = selected?.exact;
      const frame = requestedFrame
        ? selected?.firstCompleteFrames?.[`${requestedFrame.id}|${requestedFrame.layout}`]
        : selected?.latestRenderFrame;
      const active = frame?.active.filter((entry) => entry.id.startsWith('WINDOWS380_')) ?? [];
      const draws = frame?.draws.filter((entry) => entry.id.startsWith('WINDOWS380_')) ?? [];
      const cardPlans =
        frame?.cardPlans?.filter((entry) => entry.id.startsWith('WINDOWS380_')) ?? [];
      const overlay = document
        .querySelector<HTMLCanvasElement>('#yt-live-chat-overlay canvas')
        ?.getBoundingClientRect();
      const accessibility: Record<string, string> = {};
      for (const element of document.querySelectorAll<HTMLElement>(
        '.yt-live-chat-overlay-live-region > p'
      )) {
        const id = element.dataset.messageId;
        if (id?.startsWith('WINDOWS380_') && Object.keys(accessibility).length < 16) {
          accessibility[id] = (element.textContent ?? '').slice(0, 512);
        }
      }
      return {
        backend: selectedBackend,
        sourcePrefixed: probe.sourcePrefixed,
        sourceHooked: probe.sourceHooked,
        canvasSourceHooked: probe.canvasSourceHooked === true,
        workerReady: Boolean(worker),
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        overlay: overlay
          ? { width: overlay.width, height: overlay.height, left: overlay.left, top: overlay.top }
          : null,
        frame: frame
          ? {
              frameId: frame.frameId,
              startedAtEpochMs: frame.startedAtEpochMs,
              complete: frame.complete,
              cleared: frame.cleared,
              truncated:
                frame.truncated ||
                active.length > recordLimit ||
                draws.length > frameDrawLimit ||
                cardPlans.length > 24,
              logicalWidth: frame.logicalWidth,
              logicalHeight: frame.logicalHeight,
              backingRatioX: frame.backingRatioX,
              backingRatioY: frame.backingRatioY,
              active: active.slice(0, recordLimit),
              draws: draws.slice(0, frameDrawLimit),
              cardPlans: cardPlans.slice(0, 24),
              config: {
                reducedMotion: frame.config?.reducedMotion ?? null,
                ignoreReducedMotion: frame.config?.ignoreReducedMotion ?? null,
              },
            }
          : null,
        layout:
          typeof exact?.config?.superChatLayout === 'string' ? exact.config.superChatLayout : null,
        firstEntry: selected?.firstEntry ?? {},
        ingress: selected?.ingress ?? {},
        dispositions:
          exact?.dispositions?.slice(-recordLimit).map((entry) => ({
            id: entry.id,
            kind: entry.kind,
            reason: typeof entry.reason === 'string' ? entry.reason : null,
            atEpochMs: typeof entry.atEpochMs === 'number' ? entry.atEpochMs : null,
            queueResidenceMs:
              typeof entry.queueResidenceMs === 'number' ? entry.queueResidenceMs : null,
            isBacklog: typeof entry.isBacklog === 'boolean' ? entry.isBacklog : null,
          })) ?? [],
        pendingNow: exact?.pendingNow?.slice(0, recordLimit) ?? [],
        queuedNow: exact?.queuedNow?.slice(0, recordLimit) ?? [],
        retained: exact?.retained ?? null,
        activeNow: requestedFrame
          ? (frame?.active.slice(0, recordLimit) ?? [])
          : (exact?.activeNow?.slice(0, recordLimit) ?? []),
        frames:
          (selectedBackend === 'worker' && exact?.frames?.length
            ? exact.frames
            : selected?.frames
          )?.slice(-recordLimit) ?? [],
        drains:
          exact?.drains?.slice(-recordLimit).map((entry) => ({
            workMs: entry.workMs,
            pendingBefore: typeof entry.pendingBefore === 'number' ? entry.pendingBefore : null,
          })) ?? [],
        ink:
          selected?.ink
            ?.filter((entry) => typeof entry.id === 'string' && entry.id.startsWith('WINDOWS380_'))
            .slice(0, recordLimit)
            .map((entry) => ({
              id: String(entry.id),
              left: Number(entry.left),
              top: Number(entry.top),
              right: Number(entry.right),
              bottom: Number(entry.bottom),
              kind: typeof entry.kind === 'string' ? entry.kind : null,
            })) ?? [],
        stats:
          worker?.stats.slice(-16).map((entry) => ({
            totalRendered: typeof entry.totalRendered === 'number' ? entry.totalRendered : null,
            totalPresented: typeof entry.totalPresented === 'number' ? entry.totalPresented : null,
            pendingQueueDepth:
              typeof entry.pendingQueueDepth === 'number' ? entry.pendingQueueDepth : null,
          })) ?? [],
        accessibility,
        fixtureText: exact?.fixtureText ?? {},
        measuredPlans: selected?.measuredPlans ?? {},
        presentationCount: exact?.presentationCount ?? null,
        totalPresentationUnknown:
          typeof exact?.totalPresentationUnknown === 'number'
            ? exact.totalPresentationUnknown
            : null,
        presentationCounterAvailable: typeof exact?.presentationCount === 'number',
        overflow: (selected?.overflow ?? 0) + (exact?.overflow ?? 0),
      };
    },
    {
      selectedBackend: backend,
      recordLimit: maxRecords,
      frameDrawLimit: MAX_FRAME_DRAWS,
      requestedFrame: dueFrame,
    }
  );
  return observed as MatrixSnapshot;
}

export function presentationGeometry(snapshot: MatrixSnapshot, id: string) {
  const { draw, row } = assertCommittedVisibleItem(snapshot, id);
  const width = Number(snapshot.frame?.logicalWidth);
  const left = Math.max(0, row.x);
  const right = Math.min(width, row.x + row.width);
  const visibleWidth = Math.max(0, right - left);
  const speed = row.actualVelocityPxPerMs;
  const disposition = snapshot.dispositions.findLast((entry) => entry.id === id);
  return {
    width: row.width,
    height: row.height,
    x: row.x,
    y: row.y,
    visibleFraction: row.width > 0 ? visibleWidth / row.width : null,
    partialVisibility: visibleWidth > 0 && visibleWidth < row.width,
    actualSpeedPxPerSec: typeof speed === 'number' ? speed * 1000 : null,
    fullCardExposureMs:
      typeof speed === 'number' && speed > 0 ? Math.max(0, width - row.width) / speed : null,
    queueResidenceMs: disposition?.queueResidenceMs ?? null,
    firstVisibleAtEpochMs: snapshot.firstEntry[id] ?? null,
    drawAlpha: draw.alpha,
  };
}

export function presentationItem(
  snapshot: MatrixSnapshot,
  id: string,
  role: 'sticker' | 'membership' | 'ordinary'
) {
  const proof = assertCommittedVisibleItem(snapshot, id);
  if (role === 'sticker')
    assert(
      proof.draw.kind === 'sticker-image' || proof.draw.section === 'body',
      'Sticker lacks source-bound image ink or its visible fallback'
    );
  if (role === 'ordinary')
    assert(proof.draw.section === 'regular', 'Ordinary ink lacks its active source row');
  return {
    id,
    role,
    frameId: proof.frameId,
    alpha: proof.draw.alpha,
    kind: proof.draw.kind ?? null,
    ink: proof.draw.rect,
    firstVisibleAtEpochMs: snapshot.firstEntry[id] ?? null,
    card: { x: proof.row.x, y: proof.row.y, width: proof.row.width, height: proof.row.height },
  };
}

/** The measured production plan and the same complete frame must agree on reserved ink. */
export function paidRowBudget(snapshot: MatrixSnapshot, id: string, expectedLines: number) {
  const frame = snapshot.frame;
  assert(frame?.complete && frame.cleared && !frame.truncated);
  const plans = frame.cardPlans.filter((entry) => entry.id === id);
  const plan = plans.at(-1);
  assert(plan, `${id} needs a measured paid plan in its completed frame`);
  assert.equal(plan.maxBodyLines, expectedLines);
  assert(plan.bodyRows > 0, 'Canonical paid body lost all rows');
  assert(
    plan.bodyRows + plan.translationRows <= expectedLines,
    'Paid body exceeded total row budget'
  );
  assert(plan.bodyY !== null && plan.bodyY + plan.bodyHeight <= plan.height + 1);
  if (expectedLines === 1) {
    assert.equal(
      plan.translationRows,
      0,
      'One-line canonical fallback must have no translation row'
    );
  } else {
    assert(plan.translationRows > 0, 'Selected translation received no reserved row');
    assert(
      plan.translationY !== null && plan.translationY + plan.translationHeight <= plan.height + 1
    );
    assert(plan.translationY >= plan.bodyY + plan.bodyHeight);
  }
  const row = snapshot.activeNow.find((entry) => entry.id === id);
  assert(row, `${id} lacks committed card geometry`);
  assert(plan.height <= row.height + 2, 'Measured plan exceeds committed card height');
  const visibleInk = (entry: MatrixDraw) =>
    entry.rect &&
    entry.rect.left < Number(frame.logicalWidth) &&
    entry.rect.right > 0 &&
    entry.rect.top < Number(frame.logicalHeight) &&
    entry.rect.bottom > 0;
  const originalDraws = frame.draws.filter(
    (entry) => entry.id === id && entry.section === 'body' && entry.alpha > 0
  );
  const translatedDraws = frame.draws.filter(
    (entry) => entry.id === id && entry.section === 'translation' && entry.alpha > 0
  );
  const original = originalDraws.find(visibleInk);
  assert(original?.rect, 'Canonical body lacks positive-alpha ink in the completed frame');
  const translated = translatedDraws.find(visibleInk);
  if (expectedLines > 1) assert(translated?.rect, 'Translated body lacks positive-alpha ink');
  else
    assert(
      !frame.draws.some((entry) => entry.id === id && entry.section === 'translation'),
      'One-line fallback unexpectedly drew translated ink'
    );
  for (const draw of [...originalDraws, ...translatedDraws]) {
    assert(
      draw.rect &&
        draw.rect.left >= row.x - 2 &&
        draw.rect.right <= row.x + row.width + 2 &&
        draw.rect.top >= row.y - 2 &&
        draw.rect.bottom <= row.y + row.height + 2,
      'Paid body ink exceeds committed card bounds'
    );
  }
  return {
    plan,
    planInvocationsInFrame: plans.length,
    activeHeight: row.height,
    originalInk: original.rect,
    translationInk: translated?.rect ?? null,
    oneLineFallback: expectedLines === 1,
    frameId: frame.frameId,
  };
}

export function membershipEffect(snapshot: MatrixSnapshot, id: string) {
  const draw = assertCoherentVisibleFrame(snapshot, id);
  const frame = snapshot.frame;
  assert(frame);
  const plan = frame.cardPlans.findLast(
    (entry) => entry.id === id && entry.kind === 'membership' && entry.borderAlpha !== null
  );
  assert(plan, `${id} lacks a source-measured membership plan`);
  assert(plan.borderStyle?.startsWith('rgba('), 'Membership border stroke was not observed');
  assert(plan.borderAlpha !== null && plan.borderAlpha > 0 && plan.borderAlpha <= 1);
  const body = frame.draws.find(
    (entry) => entry.id === id && entry.alpha > 0 && entry.section === 'body'
  );
  assert(body?.rect, 'Membership body ink was not observed');
  assert(
    frame.config.reducedMotion === true && frame.config.ignoreReducedMotion === false,
    'Effective reduced motion was not active in the source frame'
  );
  return {
    frameId: frame.frameId,
    logicalAtEpochMs: frame.startedAtEpochMs,
    borderAlpha: plan.borderAlpha,
    borderStyle: plan.borderStyle,
    bodyAlpha: body.alpha,
    bodyRect: body.rect,
    visibleDrawAlpha: draw.alpha,
  };
}

export function assertNoVisibleCardInk(snapshot: MatrixSnapshot, id: string) {
  const frame = snapshot.frame;
  assert(frame?.complete && frame.cleared && !frame.truncated);
  assert(
    !frame.cardPlans.some((entry) => entry.id === id && entry.borderAlpha !== null),
    'Ineligible card generated a visible decoration stroke'
  );
  assert(
    !frame.draws.some((entry) => entry.id === id && entry.alpha > 0),
    'Ineligible card published visible ink'
  );
  assert(!Number.isFinite(snapshot.firstEntry[id]), 'Ineligible card entered the visible viewport');
}

/** Activation is a reservation; only the draw probe can establish first visibility. */
export function flowTrace(snapshot: MatrixSnapshot) {
  const sourceIds = Object.keys(snapshot.ingress).filter((id) => id.startsWith('WINDOWS380_'));
  const records = sourceIds.slice(0, MAX_RECORDS).map((id) => {
    const events = snapshot.dispositions.filter((entry) => entry.id === id);
    const reserved = events.find((entry) => entry.kind === 'activated');
    const completed = events.find((entry) => entry.kind === 'completed');
    const discarded = events.find((entry) => entry.kind === 'dropped');
    const receivedAtEpochMs = snapshot.ingress[id] ?? null;
    const firstVisibleAtEpochMs = snapshot.firstEntry[id] ?? null;
    return {
      id,
      kind:
        id.includes('_PAID') || id.includes('_STICKER')
          ? 'paid'
          : id.includes('_MEMBERSHIP')
            ? 'membership'
            : 'ordinary',
      receivedAtEpochMs,
      queuedAtEpochMs:
        reserved?.atEpochMs !== null &&
        reserved?.atEpochMs !== undefined &&
        reserved.queueResidenceMs !== null
          ? reserved.atEpochMs - reserved.queueResidenceMs
          : null,
      reservedAtEpochMs: reserved?.atEpochMs ?? null,
      firstVisibleAtEpochMs,
      firstVisibleDelayMs:
        receivedAtEpochMs !== null && firstVisibleAtEpochMs !== null
          ? firstVisibleAtEpochMs - receivedAtEpochMs
          : null,
      completedAtEpochMs: completed?.atEpochMs ?? null,
      discardReason: discarded?.reason ?? null,
    };
  });
  return {
    records,
    truncated:
      sourceIds.length > MAX_RECORDS ||
      snapshot.dispositions.length >= MAX_RECORDS ||
      snapshot.overflow > 0,
    totalPresentationUnknown: snapshot.totalPresentationUnknown,
    presentationCounterAvailable: snapshot.presentationCounterAvailable,
    frameWorkMs: snapshot.frames.map((frame) => frame.workMs),
    drainWorkMs: snapshot.drains.map((drain) => drain.workMs),
    pendingDepth: snapshot.stats.at(-1)?.pendingQueueDepth ?? null,
    activeFixtureRows: snapshot.activeNow.length,
  };
}

function sampleSummary(samples: number[]) {
  const sorted = samples
    .filter((value) => Number.isFinite(value) && value >= 0)
    .toSorted((a, b) => a - b);
  return {
    count: sorted.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
    max: sorted.at(-1) ?? null,
  };
}

/** Source delivery, renderer admission, reservation, and actual draw remain separate. */
export function overloadTrace(
  snapshot: MatrixSnapshot,
  ids: readonly string[],
  caps: {
    active: number;
    queue: number;
  },
  deliveredIds: ReadonlySet<string>
) {
  const records = ids.map((id) => {
    const events = snapshot.dispositions.filter((entry) => entry.id === id);
    const reserved = events.find((entry) => entry.kind === 'activated');
    const completed = events.find((entry) => entry.kind === 'completed');
    const discarded = events.find((entry) => entry.kind === 'dropped');
    const queued = snapshot.queuedNow.find((entry) => entry.id === id);
    const active = snapshot.activeNow.find((entry) => entry.id === id);
    const ingressAt = snapshot.ingress[id] ?? null;
    const firstVisibleAt = snapshot.firstEntry[id] ?? null;
    return {
      id,
      kind: id.includes('_PAID') ? 'paid' : id.includes('_MEMBERSHIP') ? 'membership' : 'ordinary',
      delivered: deliveredIds.has(id),
      rendererIngressAtEpochMs: ingressAt,
      pendingNow: snapshot.pendingNow.includes(id),
      queuedAtEpochMs:
        queued?.atEpochMs ??
        (reserved?.atEpochMs !== null &&
        reserved?.atEpochMs !== undefined &&
        reserved.queueResidenceMs !== null
          ? reserved.atEpochMs - reserved.queueResidenceMs
          : null),
      reservedAtEpochMs: reserved?.atEpochMs ?? null,
      plannedStartAtEpochMs: active?.startAtEpochMs ?? null,
      plannedEndAtEpochMs: active?.endAtEpochMs ?? null,
      firstVisibleAtEpochMs: firstVisibleAt,
      firstVisibleDelayMs:
        ingressAt !== null && firstVisibleAt !== null ? firstVisibleAt - ingressAt : null,
      queueResidenceMs:
        reserved?.queueResidenceMs ??
        discarded?.queueResidenceMs ??
        (queued ? Math.max(0, (snapshot.frame?.startedAtEpochMs ?? 0) - queued.atEpochMs) : null),
      completedAtEpochMs: completed?.atEpochMs ?? null,
      discardReason: discarded?.reason ?? null,
    };
  });
  const byKind = Object.fromEntries(
    ['paid', 'ordinary', 'membership'].map((kind) => {
      const group = records.filter((entry) => entry.kind === kind);
      return [
        kind,
        {
          delivered: group.filter((entry) => entry.delivered).length,
          rendererIngress: group.filter((entry) => entry.rendererIngressAtEpochMs !== null).length,
          queuedNow: group.filter((entry) => entry.pendingNow).length,
          reserved: group.filter((entry) => entry.reservedAtEpochMs !== null).length,
          firstVisible: group.filter((entry) => entry.firstVisibleAtEpochMs !== null).length,
          completed: group.filter((entry) => entry.completedAtEpochMs !== null).length,
          discarded: group.filter((entry) => entry.discardReason !== null).length,
          firstVisibleDelayMs: sampleSummary(
            group.flatMap((entry) =>
              entry.firstVisibleDelayMs === null ? [] : [entry.firstVisibleDelayMs]
            )
          ),
          queueResidenceMs: sampleSummary(
            group.flatMap((entry) =>
              entry.queueResidenceMs === null ? [] : [entry.queueResidenceMs]
            )
          ),
        },
      ];
    })
  );
  return {
    records,
    byKind,
    occupancy: {
      active: snapshot.retained?.active ?? snapshot.activeNow.length,
      activeCap: caps.active,
      pending: snapshot.retained?.pending ?? snapshot.pendingNow.length,
      queueCap: caps.queue,
      activeFixtureRows: snapshot.activeNow.length,
    },
    retained: snapshot.retained,
    measuredPlans: Object.fromEntries(
      ids.filter((id) => snapshot.measuredPlans[id]).map((id) => [id, snapshot.measuredPlans[id]])
    ),
    frameWorkMs: sampleSummary(snapshot.frames.map((entry) => entry.workMs)),
    drainWorkMs: sampleSummary(snapshot.drains.map((entry) => entry.workMs)),
    probeOverflow: snapshot.overflow,
    sampledFrameId: snapshot.frame?.frameId ?? null,
  };
}

async function waitForVisible(
  page: Page,
  backend: Backend,
  id: string,
  layout?: 'stacked' | 'wide'
) {
  await page.waitForFunction(
    ({ selectedBackend, messageId, requestedLayout }) => {
      const probe = window.__ytPlacementProbe;
      const worker = probe?.workers.find((record) => record.ready);
      const selected = selectedBackend === 'worker' ? worker?.sample : probe;
      const frame = requestedLayout
        ? selected?.firstCompleteFrames?.[`${messageId}|${requestedLayout}`]
        : selected?.latestRenderFrame;
      const visible = Boolean(
        frame?.complete &&
        frame.cleared &&
        !frame.truncated &&
        frame.active.some((row) => row.id === messageId) &&
        Number.isFinite(frame.logicalWidth) &&
        Number.isFinite(frame.logicalHeight) &&
        frame.draws.some(
          (draw) =>
            draw.id === messageId &&
            draw.alpha > 0 &&
            draw.rect &&
            draw.rect.left < Number(frame.logicalWidth) &&
            draw.rect.right > 0 &&
            draw.rect.top < Number(frame.logicalHeight) &&
            draw.rect.bottom > 0
        )
      );
      if (!visible && selectedBackend === 'worker' && worker && probe) {
        const now = performance.now();
        if (now - (worker.dueFlushAt ?? -Infinity) >= 100) {
          const requestId = (probe.flushSequence ?? 0) + 1;
          probe.flushSequence = requestId;
          worker.dueFlushAt = now;
          worker.worker.postMessage({ type: 'ytPlacementFlush', requestId });
        }
      }
      return visible;
    },
    { selectedBackend: backend, messageId: id, requestedLayout: layout },
    { polling: 100, timeout: 5000 }
  );
}

async function waitForTranslationDraw(page: Page, backend: Backend, id: string) {
  await page.waitForFunction(
    ({ selectedBackend, messageId }) => {
      const probe = window.__ytPlacementProbe;
      const selected =
        selectedBackend === 'worker'
          ? probe?.workers.find((record) => record.ready)?.sample
          : probe;
      const frame = selected?.latestRenderFrame;
      return Boolean(
        frame?.complete &&
        !frame.truncated &&
        frame.draws.some(
          (draw) =>
            draw.id === messageId &&
            draw.alpha > 0 &&
            draw.section === 'translation' &&
            draw.rect &&
            draw.rect.left < Number(frame.logicalWidth) &&
            draw.rect.right > 0 &&
            draw.rect.top < Number(frame.logicalHeight) &&
            draw.rect.bottom > 0
        )
      );
    },
    { selectedBackend: backend, messageId: id },
    { timeout: 5000 }
  );
}

async function waitForAccessibleTails(page: Page, ids: readonly string[]) {
  await page.waitForFunction(
    (expected) =>
      expected.every((id) => {
        const entry = [
          ...document.querySelectorAll<HTMLElement>('.yt-live-chat-overlay-live-region > p'),
        ].find((element) => element.dataset.messageId === id);
        return entry?.textContent?.includes('CANONICAL_END') === true;
      }),
    ids,
    { timeout: 5000 }
  );
}

async function waitForPaidPlan(page: Page, backend: Backend, id: string, lines: number) {
  await page.waitForFunction(
    ({ selectedBackend, messageId, expectedLines }) => {
      const probe = window.__ytPlacementProbe;
      const sample =
        selectedBackend === 'worker'
          ? probe?.workers.find((record) => record.ready)?.sample
          : probe;
      const frame = sample?.latestRenderFrame;
      const plan = frame?.cardPlans?.findLast(
        (entry) => entry.id === messageId && entry.maxBodyLines === expectedLines
      );
      const row = frame?.active.find((entry) => entry.id === messageId);
      return Boolean(
        frame?.complete &&
        frame.cleared &&
        !frame.truncated &&
        plan &&
        row &&
        plan.height <= row.height + 2 &&
        frame.draws.some((draw) => draw.id === messageId && draw.alpha > 0)
      );
    },
    { selectedBackend: backend, messageId: id, expectedLines: lines },
    { timeout: 5000 }
  );
}

async function waitForProbeConfig(
  page: Page,
  backend: Backend,
  expected: {
    viewportWidth: number;
    playerHeight?: number;
    fontSize?: number;
    safeTop?: number;
    safeBottom?: number;
    laneSpacing?: number;
    mode?: 'top' | 'scroll';
    reducedMotion?: boolean;
    ignoreReducedMotion?: boolean;
    layout?: 'stacked' | 'wide';
    activeCap?: number;
    queueCap?: number;
  }
) {
  await page.waitForFunction(
    ({ selectedBackend, config }) => {
      const probe = window.__ytPlacementProbe;
      const worker = probe?.workers.find((record) => record.ready);
      const selected = selectedBackend === 'worker' ? worker?.sample : probe;
      const frame = selected?.latestRenderFrame;
      const exact = selected?.exact?.config;
      const player = document.querySelector('#movie_player')?.getBoundingClientRect();
      const matches = Boolean(
        frame?.complete &&
        player &&
        innerWidth === config.viewportWidth &&
        Math.abs(Number(frame.logicalWidth) - player.width) <= 2 &&
        Math.abs(Number(frame.logicalHeight) - player.height) <= 2 &&
        (config.playerHeight === undefined || player.height === config.playerHeight) &&
        (config.fontSize === undefined || exact?.fontSize === config.fontSize) &&
        (config.safeTop === undefined || exact?.safeTop === config.safeTop) &&
        (config.safeBottom === undefined || exact?.safeBottom === config.safeBottom) &&
        (config.laneSpacing === undefined || exact?.laneSpacing === config.laneSpacing) &&
        (config.mode === undefined || exact?.mode === config.mode) &&
        (config.layout === undefined || exact?.superChatLayout === config.layout) &&
        (config.activeCap === undefined || exact?.maxConcurrentMessages === config.activeCap) &&
        (config.queueCap === undefined || exact?.queueMaxSize === config.queueCap) &&
        (config.reducedMotion === undefined ||
          (exact?.reducedMotion === config.reducedMotion &&
            frame.config.reducedMotion === config.reducedMotion)) &&
        (config.ignoreReducedMotion === undefined ||
          (exact?.ignoreReducedMotion === config.ignoreReducedMotion &&
            frame.config.ignoreReducedMotion === config.ignoreReducedMotion))
      );
      if (!matches && selectedBackend === 'worker' && worker && probe) {
        const now = performance.now();
        if (now - (worker.dueFlushAt ?? -Infinity) >= 100) {
          const requestId = (probe.flushSequence ?? 0) + 1;
          probe.flushSequence = requestId;
          worker.dueFlushAt = now;
          worker.worker.postMessage({ type: 'ytPlacementFlush', requestId });
        }
      }
      return matches;
    },
    { selectedBackend: backend, config: expected },
    { polling: 100, timeout: 5000 }
  );
}

async function waitForIngress(page: Page, backend: Backend, id: string) {
  await page.waitForFunction(
    ({ selectedBackend, messageId }) => {
      const probe = window.__ytPlacementProbe;
      const selected =
        selectedBackend === 'worker'
          ? probe?.workers.find((record) => record.ready)?.sample
          : probe;
      return Number.isFinite(selected?.ingress?.[messageId]);
    },
    { selectedBackend: backend, messageId: id },
    { timeout: 5000 }
  );
}

async function setScene(page: Page, scene: Scene) {
  await page.evaluate(async (name) => {
    const video = document.querySelector<HTMLVideoElement>('#movie_player video');
    if (!video) throw new Error('Owned matrix video is unavailable');
    video.src = `/viewing-${name}.mp4`;
    video.muted = true;
    video.loop = true;
    await video.play();
  }, scene);
  await page.waitForFunction(
    (name) => {
      const video = document.querySelector<HTMLVideoElement>('#movie_player video');
      return Boolean(
        video &&
        video.readyState >= 2 &&
        video.videoWidth > 0 &&
        video.videoHeight > 0 &&
        video.currentTime > 0.05 &&
        video.currentSrc.endsWith(`/viewing-${name}.mp4`)
      );
    },
    scene,
    { timeout: 10_000 }
  );
}

async function runBackend(options: {
  context: BrowserContext;
  root: string;
  output: string;
  extensionId: string;
  backend: Backend;
  mode: MatrixMode;
  html: string;
  media: Record<Scene, Buffer>;
}) {
  const { context, root, output, extensionId, backend, mode, html, media } = options;
  const page = await context.newPage();
  const phases: Array<{
    name: string;
    snapshot: MatrixSnapshot;
    flow: ReturnType<typeof flowTrace>;
    screenshot: string | null;
  }> = [];
  const rateObservations: Array<Record<string, unknown>> = [];
  const presentationObservations: Array<Record<string, unknown>> = [];
  const previewObservations: Array<{ layout: 'wide' | 'stacked'; samples: PreviewSample[] }> = [];
  const rowBudgetObservations: Array<Record<string, unknown>> = [];
  const effectObservations: Array<Record<string, unknown>> = [];
  const baselineFindings: string[] = [];
  const cleanupErrors: string[] = [];
  const delivered = new Set<string>();
  let screenshotCount = 0;
  let nativeProbe: NativePageScriptProbe | undefined;
  let previousSettings:
    | Parameters<NonNullable<Window['__ytChatOverlay']>['applySettings']>[0]
    | undefined;
  let deadlineExceeded = false;
  const deadline = setTimeout(() => {
    deadlineExceeded = true;
    void page.close().catch(() => {});
  }, MAX_RUN_MS);
  let result: {
    status: 'passed' | 'failed';
    backend: Backend;
    mode: MatrixMode;
    layoutSupport: 'stacked-and-wide' | 'legacy-stacked-only' | 'unavailable';
    phases: typeof phases;
    rateObservations: typeof rateObservations;
    presentationObservations: typeof presentationObservations;
    previewObservations: typeof previewObservations;
    rowBudgetObservations: typeof rowBudgetObservations;
    effectObservations: typeof effectObservations;
    baselineFindings: typeof baselineFindings;
    cleanupErrors: typeof cleanupErrors;
    delivered: string[];
    diagnostic?: MatrixSnapshot | null;
    errorType?: string;
    errorMessage?: string;
  };
  const startedAt = Date.now();
  const check = <T>(predicate: () => T): T | undefined => {
    try {
      return predicate();
    } catch (error) {
      if (mode === 'candidate') throw error;
      if (baselineFindings.length < 24) {
        baselineFindings.push(
          (error instanceof Error ? error.message : String(error)).slice(0, 240)
        );
      }
      return undefined;
    }
  };
  const observeVisible = async (id: string) => {
    try {
      await waitForVisible(page, backend, id);
    } catch (error) {
      if (mode === 'candidate') throw error;
      if (baselineFindings.length < 24)
        baselineFindings.push(`No complete visible frame for ${id}`);
    }
  };
  const observeTranslation = async (id: string) => {
    try {
      await waitForTranslationDraw(page, backend, id);
      await page.waitForFunction(
        (messageId) => {
          const entry = [
            ...document.querySelectorAll<HTMLElement>('.yt-live-chat-overlay-live-region > p'),
          ].find((element) => element.dataset.messageId === messageId);
          return Boolean(
            entry?.textContent?.includes('CANONICAL_END') &&
            entry.textContent.includes('MATRIX_TRANSLATED')
          );
        },
        id,
        { timeout: 5000 }
      );
    } catch (error) {
      if (mode === 'candidate') throw error;
      if (baselineFindings.length < 24)
        baselineFindings.push(`No complete visible translation frame for ${id}`);
    }
  };
  const observePlan = async (id: string, lines: number) => {
    try {
      await waitForPaidPlan(page, backend, id, lines);
    } catch (error) {
      if (mode === 'candidate') throw error;
      if (baselineFindings.length < 24)
        baselineFindings.push(`No measured paid plan for ${id} at ${lines} lines`);
    }
  };
  const capture = async (name: string, includeScreenshot = true) => {
    assert(phases.length < MAX_PHASES_PER_BACKEND, 'Matrix phase budget exceeded');
    const filename = includeScreenshot ? `comment-display-${backend}-${name}.png` : null;
    const observed = await snapshot(page, backend);
    if (filename) {
      assert(screenshotCount < MAX_CAPTURES_PER_BACKEND, 'Matrix capture budget exceeded');
      await page.screenshot({ path: join(output, filename), animations: 'disabled' });
      screenshotCount++;
    }
    phases.push({ name, snapshot: observed, flow: flowTrace(observed), screenshot: filename });
    return observed;
  };
  const send = async (key: keyof typeof MATRIX_BATCHES) => {
    await page.evaluate(async (batch) => {
      const response = await fetch(
        `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?windows380=${batch}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }
      );
      if (!response.ok) throw new Error('Matrix batch request failed');
      await response.json();
    }, key);
    assert(delivered.has(key), `Matrix batch ${key} was not delivered`);
  };
  const openFresh = async () => {
    if (backend === 'main') {
      const source = await readFile(join(root, 'dist-extension/page-script.js'), 'utf8');
      const instrumentedSource = instrumentCanvasPageScript(source, undefined, true);
      assert(instrumentedSource, 'Packaged Canvas page script shape changed');
      nativeProbe = await installNativePageScriptProbe({
        context,
        root,
        extensionId,
        fixtureUrl: FIXTURE_URL,
        instrumentedSource,
      });
      await nativeProbe.assertReady();
    }
    await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page
      .locator('#yt-live-chat-overlay canvas')
      .waitFor({ state: 'attached', timeout: 15_000 });
    if (nativeProbe) {
      await nativeProbe.assertInjected();
      await page.waitForFunction(() => window.__ytPlacementProbe.canvasSourceHooked === true);
      await nativeProbe.restore();
      nativeProbe = undefined;
    }
    await page.waitForFunction(() => Boolean(window.__ytChatOverlay?.getSettings));
  };
  try {
    // The six simultaneous content rows exceed the ordinary 482px player.
    // Give this phase room to publish every due draw within its fixed wait.
    await page.setViewportSize({ width: 960, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.route('**/*', async (route) => {
      const url = new globalThis.URL(route.request().url());
      if (url.protocol === 'chrome-extension:' && url.hostname === extensionId)
        return route.continue();
      if (url.hostname === 'yt3.ggpht.com' && url.pathname.startsWith('/windows380-emoji-')) {
        if (url.pathname === '/windows380-emoji-missing-author')
          return route.fulfill({ status: 404, body: 'Owned missing author image' });
        return route.fulfill({
          status: 200,
          contentType: 'image/png',
          body: url.pathname === '/windows380-emoji-sticker' ? STICKER_PNG : EMOJI_PNG,
          headers: { 'access-control-allow-origin': '*' },
        });
      }
      const scene = SCENES.find((name) => url.pathname === `/viewing-${name}.mp4`);
      if (url.hostname === 'www.youtube.com' && scene) {
        return route.fulfill({
          ...mediaResponse(media[scene], route.request().headers()['range'] ?? null),
          contentType: 'video/mp4',
        });
      }
      if (
        url.hostname === 'www.youtube.com' &&
        url.pathname.startsWith('/youtubei/v1/live_chat/get_live_chat')
      ) {
        const key = url.searchParams.get('windows380');
        const actions =
          key && Object.hasOwn(MATRIX_BATCHES, key) && !delivered.has(key)
            ? MATRIX_BATCHES[key as keyof typeof MATRIX_BATCHES]
            : [];
        if (actions.length && key) delivered.add(key);
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          json: {
            continuationContents: {
              liveChatContinuation: {
                actions,
                continuations: [
                  { timedContinuationData: { continuation: 'windows380-next', timeoutMs: 30_000 } },
                ],
              },
            },
          },
        });
      }
      if (url.hostname === 'www.youtube.com' && route.request().resourceType() === 'document') {
        return route.fulfill({ status: 200, contentType: 'text/html', body: html });
      }
      return route.fulfill({
        status: 403,
        contentType: 'text/plain',
        body: 'Blocked by comment display matrix',
      });
    });
    await page.addInitScript({
      content: canvasProbePrelude({
        tokens: PROBE_IDS,
        forceFallback: backend === 'main',
        workerPrelude: workerProbePrelude(PROBE_IDS),
        observeCardPlans: true,
      }),
    });
    await page.addInitScript(() => {
      const playback = { paused: false };
      Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
        configurable: true,
        get: () => playback.paused,
      });
      window.__ytPlacementSetPaused = (paused) => {
        playback.paused = paused;
        document.querySelector('video')?.dispatchEvent(new Event(paused ? 'pause' : 'play'));
      };
      window.ytcfg = {
        data_: {
          INNERTUBE_API_KEY: 'windows-acceptance-key',
          INNERTUBE_CONTEXT_CLIENT_NAME: '1',
          INNERTUBE_CONTEXT_CLIENT_VERSION: '1.0',
          INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '1.0' } },
        },
      };
      window.ytInitialData = {
        currentVideoEndpoint: { watchEndpoint: { videoId: 'windows380CommentDisplay' } },
        contents: {
          twoColumnWatchNextResults: {
            conversationBar: {
              liveChatRenderer: {
                isReplay: false,
                continuations: [
                  {
                    timedContinuationData: {
                      continuation: 'windows380-live',
                      timeoutMs: 30_000,
                    },
                  },
                ],
              },
            },
          },
        },
      };
    });
    await page.addInitScript((paidId) => {
      const scope = window as typeof window & {
        __ytMatrixTranslator?: { calls: string[]; overflow: number };
      };
      const record = { calls: [] as string[], overflow: 0 };
      scope.__ytMatrixTranslator = record;
      Object.defineProperty(window, 'Translator', {
        configurable: true,
        value: {
          availability: async () => 'available',
          create: async () => ({
            translate: async (input: string) => {
              if (record.calls.length < 16) record.calls.push(input.slice(0, 512));
              else record.overflow++;
              return input.includes(paidId)
                ? `${paidId} MATRIX_TRANSLATED ${'한국어 日本語 مرحبا long translated body '.repeat(4)}`
                : `MATRIX_TRANSLATED ${input.slice(0, 96)}`;
            },
            destroy: () => {},
          }),
        },
      });
    }, PRESENTATION_IDS.detailed.paid);
    await openFresh();
    previousSettings = await page.evaluate(() => {
      const app = window.__ytChatOverlay;
      if (!app) throw new Error('Matrix settings owner unavailable');
      const previous = app.getSettings();
      app.applySettings({
        danmakuMode: 'top',
        fontSize: 32,
        laneSpacing: 0,
        safeTop: 0,
        safeBottom: 0,
        showDebugOverlay: true,
        translationEnabled: false,
        maxConcurrentMessages: 40,
        queueMaxSize: 80,
        outline: { ...previous.outline, enabled: true, widthPx: 2, opacity: 0.7 },
      });
      return previous;
    });
    const contentStyle = await page.addStyleTag({
      content: '#movie_player { height: 800px !important; aspect-ratio: auto !important; }',
    });
    await waitForProbeConfig(page, backend, {
      viewportWidth: 960,
      playerHeight: 800,
      fontSize: 32,
      laneSpacing: 0,
      mode: 'top',
      reducedMotion: false,
    });
    await send('content');
    await observeVisible(IDS[0]);
    await observeVisible(IDS[4]);
    try {
      await waitForAccessibleTails(page, IDS.slice(0, 3));
      await page.waitForFunction(
        (id) =>
          [...document.querySelectorAll<HTMLElement>('.yt-live-chat-overlay-live-region > p')]
            .find((entry) => entry.dataset.messageId === id)
            ?.textContent?.includes('مرحبا') === true,
        IDS[4],
        { timeout: 5000 }
      );
    } catch (error) {
      if (mode === 'candidate') throw error;
      if (baselineFindings.length < 24)
        baselineFindings.push('Accepted accessible tails did not all flush before content capture');
    }
    const content = await capture('content');
    assertBackend(content, backend);
    check(() => {
      assertCoherentVisibleFrame(content, IDS[0]);
      assertCoherentVisibleFrame(content, IDS[4]);
      assert(
        content.presentationCount !== null && content.presentationCount > 0,
        'Actual first-presentation accounting is unavailable'
      );
    });
    for (const id of IDS.slice(0, 3))
      check(() => {
        assert(
          content.accessibility[id]?.includes('CANONICAL_END'),
          `${id} lost accepted accessible body`
        );
      });
    check(() =>
      assert(!/e…/u.test(content.fixtureText[IDS[0]] ?? ''), 'Combining cluster was split')
    );
    check(() =>
      assert(!/👍…/u.test(content.fixtureText[IDS[1]] ?? ''), 'Emoji modifier was split')
    );
    check(() => assert(!/👨‍…/u.test(content.fixtureText[IDS[2]] ?? ''), 'ZWJ family was split'));
    for (const id of IDS.slice(0, 3))
      check(() => {
        assert(content.fixtureText[id]?.includes('…'), `${id} lacks a bounded display projection`);
        assert(
          !content.fixtureText[id]?.includes('CANONICAL_END'),
          `${id} did not truncate display`
        );
      });
    check(() =>
      assert(content.accessibility[IDS[4]]?.includes('مرحبا'), 'RTL accessible body was lost')
    );
    check(() =>
      assert(
        content.ink.some(
          (entry) => entry.id === IDS[3] && entry.right > entry.left && entry.bottom > entry.top
        ),
        'Multiline image-emoji source ink was not observed'
      )
    );
    await contentStyle.evaluate((element) => element.parentNode?.removeChild(element));

    // The six content rows become future reservations when reflowed into a
    // 255-by-318 overlay. Exercise the same bounded input on a fresh owner.
    await page.setViewportSize({ width: 320, height: 540 });
    await openFresh();
    const narrowStyle = await page.addStyleTag({
      content: '#movie_player { height: 320px !important; aspect-ratio: auto !important; }',
    });
    await page.evaluate(() =>
      window.__ytChatOverlay?.applySettings({ danmakuMode: 'top', fontSize: 48, laneSpacing: 0 })
    );
    await waitForProbeConfig(page, backend, {
      viewportWidth: 320,
      playerHeight: 320,
      fontSize: 48,
      laneSpacing: 0,
      mode: 'top',
      reducedMotion: false,
    });
    await send('narrow');
    await observeVisible(IDS[0]);
    const narrow = await capture('narrow-fixed');
    const narrowDraw = check(() => assertCoherentVisibleFrame(narrow, IDS[0]));
    check(() =>
      assert(
        narrowDraw?.rect &&
          narrowDraw.rect.left >= 0 &&
          narrowDraw.rect.right <= Number(narrow.frame?.logicalWidth),
        'Fixed-mode ink exceeds the narrow viewport'
      )
    );
    await narrowStyle.evaluate((element) => element.parentNode?.removeChild(element));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openFresh();
    const reducedStyle = await page.addStyleTag({
      content: '#movie_player { height: 320px !important; aspect-ratio: auto !important; }',
    });
    await page.evaluate(() =>
      window.__ytChatOverlay?.applySettings({ danmakuMode: 'scroll', fontSize: 48, laneSpacing: 0 })
    );
    await waitForProbeConfig(page, backend, {
      viewportWidth: 320,
      playerHeight: 320,
      fontSize: 48,
      laneSpacing: 0,
      mode: 'scroll',
      reducedMotion: true,
      ignoreReducedMotion: false,
    });
    await send('reduced');
    await observeVisible(IDS[9]);
    const reduced = await capture('reduced-motion-fixed', false);
    const reducedDraw = check(() => assertCoherentVisibleFrame(reduced, IDS[9]));
    check(() =>
      assert(
        reduced.activeNow.some((entry) => entry.id === IDS[9] && entry.isScrolling === false),
        'Reduced-motion row was not committed in fixed mode'
      )
    );
    check(() =>
      assert(
        reducedDraw?.rect &&
          reducedDraw.rect.left >= 0 &&
          reducedDraw.rect.right <= Number(reduced.frame?.logicalWidth),
        'Reduced-motion fixed ink exceeds the narrow viewport'
      )
    );
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await reducedStyle.evaluate((element) => element.parentNode?.removeChild(element));
    await page.setViewportSize({ width: 960, height: 540 });
    await openFresh();
    await page.evaluate(() =>
      window.__ytChatOverlay?.applySettings({
        danmakuMode: 'scroll',
        fontSize: 32,
        laneSpacing: 0,
        safeTop: 0,
        safeBottom: 0,
      })
    );
    await waitForProbeConfig(page, backend, {
      viewportWidth: 960,
      fontSize: 32,
      laneSpacing: 0,
      mode: 'scroll',
      reducedMotion: false,
    });

    const motionBaseline = await snapshot(page, backend);
    assertBackend(motionBaseline, backend, 'before-input');
    await send('motion');
    await observeVisible(IDS[6]);
    await page.waitForFunction(
      ({ selectedBackend, messageId }) => {
        const probe = window.__ytPlacementProbe;
        const selected =
          selectedBackend === 'worker'
            ? probe?.workers.find((record) => record.ready)?.sample
            : probe;
        const frame = selected?.latestRenderFrame;
        const row = frame?.active.find((entry) => entry.id === messageId);
        return Boolean(
          frame?.complete &&
          frame.cleared &&
          !frame.truncated &&
          row &&
          row.x >= 0 &&
          row.x < Number(frame.logicalWidth) / 2 &&
          frame.draws.some(
            (draw) =>
              draw.id === messageId &&
              draw.alpha > 0 &&
              draw.rect &&
              draw.rect.left < Number(frame.logicalWidth) &&
              draw.rect.right > 0 &&
              draw.rect.top < Number(frame.logicalHeight) &&
              draw.rect.bottom > 0
          )
        );
      },
      { selectedBackend: backend, messageId: IDS[6] },
      { polling: 100, timeout: 5000 }
    );
    const before = await capture('motion-before', false);
    check(() => assertResizeSafeMotion(before, IDS[6]));
    check(() =>
      assert(
        before.presentationCount !== null &&
          before.presentationCount > Number(motionBaseline.presentationCount),
        'Visible motion did not advance first-presentation accounting'
      )
    );
    await page.evaluate(() => window.__ytPlacementSetPaused(true));
    await page.waitForTimeout(300);
    const paused = await capture('paused', false);
    const pausedRow = paused.activeNow.find((entry) => entry.id === IDS[6]);
    const beforeRow = before.activeNow.find((entry) => entry.id === IDS[6]);
    check(() =>
      assert.deepEqual(
        Object.keys(paused.firstEntry).sort(),
        Object.keys(before.firstEntry).sort(),
        'Pause introduced another first-visible fixture message before the counter comparison'
      )
    );
    check(() =>
      assert(
        pausedRow && beforeRow && Math.abs(pausedRow.x - beforeRow.x) < 3,
        'Paused motion advanced unexpectedly'
      )
    );
    check(() =>
      assert.equal(
        paused.presentationCount,
        before.presentationCount,
        'Pause double-counted the placement epoch'
      )
    );
    await page.evaluate(() => window.__ytPlacementSetPaused(false));
    const motionHeight = Number(before.frame?.logicalHeight);
    assert(Number.isFinite(motionHeight) && motionHeight > 0);
    const motionHeightStyle = await page.addStyleTag({
      content: `#movie_player { height: ${motionHeight}px !important; aspect-ratio: auto !important; }`,
    });
    await page.setViewportSize({ width: 720, height: 540 });
    await waitForProbeConfig(page, backend, { viewportWidth: 720, playerHeight: motionHeight });
    const resized = await capture('motion-resized');
    assertBackend(resized, backend);
    check(() =>
      assert.deepEqual(
        Object.keys(resized.firstEntry).sort(),
        Object.keys(before.firstEntry).sort(),
        'Resize introduced another first-visible fixture message before the counter comparison'
      )
    );
    check(() =>
      assert.equal(
        resized.presentationCount,
        before.presentationCount,
        'Resize double-counted an already presented placement epoch'
      )
    );
    const moving = check(() => assertCommittedVisibleItem(resized, IDS[6]))?.row;
    check(() =>
      assert(
        Math.abs(
          (moving?.y ?? NaN) - (before.activeNow.find((entry) => entry.id === IDS[6])?.y ?? NaN)
        ) < 30,
        'Resize changed physical row Y unexpectedly'
      )
    );
    await motionHeightStyle.evaluate((element) => element.parentNode?.removeChild(element));

    const zeroStyle = await page.addStyleTag({
      content: '#movie_player { height: 100px !important; aspect-ratio: auto !important; }',
    });
    await page.evaluate(() =>
      window.__ytChatOverlay?.applySettings({
        danmakuMode: 'top',
        safeTop: 0.25,
        safeBottom: 0.5,
      })
    );
    await waitForProbeConfig(page, backend, {
      viewportWidth: 720,
      playerHeight: 100,
      safeTop: 0.25,
    });
    await send('zero');
    await waitForIngress(page, backend, IDS[7]);
    const zero = await capture('zero-capacity', false);
    check(() => assert(!zero.firstEntry[IDS[7]], 'Zero-capacity row was visibly drawn'));
    check(() =>
      assert(
        !zero.dispositions.some((entry) => entry.id === IDS[7] && entry.kind === 'dropped'),
        'Transient zero capacity discarded a row'
      )
    );
    await zeroStyle.evaluate((element) => element.parentNode?.removeChild(element));
    await page.evaluate(() => window.__ytChatOverlay?.applySettings({ safeTop: 0, safeBottom: 0 }));
    await send('restored');
    await observeVisible(IDS[7]);
    await observeVisible(IDS[8]);
    const restored = await capture('restored');
    check(() => assertRestoredVisibility(restored, IDS[7], IDS[8]));
    await page.evaluate(() =>
      window.__ytChatOverlay?.applySettings({
        backlogMode: 'playback',
        backlogMaxRate: 0,
        backlogInjectionRateMin: 4,
      })
    );
    const zeroSettings = await page.evaluate(() => {
      const settings = window.__ytChatOverlay?.getSettings();
      return { maximum: settings?.backlogMaxRate, minimum: settings?.backlogInjectionRateMin };
    });
    check(() => assert.deepEqual(zeroSettings, { maximum: 0, minimum: 4 }));
    const zeroStarted = Date.now();
    await send('rateZero');
    // The source backlog controller holds a >50-item batch before renderer
    // ingress when its maximum rate is zero.
    await page.waitForTimeout(1100);
    const zeroRate = await snapshot(page, backend);
    rateObservations.push({
      name: 'zero-conflicting-backlog',
      elapsedMs: Date.now() - zeroStarted,
      settings: zeroSettings,
      snapshot: zeroRate,
    });
    check(() =>
      assert(
        !zeroRate.firstEntry[IDS[10]] &&
          !zeroRate.firstEntry[IDS[11]] &&
          !Number.isFinite(zeroRate.ingress[IDS[10]]) &&
          !Number.isFinite(zeroRate.ingress[IDS[11]]),
        'Zero maximum admitted a marked backlog row to the renderer'
      )
    );
    await page.evaluate(() => window.__ytChatOverlay?.applySettings({ backlogMaxRate: 20 }));
    const resumedSettings = await page.evaluate(() => {
      const settings = window.__ytChatOverlay?.getSettings();
      return { maximum: settings?.backlogMaxRate, minimum: settings?.backlogInjectionRateMin };
    });
    check(() => assert.deepEqual(resumedSettings, { maximum: 20, minimum: 4 }));
    const resumedStarted = Date.now();
    await waitForIngress(page, backend, IDS[10]);
    await observeVisible(IDS[10]);
    const resumedRate = await snapshot(page, backend);
    rateObservations.push({
      name: 'zero-to-positive-same-owner',
      elapsedMs: Date.now() - resumedStarted,
      settings: resumedSettings,
      snapshot: resumedRate,
    });
    check(() => {
      assert(Number.isFinite(resumedRate.ingress[IDS[10]]));
      assertCoherentVisibleFrame(resumedRate, IDS[10]);
      assert(
        resumedRate.dispositions.some((entry) => entry.id === IDS[10] && entry.isBacklog === true),
        'Held zero-rate row did not resume through the backlog pipeline'
      );
    });
    // A fresh owned document keeps the positive cohort independent of the 51
    // held zero-rate rows, so old eventual service cannot satisfy its proof.
    await openFresh();
    await page.evaluate(() =>
      window.__ytChatOverlay?.applySettings({
        danmakuMode: 'top',
        fontSize: 32,
        laneSpacing: 0,
        safeTop: 0,
        safeBottom: 0,
        backlogMode: 'playback',
        backlogMaxRate: 20,
        backlogInjectionRateMin: 4,
      })
    );
    await waitForProbeConfig(page, backend, {
      viewportWidth: 720,
      fontSize: 32,
      laneSpacing: 0,
      mode: 'top',
    });
    const positiveSettings = await page.evaluate(() => {
      const settings = window.__ytChatOverlay?.getSettings();
      return { maximum: settings?.backlogMaxRate, minimum: settings?.backlogInjectionRateMin };
    });
    check(() => assert.deepEqual(positiveSettings, { maximum: 20, minimum: 4 }));
    const positiveStarted = Date.now();
    await send('ratePositive');
    await waitForIngress(page, backend, IDS[12]);
    await observeVisible(IDS[12]);
    const positiveRate = await snapshot(page, backend);
    rateObservations.push({
      name: 'positive-delayed-backlog',
      elapsedMs: Date.now() - positiveStarted,
      settings: positiveSettings,
      snapshot: positiveRate,
    });
    check(() =>
      assert(
        positiveRate.dispositions.some((entry) => entry.isBacklog === true),
        'Positive backlog was not routed through the normal renderer pipeline'
      )
    );
    check(() =>
      assert(
        Number.isFinite(positiveRate.firstEntry[IDS[12]]) &&
          !Number.isFinite(positiveRate.firstEntry[IDS[10]]),
        'Positive rate did not visibly serve its own bounded backlog cohort'
      )
    );

    const wideSupported = await page.evaluate(() =>
      Object.hasOwn(window.__ytChatOverlay?.getSettings() ?? {}, 'superChatLayout')
    );
    if (!wideSupported) {
      assert.equal(mode, 'baseline', 'Candidate source lacks superChatLayout');
      baselineFindings.push(
        'Legacy source supports stacked paid cards only; wide transport/rendering unsupported'
      );
    }

    for (const [scene, width] of [
      ['bright', 960],
      ['dark', 400],
      ['detailed', 960],
    ] as const) {
      if (backend === 'main') {
        const source = await readFile(join(root, 'dist-extension/page-script.js'), 'utf8');
        const instrumentedSource = instrumentCanvasPageScript(source, undefined, true);
        assert(instrumentedSource, 'Packaged Canvas page script shape changed');
        nativeProbe = await installNativePageScriptProbe({
          context,
          root,
          extensionId,
          fixtureUrl: FIXTURE_URL,
          instrumentedSource,
        });
        await nativeProbe.assertReady();
      }
      await page.setViewportSize({ width, height: 650 });
      await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.locator('#yt-live-chat-overlay canvas').waitFor({ state: 'attached' });
      if (nativeProbe) {
        await nativeProbe.assertInjected();
        await page.waitForFunction(() => window.__ytPlacementProbe.canvasSourceHooked === true);
        await nativeProbe.restore();
        nativeProbe = undefined;
      }
      await page.waitForFunction(() => Boolean(window.__ytChatOverlay?.getSettings));
      await page.addStyleTag({
        content: '#movie_player { height: 540px !important; aspect-ratio: auto !important; }',
      });
      await page.evaluate(
        (selectedScene) =>
          window.__ytChatOverlay?.applySettings({
            danmakuMode: 'scroll',
            fontSize: 32,
            laneSpacing: 0,
            safeTop: 0,
            safeBottom: 0,
            ignoreReducedMotion: false,
            showDebugOverlay: true,
            maxConcurrentMessages: 40,
            queueMaxSize: 80,
            superChatLayout: 'stacked',
            superChatMaxBodyLines: 4,
            translationEnabled: selectedScene === 'detailed',
            translationService: 'auto',
            translationSource: 'en',
            translationTarget: 'es',
            translationMode: 'dual',
          }),
        scene
      );
      await setScene(page, scene);
      await waitForProbeConfig(page, backend, {
        viewportWidth: width,
        playerHeight: 540,
        fontSize: 32,
        laneSpacing: 0,
        safeTop: 0,
        safeBottom: 0,
        mode: 'scroll',
        reducedMotion: false,
        ignoreReducedMotion: false,
        ...(wideSupported ? { layout: 'stacked' as const } : {}),
        activeCap: 40,
        queueCap: 80,
      });
      const paidId = PRESENTATION_IDS[scene].paid;
      const key = `presentation${scene[0]?.toUpperCase()}${scene.slice(1)}` as
        | 'presentationBright'
        | 'presentationDark'
        | 'presentationDetailed';
      await send(key);
      if (scene === 'detailed') {
        try {
          await page.waitForFunction(
            (id) => {
              const record = (
                window as typeof window & {
                  __ytMatrixTranslator?: { calls: string[]; overflow: number };
                }
              ).__ytMatrixTranslator;
              return record?.calls.some(
                (text) => text.includes(id) && text.includes('CANONICAL_END')
              );
            },
            paidId,
            { timeout: 5000 }
          );
        } catch (error) {
          if (mode === 'candidate') throw error;
          if (baselineFindings.length < 24)
            baselineFindings.push('Controlled Translator did not receive accepted canonical tail');
        }
      }
      for (const layout of (wideSupported ? ['stacked', 'wide'] : ['stacked']) as Array<
        'stacked' | 'wide'
      >) {
        if (layout === 'wide')
          await page.evaluate(() =>
            window.__ytChatOverlay?.applySettings({ superChatLayout: 'wide' })
          );
        if (wideSupported)
          await page.waitForFunction(
            ({ selectedBackend, expectedLayout }) => {
              const probe = window.__ytPlacementProbe;
              const selected =
                selectedBackend === 'worker'
                  ? probe?.workers.find((record) => record.ready)?.sample
                  : probe;
              return selected?.exact?.config?.superChatLayout === expectedLayout;
            },
            { selectedBackend: backend, expectedLayout: layout },
            { timeout: 5000 }
          );
        await observeVisible(paidId);
        if (scene === 'detailed') await observeTranslation(paidId);
        if (scene === 'detailed') await observePlan(paidId, 4);
        const name = `${scene}-${width}-${layout}`;
        const observed = await capture(name);
        assertBackend(observed, backend);
        const paid = check(() => presentationGeometry(observed, paidId));
        const translatedDraw = observed.frame?.draws.some(
          (draw) =>
            draw.id === paidId &&
            draw.alpha > 0 &&
            draw.section === 'translation' &&
            Boolean(draw.rect)
        );
        if (scene === 'detailed')
          check(() => {
            assert(translatedDraw, 'Selected paid translation lacked visible ink');
            const accessible = observed.accessibility[paidId] ?? '';
            assert(
              accessible.includes('CANONICAL_END') && accessible.includes('MATRIX_TRANSLATED'),
              'Dual presentation accessibility lost original or selected translation'
            );
          });
        if (scene === 'detailed') {
          const budget = check(() => paidRowBudget(observed, paidId, 4));
          rowBudgetObservations.push({ name, lines: 4, budget });
          if (layout === 'stacked') {
            await page.evaluate(() =>
              window.__ytChatOverlay?.applySettings({ superChatMaxBodyLines: 1 })
            );
            await observePlan(paidId, 1);
            const oneLine = await snapshot(page, backend);
            rowBudgetObservations.push({
              name: `${name}-one-line`,
              lines: 1,
              budget: check(() => paidRowBudget(oneLine, paidId, 1)),
            });
            await page.evaluate(() =>
              window.__ytChatOverlay?.applySettings({ superChatMaxBodyLines: 4 })
            );
            await observePlan(paidId, 4);
          }
        }
        const ordinaryId = PRESENTATION_IDS[scene].ordinary;
        const itemObservations: Array<{
          role: 'sticker' | 'membership' | 'ordinary';
          id: string;
          proof: ReturnType<typeof presentationItem> | undefined;
          jsonOnlyDueFrame: boolean;
        }> = [];
        for (const [role, id] of [
          ['sticker', PRESENTATION_IDS[scene].sticker],
          ['membership', PRESENTATION_IDS[scene].membership],
          ['ordinary', ordinaryId],
        ] as const) {
          try {
            await waitForVisible(page, backend, id, layout);
          } catch (error) {
            if (mode === 'candidate') throw error;
            if (baselineFindings.length < 24)
              baselineFindings.push(`No complete retained ${layout} frame for ${id}`);
          }
          const itemFrame = await snapshot(page, backend, MAX_RECORDS, { id, layout });
          itemObservations.push({
            role,
            id,
            proof: check(() => presentationItem(itemFrame, id, role)),
            jsonOnlyDueFrame: itemFrame.frame?.frameId !== observed.frame?.frameId,
          });
        }
        const ordinary = itemObservations.find((entry) => entry.role === 'ordinary')?.proof;
        const video = await page.evaluate(() => {
          const element = document.querySelector<HTMLVideoElement>('#movie_player video');
          return element
            ? {
                width: element.videoWidth,
                height: element.videoHeight,
                currentTime: element.currentTime,
                readyState: element.readyState,
              }
            : null;
        });
        const translator = await page.evaluate((id) => {
          const record = (
            window as typeof window & {
              __ytMatrixTranslator?: { calls: string[]; overflow: number };
            }
          ).__ytMatrixTranslator;
          return {
            calls: record?.calls.length ?? 0,
            canonicalTailReceived:
              record?.calls.some((text) => text.includes(id) && text.includes('CANONICAL_END')) ??
              false,
            overflow: record?.overflow ?? null,
          };
        }, paidId);
        if (scene === 'detailed')
          check(() =>
            assert(
              translator.canonicalTailReceived && translator.overflow === 0,
              'Controlled Translator did not retain bounded canonical source'
            )
          );
        presentationObservations.push({
          name,
          scene,
          layout,
          viewportWidth: width,
          viewportHeight: 650,
          logicalWidth: observed.frame?.logicalWidth ?? null,
          logicalHeight: observed.frame?.logicalHeight ?? null,
          paid,
          items: itemObservations,
          translatedDraw: translatedDraw ?? false,
          ordinary: ordinary
            ? {
                width: ordinary.card.width,
                height: ordinary.card.height,
                firstVisibleAtEpochMs: ordinary.firstVisibleAtEpochMs,
              }
            : null,
          video,
          translator,
          frameId: observed.frame?.frameId ?? null,
          overflow: observed.overflow,
        });
        if (scene === 'bright' && layout === 'stacked') {
          const memberId = PRESENTATION_IDS.bright.membership;
          try {
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await page.waitForFunction(
              ({ selectedBackend, messageId }) => {
                const probe = window.__ytPlacementProbe;
                const sample =
                  selectedBackend === 'worker'
                    ? probe?.workers.find((entry) => entry.ready)?.sample
                    : probe;
                const frame = sample?.latestRenderFrame;
                return Boolean(
                  frame?.complete &&
                  frame.config.reducedMotion === true &&
                  frame.config.ignoreReducedMotion === false &&
                  frame.cardPlans?.some((plan) => plan.id === messageId) &&
                  frame.draws.some((draw) => draw.id === messageId && draw.alpha > 0)
                );
              },
              { selectedBackend: backend, messageId: memberId },
              { timeout: 5000 }
            );
            const firstEffect = await snapshot(page, backend);
            await page.waitForFunction(
              ({ selectedBackend, priorFrame, priorTime }) => {
                const probe = window.__ytPlacementProbe;
                const sample =
                  selectedBackend === 'worker'
                    ? probe?.workers.find((entry) => entry.ready)?.sample
                    : probe;
                const frame = sample?.latestRenderFrame;
                return Boolean(
                  frame?.complete &&
                  frame.frameId > priorFrame &&
                  frame.startedAtEpochMs - priorTime >= 250
                );
              },
              {
                selectedBackend: backend,
                priorFrame: firstEffect.frame?.frameId ?? -1,
                priorTime: firstEffect.frame?.startedAtEpochMs ?? 0,
              },
              { timeout: 5000 }
            );
            const secondEffect = await snapshot(page, backend);
            const first = check(() => membershipEffect(firstEffect, memberId));
            const second = check(() => membershipEffect(secondEffect, memberId));
            check(() => {
              assert(first && second && second.logicalAtEpochMs - first.logicalAtEpochMs >= 250);
              assert(
                Math.abs(first.borderAlpha - second.borderAlpha) < 0.001,
                'Effective reduced motion changed membership border alpha'
              );
            });
            effectObservations.push({ memberId, effectiveReducedMotion: true, first, second });
          } catch (error) {
            if (mode === 'candidate') throw error;
            baselineFindings.push(
              `Membership effect observation unavailable: ${String(error).slice(0, 160)}`
            );
          } finally {
            await page.emulateMedia({ reducedMotion: 'no-preference' });
          }
        }
      }
    }
    if (wideSupported) {
      await page.locator('#yt-chat-overlay-settings-button').click({ force: true });
      const modal = page.locator('#yt-chat-overlay-settings-backdrop');
      await modal.waitFor({ state: 'visible', timeout: 5000 });
      await modal.locator('#tab-comments').click();
      const layoutControl = modal.locator('select[name="superChatLayout"]');
      assert.equal(await layoutControl.inputValue(), 'wide');
      const preview = modal.locator('[data-card-preview] canvas');
      const readPreview = async (): Promise<PreviewSample[]> => {
        await page.waitForFunction(
          () => document.querySelectorAll('[data-card-preview] canvas').length === 3,
          undefined,
          { timeout: 5000 }
        );
        return preview.evaluateAll((canvases) =>
          canvases.map((element) => {
            const canvas = element as HTMLCanvasElement;
            const context = canvas.getContext('2d');
            if (!context) throw new Error('Production preview Canvas context unavailable');
            if (canvas.width < 1 || canvas.height < 1 || canvas.width * canvas.height > 1_048_576)
              throw new Error('Production preview Canvas exceeded the pixel bound');
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            let alphaPixels = 0;
            for (let index = 3; index < pixels.length; index += 4)
              if ((pixels[index] ?? 0) > 0) alphaPixels++;
            return {
              label: canvas.parentElement?.querySelector('span')?.textContent ?? '',
              ariaLabel: canvas.getAttribute('aria-label') ?? '',
              width: canvas.width,
              height: canvas.height,
              alphaPixels,
            };
          })
        );
      };
      previewObservations.push({ layout: 'wide', samples: await readPreview() });
      await preview.first().scrollIntoViewIfNeeded();
      await capture('preview-wide');
      await modal.locator('#tab-colors').click();
      await layoutControl.selectOption('stacked');
      assert.equal(await layoutControl.inputValue(), 'stacked');
      await modal.locator('#tab-comments').click();
      await page.waitForFunction(
        (prior) => {
          const current = [
            ...document.querySelectorAll<HTMLCanvasElement>('[data-card-preview] canvas'),
          ];
          return (
            current.length === 3 &&
            current.some(
              (canvas, index) =>
                canvas.width !== prior[index]?.width || canvas.height !== prior[index]?.height
            )
          );
        },
        previewObservations[0]?.samples ?? [],
        { timeout: 5000 }
      );
      previewObservations.push({ layout: 'stacked', samples: await readPreview() });
      await preview.first().scrollIntoViewIfNeeded();
      await capture('preview-stacked');
      check(() =>
        assertPreviewComparison(
          previewObservations[1]?.samples ?? [],
          previewObservations[0]?.samples ?? []
        )
      );
      await page.keyboard.press('Escape');
      check(() => {
        const brightStacked = presentationObservations.find(
          (entry) => entry.name === 'bright-960-stacked'
        )?.paid as ReturnType<typeof presentationGeometry> | undefined;
        const brightWide = presentationObservations.find(
          (entry) => entry.name === 'bright-960-wide'
        )?.paid as ReturnType<typeof presentationGeometry> | undefined;
        assert(brightStacked && brightWide, 'Matched bright paid-card geometry is unavailable');
        assert(
          brightStacked.width !== brightWide.width || brightStacked.height !== brightWide.height,
          'Wide setting did not change paid-card geometry at wide viewport'
        );
      });
    }
    assert(Date.now() - startedAt <= MAX_RUN_MS, 'Matrix per-backend time budget exceeded');
    result = {
      status: 'passed',
      backend,
      mode,
      layoutSupport: wideSupported ? 'stacked-and-wide' : 'legacy-stacked-only',
      phases,
      rateObservations,
      presentationObservations,
      previewObservations,
      rowBudgetObservations,
      effectObservations,
      baselineFindings,
      cleanupErrors,
      delivered: [...delivered],
    };
  } catch (error) {
    const diagnostic = await snapshot(page, backend).catch(() => null);
    result = {
      status: 'failed',
      backend,
      mode,
      layoutSupport: 'unavailable',
      phases,
      rateObservations,
      presentationObservations,
      previewObservations,
      rowBudgetObservations,
      effectObservations,
      baselineFindings,
      cleanupErrors,
      delivered: [...delivered],
      diagnostic,
      errorType: error instanceof Error ? error.name : typeof error,
      errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 400),
    };
  } finally {
    clearTimeout(deadline);
    if (nativeProbe) {
      try {
        await nativeProbe.restore();
      } catch (error) {
        cleanupErrors.push(`Native probe restoration: ${String(error).slice(0, 240)}`);
      }
    }
    if (previousSettings) {
      if (page.isClosed()) cleanupErrors.push('Settings owner page closed before restoration');
      else {
        try {
          await page.evaluate(
            (settings) => window.__ytChatOverlay?.applySettings(settings),
            previousSettings
          );
        } catch (error) {
          cleanupErrors.push(`Settings restoration: ${String(error).slice(0, 240)}`);
        }
      }
    }
    try {
      await page.close();
    } catch (error) {
      cleanupErrors.push(`Owned page closure: ${String(error).slice(0, 240)}`);
    }
  }
  if (cleanupErrors.length) {
    result.status = 'failed';
    result.errorType ??= 'CleanupError';
    result.errorMessage ??= cleanupErrors.join('; ').slice(0, 400);
  }
  if (deadlineExceeded) {
    result.status = 'failed';
    result.errorType = 'DeadlineExceeded';
    result.errorMessage = `Matrix ${backend} exceeded ${MAX_RUN_MS} ms`;
  }
  return result;
}

type OverloadCase =
  | 'vacancy'
  | 'impossible'
  | 'overflow'
  | 'pause-hidden-resume'
  | 'future-membership'
  | 'zero-membership';
const OVERLOAD_SETTINGS: Record<
  OverloadCase,
  {
    active: number;
    queue: number;
    playerHeight: number;
    fontSize: number;
    durationMs: number;
  }
> = {
  vacancy: { active: 30, queue: 50, playerHeight: 540, fontSize: 32, durationMs: 1000 },
  impossible: { active: 300, queue: 200, playerHeight: 140, fontSize: 48, durationMs: 1000 },
  overflow: { active: 30, queue: 50, playerHeight: 100, fontSize: 32, durationMs: 30000 },
  'pause-hidden-resume': {
    active: 300,
    queue: 1000,
    playerHeight: 540,
    fontSize: 32,
    durationMs: 1000,
  },
  'future-membership': {
    active: 300,
    queue: 200,
    playerHeight: 540,
    fontSize: 32,
    durationMs: 1000,
  },
  'zero-membership': {
    active: 300,
    queue: 200,
    playerHeight: 100,
    fontSize: 32,
    durationMs: 1000,
  },
};
const OVERLOAD_CASES = Object.keys(OVERLOAD_SETTINGS) as OverloadCase[];

async function runOverloadBackend(options: {
  context: BrowserContext;
  root: string;
  extensionId: string;
  backend: Backend;
  mode: MatrixMode;
  html: string;
  media: Buffer;
}) {
  const { context, root, extensionId, backend, mode, html, media } = options;
  const page = await context.newPage();
  const delivered = new Set<string>();
  const deliveredIds = new Set<string>();
  const markDelivered = (key: keyof typeof OVERLOAD_BATCHES) => {
    delivered.add(key);
    for (const action of OVERLOAD_BATCHES[key]) {
      const renderer = Object.values(action.addChatItemAction.item)[0] as
        | { id?: string }
        | undefined;
      assert(renderer?.id && OVERLOAD_IDS.includes(renderer.id));
      deliveredIds.add(renderer.id);
    }
  };
  let currentCase: OverloadCase | null = null;
  let currentSnapshots: Array<{
    stage: string;
    trace: ReturnType<typeof overloadTrace>;
    outcome?: 'ordinary-waiting' | 'ordinary-already-served';
    managerProbe?: ManagerProbeRead;
  }> = [];
  let currentVacancyService: Record<string, unknown> | null = null;
  let currentOverflowInput: Record<string, unknown> | null = null;
  let managerProbeProvenance: NativePageScriptProbe['provenance'] | null = null;
  let failureStage = 'setup';
  let replayRequests = 0;
  const cases: Array<Record<string, unknown>> = [];
  const baselineFindings: string[] = [];
  const cleanupErrors: string[] = [];
  let nativeProbe: NativePageScriptProbe | undefined;
  let originalSettings:
    | Parameters<NonNullable<Window['__ytChatOverlay']>['applySettings']>[0]
    | undefined;
  let deadlineExceeded = false;
  const deadline = setTimeout(() => {
    deadlineExceeded = true;
    void page.close().catch(() => {});
  }, MAX_OVERLOAD_MS);
  const startedAt = Date.now();
  const check = (claim: () => void) => {
    try {
      claim();
    } catch (error) {
      if (mode === 'candidate') throw error;
      if (baselineFindings.length < 16)
        baselineFindings.push(
          (error instanceof Error ? error.message : String(error)).slice(0, 240)
        );
    }
  };
  const send = async (key: keyof typeof OVERLOAD_BATCHES | `overflowSeed${number}`) => {
    await page.evaluate(async (batch) => {
      const response = await fetch(
        `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?windows380=${batch}`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }
      );
      if (!response.ok) throw new Error('Overload fixture transport failed');
      await response.json();
    }, key);
    assert(delivered.has(key), `Overload batch ${key} was not delivered`);
  };
  const readRawManagerProbe = async (): Promise<ManagerProbeRead | null> =>
    page.evaluate(
      () =>
        (
          window as typeof window & { __ytMatrixManagerProbe?: { read: () => ManagerProbeRead } }
        ).__ytMatrixManagerProbe?.read() ?? null
    );
  const readManagerProbe = async (requireOwner: boolean): Promise<ManagerProbeRead> => {
    const observed = await readRawManagerProbe();
    assert(observed?.installed && observed.probeError === null, 'Worker manager probe failed');
    if (requireOwner)
      assert(
        observed.ownerCaptured && observed.workerHooked && observed.manager,
        'Worker manager was not captured from the actual render path'
      );
    return observed;
  };
  try {
    await page.setViewportSize({ width: 960, height: 650 });
    await page.route('**/*', async (route) => {
      const url = new globalThis.URL(route.request().url());
      if (url.protocol === 'chrome-extension:' && url.hostname === extensionId)
        return route.continue();
      if (url.hostname === 'www.youtube.com' && url.pathname === '/viewing-bright.mp4')
        return route.fulfill({
          ...mediaResponse(media, route.request().headers()['range'] ?? null),
          contentType: 'video/mp4',
        });
      if (
        url.hostname === 'www.youtube.com' &&
        url.pathname === '/youtubei/v1/live_chat/get_live_chat_replay' &&
        currentCase === 'future-membership'
      ) {
        replayRequests++;
        const actions =
          replayRequests === 2
            ? [
                {
                  replayChatItemAction: {
                    videoOffsetTimeMsec: 10_000,
                    actions: [OVERLOAD_BATCHES.future[0]],
                  },
                },
                {
                  replayChatItemAction: {
                    videoOffsetTimeMsec: 11_500,
                    actions: [OVERLOAD_BATCHES.future[1]],
                  },
                },
              ]
            : [];
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          json: {
            continuationContents: {
              liveChatContinuation: {
                actions,
                continuations: [
                  {
                    playerSeekContinuationData: {
                      continuation: 'windows380-overload-replay-next',
                    },
                  },
                ],
              },
            },
          },
        });
        if (actions.length) markDelivered('future');
        return;
      }
      if (
        url.hostname === 'www.youtube.com' &&
        url.pathname.startsWith('/youtubei/v1/live_chat/get_live_chat')
      ) {
        const key = url.searchParams.get('windows380');
        const actions =
          key && Object.hasOwn(OVERLOAD_BATCHES, key) && !delivered.has(key)
            ? OVERLOAD_BATCHES[key as keyof typeof OVERLOAD_BATCHES]
            : [];
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          json: {
            continuationContents: {
              liveChatContinuation: {
                actions,
                continuations: [
                  {
                    timedContinuationData: {
                      continuation: 'windows380-overload-next',
                      timeoutMs: 30_000,
                    },
                  },
                ],
              },
            },
          },
        });
        if (actions.length && key) markDelivered(key as keyof typeof OVERLOAD_BATCHES);
        return;
      }
      if (url.hostname === 'www.youtube.com' && route.request().resourceType() === 'document')
        return route.fulfill({ status: 200, contentType: 'text/html', body: html });
      return route.fulfill({
        status: 403,
        contentType: 'text/plain',
        body: 'Blocked by overload fixture',
      });
    });
    await page.addInitScript({
      content: canvasProbePrelude({
        tokens: OVERLOAD_IDS,
        forceFallback: backend === 'main',
        workerPrelude: workerProbePrelude(OVERLOAD_IDS),
        observeCardPlans: true,
      }),
    });
    await page.addInitScript(() => {
      const state = { paused: false, hidden: false, time: 10 };
      const isReplay = new URL(location.href).searchParams.has('matrixReplay');
      Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
        configurable: true,
        get: () => state.time,
        set: (value) => {
          state.time = value;
        },
      });
      Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
        configurable: true,
        get: () => state.paused,
      });
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => state.hidden,
      });
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => (state.hidden ? 'hidden' : 'visible'),
      });
      window.__ytPlacementSetPaused = (paused) => {
        state.paused = paused;
        document.querySelector('video')?.dispatchEvent(new Event(paused ? 'pause' : 'play'));
      };
      window.__ytPlacementSetVideoTime = (seconds) => {
        state.time = seconds;
      };
      (
        window as typeof window & { __ytPlacementSetHidden?: (hidden: boolean) => void }
      ).__ytPlacementSetHidden = (hidden) => {
        state.hidden = hidden;
        document.dispatchEvent(new Event('visibilitychange'));
      };
      window.ytcfg = {
        data_: {
          INNERTUBE_API_KEY: 'windows-acceptance-key',
          INNERTUBE_CONTEXT_CLIENT_NAME: '1',
          INNERTUBE_CONTEXT_CLIENT_VERSION: '1.0',
          INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '1.0' } },
        },
      };
      window.ytInitialData = {
        currentVideoEndpoint: {
          watchEndpoint: { videoId: 'windows380CommentDisplay' },
        },
        contents: {
          twoColumnWatchNextResults: {
            conversationBar: {
              liveChatRenderer: {
                isReplay,
                continuations: isReplay
                  ? [
                      {
                        playerSeekContinuationData: {
                          continuation: 'windows380-overload-replay-initial',
                        },
                      },
                    ]
                  : [
                      {
                        timedContinuationData: {
                          continuation: 'windows380-overload-live',
                          timeoutMs: 30_000,
                        },
                      },
                    ],
              },
            },
          },
        },
      };
    });
    for (const name of OVERLOAD_CASES) {
      currentCase = name;
      currentSnapshots = [];
      currentVacancyService = null;
      currentOverflowInput = null;
      managerProbeProvenance = null;
      failureStage = `${name}:navigation`;
      replayRequests = 0;
      const caps = OVERLOAD_SETTINGS[name];
      const fixtureUrl =
        name === 'future-membership' ? `${FIXTURE_URL}&matrixReplay=1` : FIXTURE_URL;
      if (backend === 'main') {
        const source = await readFile(join(root, 'dist-extension/page-script.js'), 'utf8');
        const instrumentedSource = instrumentCanvasPageScript(source, undefined, true);
        assert(instrumentedSource, 'Packaged Canvas overload script shape changed');
        nativeProbe = await installNativePageScriptProbe({
          context,
          root,
          extensionId,
          fixtureUrl,
          instrumentedSource,
        });
        await nativeProbe.assertReady();
      } else if (name === 'overflow') {
        const source = await readFile(join(root, 'dist-extension/page-script.js'), 'utf8');
        const instrumentedSource = instrumentWorkerManagerPageScript(source, mode);
        assert(instrumentedSource, 'Packaged Worker manager source shape changed');
        nativeProbe = await installNativePageScriptProbe({
          context,
          root,
          extensionId,
          fixtureUrl,
          instrumentedSource,
        });
        managerProbeProvenance = nativeProbe.provenance;
        await nativeProbe.assertReady();
      }
      await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page
        .locator('#yt-live-chat-overlay canvas')
        .waitFor({ state: 'attached', timeout: 15_000 });
      if (nativeProbe) {
        await nativeProbe.assertInjected();
        if (backend === 'main')
          await page.waitForFunction(() => window.__ytPlacementProbe.canvasSourceHooked === true);
        else await readManagerProbe(false);
        await nativeProbe.restore();
        nativeProbe = undefined;
      }
      await page.waitForFunction(() => Boolean(window.__ytChatOverlay?.getSettings));
      originalSettings ??= await page.evaluate(() => window.__ytChatOverlay?.getSettings());
      await page.addStyleTag({
        content: `#movie_player { height: ${caps.playerHeight}px !important; aspect-ratio: auto !important; }`,
      });
      await page.evaluate(
        (settings) =>
          window.__ytChatOverlay?.applySettings({
            danmakuMode: settings.name === 'future-membership' ? 'scroll' : 'top',
            fontSize: settings.fontSize,
            topBottomDurationMs: settings.durationMs,
            superChatMaxBodyLines: settings.name === 'impossible' ? 5 : 3,
            safeTop: settings.name === 'zero-membership' ? 0.25 : 0,
            safeBottom: settings.name === 'zero-membership' ? 0.5 : 0,
            maxConcurrentMessages: settings.active,
            queueMaxSize: settings.queue,
            translationEnabled: false,
            showDebugOverlay: true,
          }),
        { ...caps, name }
      );
      failureStage = `${name}:scene`;
      await setScene(page, 'bright');
      failureStage = `${name}:probe-config`;
      await waitForProbeConfig(page, backend, {
        viewportWidth: 960,
        playerHeight: caps.playerHeight,
        fontSize: caps.fontSize,
        safeTop: name === 'zero-membership' ? 0.25 : 0,
        safeBottom: name === 'zero-membership' ? 0.5 : 0,
        mode: name === 'future-membership' ? 'scroll' : 'top',
        activeCap: caps.active,
        queueCap: caps.queue,
      });
      failureStage = `${name}:observations`;
      const snapshots = currentSnapshots;
      const ids =
        name === 'vacancy'
          ? OVERLOAD_IDS.filter((id) => id.includes('_VACANCY_'))
          : name === 'impossible'
            ? OVERLOAD_IDS.filter((id) => id.includes('_IMPOSSIBLE_'))
            : name === 'overflow'
              ? OVERLOAD_IDS.filter((id) => id.includes('_OVERFLOW_'))
              : name === 'future-membership'
                ? OVERLOAD_IDS.filter((id) => id.includes('_FUTURE_'))
                : name === 'zero-membership'
                  ? OVERLOAD_IDS.filter((id) => id.includes('_ZERO_'))
                  : OVERLOAD_IDS.filter((id) => id.includes('_PAUSE_'));
      const observe = async (stage: string) => {
        const measured = await snapshot(page, backend, MAX_OVERLOAD_RECORDS);
        assertBackend(measured, backend);
        const trace = overloadTrace(measured, ids, caps, deliveredIds);
        snapshots.push({
          stage,
          trace,
          ...(backend === 'worker' && name === 'overflow'
            ? { managerProbe: await readManagerProbe(true) }
            : {}),
        });
        return measured;
      };
      if (name === 'vacancy') {
        const seedId = 'WINDOWS380_LOAD_VACANCY_ORDINARY';
        const lateId = 'WINDOWS380_LOAD_VACANCY_LATE_ORDINARY';
        await send('vacancySeed');
        await waitForIngress(page, backend, seedId);
        await page.waitForTimeout(450);
        const seed = await observe('seed');
        const ordinary = snapshots.at(-1)?.trace.records.find((record) => record.id === seedId);
        const ordinaryWaiting =
          seed.pendingNow.includes(seedId) && !Number.isFinite(seed.firstEntry[seedId]);
        const ordinaryServed = Boolean(
          Number.isFinite(ordinary?.rendererIngressAtEpochMs) &&
          Number.isFinite(ordinary?.reservedAtEpochMs) &&
          Number.isFinite(ordinary?.firstVisibleAtEpochMs)
        );
        assert(
          ordinaryWaiting || ordinaryServed,
          'Vacancy seed established neither an ordinary waiter nor completed visible service'
        );
        const seedRecord = snapshots.at(-1);
        if (seedRecord)
          seedRecord.outcome = ordinaryWaiting ? 'ordinary-waiting' : 'ordinary-already-served';
        await send('vacancyMoreA');
        await waitForIngress(page, backend, lateId);
        await page.waitForTimeout(550);
        const afterA = await observe('late-ordinary-after-paid');
        await send('vacancyMoreB');
        await page.waitForTimeout(3000);
        const end = await observe('recurring-vacancy');
        const afterATrace = snapshots.at(-2)?.trace;
        const endTrace = snapshots.at(-1)?.trace;
        const lateAfterA = afterATrace?.records.find((record) => record.id === lateId);
        const lateEnd = endTrace?.records.find((record) => record.id === lateId);
        const paidReservations = endTrace?.records
          .filter((record) => record.id.includes('_VACANCY_MORE_'))
          .map((record) => ({
            id: record.id,
            rendererIngressAtEpochMs: record.rendererIngressAtEpochMs,
            reservedAtEpochMs: record.reservedAtEpochMs,
            plannedStartAtEpochMs: record.plannedStartAtEpochMs,
            plannedEndAtEpochMs: record.plannedEndAtEpochMs,
            firstVisibleAtEpochMs: record.firstVisibleAtEpochMs,
          }));
        const paidService = paidReservations?.filter((record) =>
          Number.isFinite(record.firstVisibleAtEpochMs)
        );
        currentVacancyService = {
          seedOutcome: seedRecord?.outcome ?? null,
          seedOrdinary: ordinary ?? null,
          lateAfterA: lateAfterA ?? null,
          lateEnd: lateEnd ?? null,
          paidReservations: paidReservations ?? [],
          paidService: paidService ?? [],
          afterAFrameId: afterA.frame?.frameId ?? null,
          endFrameId: end.frame?.frameId ?? null,
        };
        check(() =>
          assert(
            Number.isFinite(end.firstEntry[seedId]),
            'Seed ordinary received no successful visible service'
          )
        );
        check(() =>
          assert(
            Number.isFinite(lateEnd?.rendererIngressAtEpochMs) &&
              Number.isFinite(lateEnd?.reservedAtEpochMs) &&
              Number.isFinite(lateEnd?.firstVisibleAtEpochMs) &&
              Number(lateEnd?.firstVisibleAtEpochMs) >= Number(lateEnd?.rendererIngressAtEpochMs),
            'Later ordinary arrival received no successful visible service'
          )
        );
        check(() =>
          assert(
            Number.isFinite(lateEnd?.rendererIngressAtEpochMs) &&
              paidService?.some(
                (record) =>
                  Number.isFinite(record.rendererIngressAtEpochMs) &&
                  Number.isFinite(record.reservedAtEpochMs) &&
                  Number(record.firstVisibleAtEpochMs) >= Number(lateEnd?.rendererIngressAtEpochMs)
              ),
            'Renewed paid pressure produced no successful visible service'
          )
        );
      } else if (name === 'impossible') {
        await send('impossible');
        await waitForIngress(page, backend, 'WINDOWS380_LOAD_IMPOSSIBLE_PAID');
        await page.waitForTimeout(2000);
        const end = await observe('unplaceable-paid-fit-ordinary');
        const paidPlan = end.measuredPlans.WINDOWS380_LOAD_IMPOSSIBLE_PAID;
        assert(
          paidPlan && paidPlan.height > caps.playerHeight,
          'Source-measured paid height did not exceed the controlled available rows'
        );
        check(() =>
          assert(
            ids.some((id) => id.includes('_ORDINARY_') && Number.isFinite(end.firstEntry[id])),
            'Impossible paid card blocked fitting ordinary ink'
          )
        );
      } else if (name === 'overflow') {
        for (let batch = 0; batch < 20; batch++) {
          failureStage = `overflow:old-${batch}:transport`;
          await send(`overflowSeed${batch}`);
          failureStage = `overflow:old-${batch}:ingress`;
          await waitForIngress(page, backend, `WINDOWS380_LOAD_OVERFLOW_OLD_${batch * 4 + 3}`);
        }
        failureStage = 'overflow:queue-full';
        const full = await observe('queue-full');
        const oldRendererIngress = Array.from({ length: 80 }, (_, index) =>
          Number.isFinite(full.ingress[`WINDOWS380_LOAD_OVERFLOW_OLD_${index}`])
        ).filter(Boolean).length;
        currentOverflowInput = {
          oldResponses: 20,
          oldMessages: 80,
          newerMessages: 4,
          oldRendererIngress,
          fullPending: full.pendingNow.length,
        };
        assert(
          oldRendererIngress === 80,
          'Overflow seed lacked renderer ingress for all 80 old rows'
        );
        assert.equal(
          full.pendingNow.length,
          caps.queue,
          'Overflow seed did not fill the pending queue'
        );
        assert(Number.isFinite(full.frame?.startedAtEpochMs));
        failureStage = 'overflow:late:transport';
        await send('overflowLate');
        if (backend === 'worker')
          currentOverflowInput.managerProbeAfterLateTransport = await readManagerProbe(true);
        failureStage = 'overflow:late:ingress';
        if (mode === 'baseline') {
          try {
            await waitForIngress(page, backend, 'WINDOWS380_LOAD_OVERFLOW_NEW_3');
          } catch (error) {
            if (!(error instanceof Error) || error.name !== 'TimeoutError') throw error;
            if (baselineFindings.length < 16)
              baselineFindings.push('Equal-priority overflow newcomer lacked renderer ingress');
          }
        } else await waitForIngress(page, backend, 'WINDOWS380_LOAD_OVERFLOW_NEW_3');
        failureStage = 'overflow:late:observation';
        const end = await observe('equal-priority-newcomers');
        const replacedOldAfterNew = end.dispositions.filter(
          (entry) =>
            entry.id.startsWith('WINDOWS380_LOAD_OVERFLOW_OLD_') &&
            entry.kind === 'dropped' &&
            entry.reason === 'queue_replaced' &&
            Number(entry.atEpochMs) > Number(full.frame?.startedAtEpochMs)
        ).length;
        currentOverflowInput.replacedOldAfterNew = replacedOldAfterNew;
        check(() =>
          assert(
            end.pendingNow.some((id) => id.includes('_OVERFLOW_NEW_')) ||
              ids.some(
                (id) => id.includes('_OVERFLOW_NEW_') && Number.isFinite(end.firstEntry[id])
              ),
            'Equal-priority overflow retained no newer content'
          )
        );
        check(() =>
          assert(
            replacedOldAfterNew > 0,
            'Equal-priority newcomers did not replace an older queued row'
          )
        );
      } else if (name === 'future-membership') {
        const futureId = 'WINDOWS380_LOAD_FUTURE_MEMBERSHIP';
        await waitForVisible(page, backend, 'WINDOWS380_LOAD_FUTURE_DUE');
        assert(
          replayRequests >= 2 && delivered.has('future'),
          'Future membership was not delivered by the replay source'
        );
        const held = await observe('replay-time-10000');
        check(() => {
          assertNoVisibleCardInk(held, futureId);
          assert(!Number.isFinite(held.ingress[futureId]) && !held.pendingNow.includes(futureId));
        });
        await page.evaluate(() => window.__ytPlacementSetVideoTime(10.001));
        await page.waitForTimeout(200);
        const stillHeld = await observe('replay-time-10001');
        check(() => {
          assertNoVisibleCardInk(stillHeld, futureId);
          assert(
            !Number.isFinite(stillHeld.ingress[futureId]) &&
              !stillHeld.pendingNow.includes(futureId)
          );
        });
        await page.evaluate(() => window.__ytPlacementSetVideoTime(11.5));
        await waitForVisible(page, backend, futureId);
        const due = await observe('replay-time-11500');
        check(() => {
          assertCoherentVisibleFrame(due, futureId);
          assert(
            due.frame?.cardPlans.some(
              (plan) =>
                plan.id === futureId && plan.kind === 'membership' && plan.borderAlpha !== null
            ),
            'Due membership lacks observed decoration after replay release'
          );
        });
      } else if (name === 'zero-membership') {
        const zeroId = 'WINDOWS380_LOAD_ZERO_MEMBERSHIP';
        await send('zeroMembership');
        await waitForIngress(page, backend, zeroId);
        await page.waitForTimeout(250);
        const zero = await observe('zero-row-deferred');
        check(() => {
          assertNoVisibleCardInk(zero, zeroId);
          assert(zero.pendingNow.includes(zeroId), 'Zero-row membership was not deferred');
          assert(
            !zero.dispositions.some(
              (entry) => entry.id === zeroId && ['activated', 'dropped'].includes(entry.kind)
            ),
            'Zero-row membership was activated or discarded'
          );
        });
      } else {
        failureStage = 'pause-hidden-resume:pre-admission';
        await send('pause');
        await Promise.all(
          ids.map(async (id) => {
            await waitForIngress(page, backend, id);
            await waitForVisible(page, backend, id);
          })
        );
        const beforePause = await observe('admitted-before-pause');
        check(() => {
          for (const id of ids) {
            assert(
              Number.isFinite(beforePause.ingress[id]),
              `${id} lacked pre-pause renderer ingress`
            );
            assertCommittedVisibleItem(beforePause, id);
          }
        });
        failureStage = 'pause-hidden-resume:hidden-hold';
        await page.evaluate(() => {
          window.__ytPlacementSetPaused(true);
          (
            window as typeof window & { __ytPlacementSetHidden?: (hidden: boolean) => void }
          ).__ytPlacementSetHidden?.(true);
        });
        await page.waitForTimeout(500);
        const held = await observe('paused-hidden');
        check(() => {
          for (const id of ids) {
            assert.equal(held.firstEntry[id], beforePause.firstEntry[id]);
            const beforeRow = beforePause.activeNow.find((entry) => entry.id === id);
            const heldRow = held.activeNow.find((entry) => entry.id === id);
            assert(beforeRow && heldRow, `${id} lost its admitted row while hidden`);
            assert(
              Math.abs(beforeRow.x - heldRow.x) < 3 && Math.abs(beforeRow.y - heldRow.y) < 3,
              `${id} moved while paused and hidden`
            );
          }
        });
        failureStage = 'pause-hidden-resume:resume-draw';
        await page.evaluate(() => {
          (
            window as typeof window & { __ytPlacementSetHidden?: (hidden: boolean) => void }
          ).__ytPlacementSetHidden?.(false);
          window.__ytPlacementSetPaused(false);
        });
        await page.waitForFunction(
          ({ selectedBackend, expectedIds, priorFrame }) => {
            const probe = window.__ytPlacementProbe;
            const worker = probe?.workers.find((record) => record.ready);
            const selected = selectedBackend === 'worker' ? worker?.sample : probe;
            const frame = selected?.latestRenderFrame;
            const visible = Boolean(
              frame?.complete &&
              frame.cleared &&
              !frame.truncated &&
              frame.frameId > priorFrame &&
              expectedIds.every(
                (id) =>
                  frame.active.some((row) => row.id === id) &&
                  frame.draws.some(
                    (draw) =>
                      draw.id === id &&
                      draw.alpha > 0 &&
                      draw.rect &&
                      draw.rect.left < Number(frame.logicalWidth) &&
                      draw.rect.right > 0 &&
                      draw.rect.top < Number(frame.logicalHeight) &&
                      draw.rect.bottom > 0
                  )
              )
            );
            if (!visible && selectedBackend === 'worker' && worker && probe) {
              const now = performance.now();
              if (now - (worker.dueFlushAt ?? -Infinity) >= 100) {
                const requestId = (probe.flushSequence ?? 0) + 1;
                probe.flushSequence = requestId;
                worker.dueFlushAt = now;
                worker.worker.postMessage({ type: 'ytPlacementFlush', requestId });
              }
            }
            return visible;
          },
          { selectedBackend: backend, expectedIds: ids, priorFrame: held.frame?.frameId ?? -1 },
          { polling: 100, timeout: 5000 }
        );
        const resumed = await observe('resumed');
        check(() => {
          assert(Number(resumed.frame?.frameId) > Number(held.frame?.frameId));
          for (const id of ids) {
            assert(Number.isFinite(resumed.ingress[id]), `${id} lost pre-pause admission`);
            assertCommittedVisibleItem(resumed, id);
          }
        });
      }
      cases.push({
        name,
        backend,
        caps,
        ids,
        snapshots,
        ...(currentVacancyService ? { vacancyService: currentVacancyService } : {}),
        ...(currentOverflowInput ? { overflowInput: currentOverflowInput } : {}),
        ...(managerProbeProvenance ? { managerProbeProvenance } : {}),
        delivered: [...delivered],
        elapsedMs: Date.now() - startedAt,
      });
    }
  } catch (error) {
    if (currentCase === 'overflow' && !page.isClosed()) {
      const measured = await snapshot(page, backend, MAX_OVERLOAD_RECORDS).catch(() => null);
      if (measured) {
        const ids = OVERLOAD_IDS.filter((id) => id.includes('_OVERFLOW_'));
        const managerProbe =
          backend === 'worker' ? await readRawManagerProbe().catch(() => null) : null;
        currentSnapshots.push({
          stage: `failed-${failureStage}`,
          trace: overloadTrace(measured, ids, OVERLOAD_SETTINGS.overflow, deliveredIds),
          ...(managerProbe ? { managerProbe } : {}),
        });
      }
    }
    if (currentCase && currentSnapshots.length > 0)
      cases.push({
        name: currentCase,
        backend,
        caps: OVERLOAD_SETTINGS[currentCase],
        snapshots: currentSnapshots,
        ...(currentVacancyService ? { vacancyService: currentVacancyService } : {}),
        ...(currentOverflowInput ? { overflowInput: currentOverflowInput } : {}),
        ...(managerProbeProvenance ? { managerProbeProvenance } : {}),
        delivered: [...delivered],
        partial: true,
        elapsedMs: Date.now() - startedAt,
      });
    const diagnostic = page.isClosed()
      ? null
      : await page
          .evaluate(
            ({ selectedBackend, caseIds }) => {
              const probe = window.__ytPlacementProbe;
              const worker = probe?.workers.find((record) => record.ready);
              const selected = selectedBackend === 'worker' ? worker?.sample : probe;
              const frame = selected?.latestRenderFrame;
              const exact = selected?.exact;
              const player = document.querySelector('#movie_player')?.getBoundingClientRect();
              const video = document.querySelector('video')?.getBoundingClientRect();
              return {
                viewportWidth: innerWidth,
                playerHeight: player?.height ?? null,
                videoRect: video
                  ? {
                      width: video.width,
                      height: video.height,
                      top: video.top,
                      bottom: video.bottom,
                    }
                  : null,
                workerReady: Boolean(worker),
                sourceHooked: probe?.sourceHooked ?? false,
                canvasSourceHooked: probe?.canvasSourceHooked ?? false,
                managerProbe:
                  selectedBackend === 'worker'
                    ? ((
                        window as typeof window & {
                          __ytMatrixManagerProbe?: { read: () => ManagerProbeRead };
                        }
                      ).__ytMatrixManagerProbe?.read() ?? null)
                    : null,
                workerProbe: worker
                  ? {
                      flushId: worker.flushId ?? null,
                      stats: worker.stats.slice(-4).map((entry) => ({
                        pendingQueueDepth: entry.pendingQueueDepth ?? null,
                        totalRendered: entry.totalRendered ?? null,
                        totalPresented: entry.totalPresented ?? null,
                      })),
                    }
                  : null,
                config: exact?.config ?? null,
                retained: exact?.retained ?? null,
                ingress: Object.fromEntries(
                  caseIds
                    .filter((id) => Number.isFinite(selected?.ingress?.[id]))
                    .map((id) => [id, selected?.ingress?.[id]])
                ),
                pendingNow:
                  exact?.pendingNow?.filter((id) => caseIds.includes(id)).slice(0, 128) ?? [],
                activeNow:
                  exact?.activeNow?.filter((entry) => caseIds.includes(entry.id)).slice(0, 128) ??
                  [],
                dispositions:
                  exact?.dispositions
                    ?.filter((entry) => caseIds.includes(entry.id))
                    .slice(-128)
                    .map((entry) => ({
                      id: entry.id,
                      kind: entry.kind,
                      reason: entry.reason ?? null,
                      atEpochMs: entry.atEpochMs ?? null,
                    })) ?? [],
                frame: frame
                  ? {
                      frameId: frame.frameId,
                      complete: frame.complete,
                      logicalWidth: frame.logicalWidth,
                      logicalHeight: frame.logicalHeight,
                    }
                  : null,
              };
            },
            {
              selectedBackend: backend,
              caseIds: OVERLOAD_IDS.filter((id) =>
                currentCase ? id.includes(`_${currentCase.toUpperCase().split('-')[0]}_`) : false
              ),
            }
          )
          .catch(() => null);
    return {
      status: 'failed' as const,
      backend,
      mode,
      currentCase,
      failureStage,
      diagnostic,
      cases,
      baselineFindings,
      cleanupErrors,
      errorType: error instanceof Error ? error.name : typeof error,
      errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 400),
    };
  } finally {
    clearTimeout(deadline);
    if (nativeProbe) {
      try {
        await nativeProbe.restore();
      } catch (error) {
        cleanupErrors.push(`Native overload probe restoration: ${String(error).slice(0, 240)}`);
      }
    }
    if (originalSettings && !page.isClosed()) {
      try {
        await page.evaluate(
          (settings) => window.__ytChatOverlay?.applySettings(settings),
          originalSettings
        );
      } catch (error) {
        cleanupErrors.push(`Overload settings restoration: ${String(error).slice(0, 240)}`);
      }
    }
    try {
      await page.close();
    } catch (error) {
      cleanupErrors.push(`Owned overload page closure: ${String(error).slice(0, 240)}`);
    }
  }
  return {
    status: deadlineExceeded || cleanupErrors.length ? ('failed' as const) : ('passed' as const),
    backend,
    mode,
    cases,
    baselineFindings,
    cleanupErrors,
    durationMs: Date.now() - startedAt,
    maxBackendMs: MAX_OVERLOAD_MS,
    maxRecordsPerSnapshot: MAX_OVERLOAD_RECORDS,
    maxFrameDraws: MAX_FRAME_DRAWS,
    screenshotCount: 0,
    hiddenState: 'controlled Document visibility getter and visibilitychange event',
  };
}

export async function runCommentDisplayMatrix(options: {
  context: BrowserContext;
  root: string;
  output: string;
  extensionId: string;
  mode: MatrixMode;
}) {
  validateMatrixMode(options.mode);
  const fixturePaths = [
    'validation/windows/comment-display-matrix.ts',
    'validation/windows/placement-timing.ts',
    'validation/windows/native-page-script-probe.ts',
    'validation/windows/visible-watch.ts',
    'test/visual/preview.html',
    ...SCENES.map((scene) => `validation/windows/fixtures/viewing-${scene}.mp4`),
  ];
  const [preview, pageScript, profile, bundle, ...fixtureBytes] = await Promise.all([
    readFile(join(options.root, 'test/visual/preview.html'), 'utf8'),
    readFile(join(options.root, 'dist-extension/page-script.js')),
    readFile(join(options.root, 'validation/windows/profile.json')),
    readFile(join(options.root, 'bundle.json'), 'utf8'),
    ...fixturePaths.map((path) => readFile(join(options.root, path))),
  ]);
  const fixtureSha256 = Object.fromEntries(
    fixturePaths.map((path, index) => {
      const bytes = fixtureBytes[index];
      assert(bytes, `Fixture source bytes unavailable for ${path}`);
      return [path, createHash('sha256').update(bytes).digest('hex')];
    })
  );
  const identity = {
    ...bindMatrixIdentity(
      JSON.parse(bundle) as unknown,
      createHash('sha256').update(profile).digest('hex'),
      createHash('sha256').update(pageScript).digest('hex'),
      fixtureSha256
    ),
    bundleSha256: createHash('sha256').update(bundle).digest('hex'),
    mode: options.mode,
  };
  const planProbeCapability = classifyPlanProbeCapability(
    options.mode,
    pageScript.toString('utf8')
  );
  if (planProbeCapability !== 'instrumented') {
    const legacyPlanless = planProbeCapability === 'unsupported-legacy-planless';
    const result = {
      status: legacyPlanless ? 'unsupported' : 'failed',
      identity,
      runtime: {
        kind: legacyPlanless ? 'unsupported-legacy-planless' : 'invalid-plan-instrumentation',
        sourceSha: identity.sourceSha,
        runtimeCapability: 'unavailable',
        sourceWideLayout: legacyPlanless ? 'absent' : 'unqualified',
      },
      cases: [],
      overload: { status: 'not-run', cases: [] },
      visualReview: 'not-run',
      comparisonScope: legacyPlanless
        ? 'Planless stacked-only packaged source; whole matrix unsupported'
        : 'Required shared paid plan could not be instrumented; no matrix observation',
      errorMessage: 'No Worker or Canvas observation was collected',
    } as const;
    await writeFile(
      join(options.output, 'comment-display-matrix.json'),
      JSON.stringify(result, null, 2)
    );
    return result;
  }
  const html = buildVisibleWatchHtml(preview, 'Comment display matrix video');
  const media = Object.fromEntries(
    SCENES.map((scene, index) => {
      const bytes = fixtureBytes[fixtureBytes.length - SCENES.length + index];
      assert(bytes, `Owned ${scene} media is unavailable`);
      return [scene, bytes];
    })
  ) as Record<Scene, Buffer>;
  const results = [];
  for (const backend of ['worker', 'main'] as const) {
    results.push(await runBackend({ ...options, backend, html, media }));
  }
  const runtime = classifyMatrixRuntime(options.mode, identity.sourceSha, results);
  const legacyCorrectnessBaseline = runtime.kind === 'legacy-stacked-baseline';
  const overloadResults: Awaited<ReturnType<typeof runOverloadBackend>>[] = [];
  if (!legacyCorrectnessBaseline)
    for (const backend of ['worker', 'main'] as const)
      overloadResults.push(
        await runOverloadBackend({ ...options, backend, html, media: media.bright })
      );
  const result = {
    status:
      options.mode === 'baseline'
        ? runtime.kind !== 'invalid-capability' &&
          results.every(
            (entry) =>
              entry.status === 'passed' &&
              entry.phases.length ===
                (entry.layoutSupport === 'legacy-stacked-only' ? 11 : MAX_PHASES_PER_BACKEND)
          ) &&
          (legacyCorrectnessBaseline || overloadResults.every((entry) => entry.status === 'passed'))
          ? 'observed'
          : 'failed'
        : runtime.kind === 'wide-capable-candidate' &&
            results.every((entry) => entry.status === 'passed') &&
            overloadResults.every((entry) => entry.status === 'passed')
          ? 'passed'
          : 'failed',
    identity,
    runtime,
    cases: results,
    overload: {
      status: legacyCorrectnessBaseline
        ? 'unsupported-legacy'
        : runtime.kind === 'invalid-capability'
          ? 'unqualified-capability'
          : overloadResults.every((entry) => entry.status === 'passed')
            ? 'observed'
            : 'failed',
      comparisonScope: legacyCorrectnessBaseline
        ? 'Observed legacy stacked-only correctness baseline; overload policy comparison unsupported'
        : runtime.kind === 'invalid-capability'
          ? 'Mixed or unavailable backend capability; overload records are unqualified'
          : options.mode === 'baseline'
            ? 'Wide-capable baseline; bind corrected pre-387 product tree separately'
            : 'Wide-capable final candidate; bind product tree separately',
      cases: overloadResults,
      limits: {
        maxBackendMs: MAX_OVERLOAD_MS,
        maxRecordsPerSnapshot: MAX_OVERLOAD_RECORDS,
        maxFrameDraws: MAX_FRAME_DRAWS,
        maxScreenshots: 0,
      },
    },
    scope:
      'Controlled owned YouTube-shaped page, installed extension, actual Worker and forced Canvas',
    visualReview: 'pending',
    comparison:
      'Compare explicit baseline and candidate records with identical fixture digest and workload',
    instrumentation:
      'Canvas and Worker draw, queue, and frame hooks are active during timing samples; probe overhead is included and has not been isolated; no GPU or FPS claim',
    limits: {
      maxPhasesPerBackend: MAX_PHASES_PER_BACKEND,
      maxCapturesPerBackend: MAX_CAPTURES_PER_BACKEND,
      maxRecordsPerSnapshot: MAX_RECORDS,
      maxFrameDraws: MAX_FRAME_DRAWS,
      maxBackendMs: MAX_RUN_MS,
    },
  };
  await writeFile(
    join(options.output, 'comment-display-matrix.json'),
    JSON.stringify(result, null, 2)
  );
  return result;
}
