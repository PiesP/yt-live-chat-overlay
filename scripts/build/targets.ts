// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { MAX_PACKAGED_WORKER_BYTES } from '../../extension/worker-source-limit.ts';
import {
  captureBuildIdentity,
  recordFootprint,
  retireFootprint,
  type BuildIdentity,
} from '../release/footprint.ts';

const root = resolve(import.meta.dirname, '..', '..');

/** Retire the prior receipt, then measure only this Vite+ production build. */
export function buildTargets(
  capture: () => BuildIdentity = captureBuildIdentity,
  run: () => void = () => {
    execFileSync('vp', ['run', 'production-build'], { cwd: root, stdio: 'inherit' });
  },
  record: (identity: BuildIdentity, workerLimitBytes: number) => void = recordFootprint,
  retire: () => void = retireFootprint
): void {
  retire();
  const identity = capture();
  run();
  record(identity, MAX_PACKAGED_WORKER_BYTES);
}

if (import.meta.main) buildTargets();
