// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { MAX_PACKAGED_WORKER_BYTES } from '../../extension/worker-source-limit.ts';
import { captureBuildIdentity, recordFootprint, type BuildIdentity } from '../release/footprint.ts';

const root = resolve(import.meta.dirname, '..', '..');
const scripts = [
  'build:ci',
  'build:extension:ci',
  'build:extension:firefox:ci',
  'check:artifacts',
] as const;

/** Preserve the maintained one-pass target order and record only its resulting outputs. */
export function buildTargets(
  capture: () => BuildIdentity = captureBuildIdentity,
  run: (script: string) => void = (script) => {
    execFileSync('pnpm', ['-s', script], { cwd: root, stdio: 'inherit' });
  },
  record: (identity: BuildIdentity, workerLimitBytes: number) => void = recordFootprint
): void {
  const identity = capture();
  for (const script of scripts) run(script);
  record(identity, MAX_PACKAGED_WORKER_BYTES);
}

if (import.meta.main) buildTargets();
