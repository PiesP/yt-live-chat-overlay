// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

// Events describe what the caller, transport and observer can see. They do
// not contain production promise, generation, or controller state.
export type ReplayTransition =
  | 'seek'
  | 'stop'
  | 'start'
  | 'deadline'
  | 'old-success'
  | 'old-failure'
  | 'old-abort'
  | 'begin-replacement'
  | 'replacement-success'
  | 'replacement-failure'
  | 'old-loop-finish';

type RequestId = 'old' | 'replacement';
type AbortReason = 'deadline' | 'seek' | 'stop';
type RequestOutcome = 'success' | 'failure' | AbortReason;
export type Replacement = 'seek' | 'session';

interface Generation {
  session: 0 | 1;
  seek: 0 | 1;
}

interface Request {
  id: RequestId;
  generation: Generation;
}

interface ReplayState {
  generation: Generation | null;
  queue: readonly Request[];
  active: RequestId | null;
  deadlineFired: boolean;
  firstAbort: AbortReason | null;
  oldOutcome: RequestOutcome | null;
  replacementOutcome: 'success' | 'failure' | null;
  displayed: readonly RequestId[];
  observer: Generation['session'] | null;
  oldLoopFinished: boolean;
}

const original: Generation = { session: 0, seek: 0 };
const seeked: Generation = { session: 0, seek: 1 };
const restarted: Generation = { session: 1, seek: 0 };

export const initialState: ReplayState = {
  generation: original,
  queue: [{ id: 'old', generation: original }],
  active: 'old',
  deadlineFired: false,
  firstAbort: null,
  oldOutcome: null,
  replacementOutcome: null,
  displayed: [],
  observer: 0,
  oldLoopFinished: false,
};

export function enabledEvents(state: ReplayState, mode: Replacement): ReplayTransition[] {
  const events: ReplayTransition[] = [];
  if (state.generation === original) events.push(mode === 'seek' ? 'seek' : 'stop');
  if (!state.generation) events.push('start');
  if (state.active === 'old') {
    events.push('old-success', 'old-failure');
    if (!state.deadlineFired) events.push('deadline');
    if (state.firstAbort) events.push('old-abort');
  }
  if (!state.active && state.queue[0]?.id === 'replacement') events.push('begin-replacement');
  if (state.active === 'replacement') events.push('replacement-success', 'replacement-failure');
  if (mode === 'session' && state.oldOutcome && !state.oldLoopFinished) {
    events.push('old-loop-finish');
  }
  return events;
}

export function applyEvent(state: ReplayState, event: ReplayTransition): ReplayState {
  switch (event) {
    case 'seek':
      return {
        ...state,
        generation: seeked,
        queue: [...state.queue, { id: 'replacement', generation: seeked }],
        firstAbort: state.active === 'old' ? (state.firstAbort ?? 'seek') : state.firstAbort,
        displayed: [],
      };
    case 'stop':
      return {
        ...state,
        generation: null,
        firstAbort: state.active === 'old' ? (state.firstAbort ?? 'stop') : state.firstAbort,
        displayed: [],
        observer: null,
      };
    case 'start':
      return {
        ...state,
        generation: restarted,
        queue: [...state.queue, { id: 'replacement', generation: restarted }],
        observer: 1,
      };
    case 'deadline':
      return { ...state, firstAbort: state.firstAbort ?? 'deadline', deadlineFired: true };
    case 'begin-replacement':
      return { ...state, active: 'replacement' };
    case 'old-success':
    case 'old-failure':
    case 'old-abort': {
      const oldOutcome = event === 'old-failure' ? 'failure' : (state.firstAbort ?? 'success');
      return {
        ...state,
        queue: state.queue.slice(1),
        active: null,
        oldOutcome,
        displayed:
          oldOutcome === 'success' && state.queue[0]?.generation === state.generation
            ? ['old']
            : state.displayed,
      };
    }
    case 'replacement-success':
    case 'replacement-failure':
      return {
        ...state,
        queue: state.queue.slice(1),
        active: null,
        replacementOutcome: event === 'replacement-success' ? 'success' : 'failure',
        displayed:
          event === 'replacement-success' && state.queue[0]?.generation === state.generation
            ? ['replacement']
            : state.displayed,
      };
    case 'old-loop-finish':
      return {
        ...state,
        oldLoopFinished: true,
        observer: state.observer === 0 ? null : state.observer,
      };
  }
}

export function observeTrace(events: readonly ReplayTransition[], mode: Replacement): ReplayState {
  return events.reduce((state, event) => {
    if (!enabledEvents(state, mode).includes(event)) {
      throw new Error(`Illegal replay event ${event} in ${events.join(' → ')}`);
    }
    return applyEvent(state, event);
  }, initialState);
}
