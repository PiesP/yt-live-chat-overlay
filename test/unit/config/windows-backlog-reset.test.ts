// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

import { test } from 'vite-plus/test';

import { instrumentBacklogResetSource } from '../../../validation/windows/backlog-reset.ts';

test('backlog observer retains the production renderer before the first controller is created', () => {
  const source = [
    'var CanvasRenderer = class CanvasRenderer {',
    '  constructor() { this.overlay = { getUserPauseState: () => false }; }',
    '  getQueueLength() { return 0; }',
    '  updateBacklogPause() {}',
    '  addMessage(message) {}',
    '  replayMessage(message) {}',
    '};',
    'var BacklogInjectionController = class BacklogInjectionController {',
    '  setPaused(paused) { this.paused = paused; }',
    '  drainPending() { return []; }',
    '};',
    'var RuntimeManager = class RuntimeManager {',
    '  constructor() { this.renderer = null; this.backlogController = null; }',
    '  createRenderer(overlay, settings) { return new CanvasRenderer(); }',
    '  ensureBacklogController(renderer) {',
    '    this.backlogController = new BacklogInjectionController();',
    '    renderer.onBacklogPauseChange = () => {};',
    '  }',
    '  updateSessionSettings() {}',
    '  performOverlayRefresh(reason) {}',
    '  requestManagedRestart(reason) {}',
    '};',
    'function main() {',
    '  const manager = new RuntimeManager();',
    '  manager.renderer = manager.createRenderer({}, {});',
    '  window.fixtureManager = manager;',
    '}',
    '\tmain();',
    '',
  ].join('\n');
  const state = {
    manager: null as unknown,
    renderer: null as unknown,
    controller: null as unknown,
    callback: null as unknown,
    phase: 'bootstrap',
    lifecycle: [] as Array<{ kind: string; managerSame: boolean; rendererSame: boolean }>,
    lifecycleOverflow: 0,
  };
  const window = { __ytBacklogReset: state, fixtureManager: null as unknown };
  runInNewContext(instrumentBacklogResetSource(source), {
    window,
    performance: { now: () => 1 },
  });
  const manager = window.fixtureManager as {
    renderer: unknown;
    backlogController: unknown;
    ensureBacklogController(renderer: unknown): void;
  };
  assert.equal(state.manager, manager);
  assert.equal(state.renderer, manager.renderer);
  assert.equal(state.controller, null);
  assert.deepEqual(state.lifecycle, []);

  manager.ensureBacklogController(manager.renderer);
  assert.equal(state.controller, manager.backlogController);
  assert.equal(
    state.callback,
    (manager.renderer as { onBacklogPauseChange: unknown }).onBacklogPauseChange
  );
  assert.deepEqual(
    state.lifecycle.map(({ kind, managerSame, rendererSame }) => [kind, managerSame, rendererSame]),
    [['controller-created', true, true]]
  );
});
