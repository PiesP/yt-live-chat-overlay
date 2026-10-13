// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { OverlaySettings } from '@app-types';
import type { RenderWorkerManager } from '@renderer/worker/manager';
import type { WorkerConfig } from '@renderer/worker/types';
import type { RootSettingMeta, SettingMeta } from '@settings/meta';

type IsAssignable<Source, Target> = Source extends Target ? true : false;
type RequireTrue<Value extends true> = Value;

type SharedWorkerSettingKey = keyof OverlaySettings & keyof WorkerConfig;
export type WorkerSettingUpdatesAreComplete = RequireTrue<
  IsAssignable<SharedWorkerSettingKey, (typeof RenderWorkerManager.WORKER_CONFIG_KEYS)[number]>
>;

export type MissingScalarMetadata = RequireTrue<
  // @ts-expect-error A scalar metadata map must include every root setting.
  IsAssignable<Omit<RootSettingMeta, 'enabled'>, RootSettingMeta>
>;

export type WrongScalarMetadata = RequireTrue<
  // @ts-expect-error A boolean setting cannot carry a number metadata tag.
  IsAssignable<Omit<RootSettingMeta, 'enabled'> & { enabled: SettingMeta<number> }, RootSettingMeta>
>;

export type MissingWorkerField = RequireTrue<
  // @ts-expect-error A Worker initialization config must include every required field.
  IsAssignable<Omit<WorkerConfig, 'speedPxPerSec'>, WorkerConfig>
>;

export type WrongWorkerValue = RequireTrue<
  // @ts-expect-error A Worker config field must keep its declared value type.
  IsAssignable<Omit<WorkerConfig, 'speedPxPerSec'> & { speedPxPerSec: string }, WorkerConfig>
>;
