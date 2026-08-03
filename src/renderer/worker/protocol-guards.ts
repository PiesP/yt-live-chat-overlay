// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Runtime guards for renderer worker protocol messages.
 *
 * Validates control messages at the worker boundary before they are cast
 * to internal types. Malformed messages are rejected without mutating
 * renderer state.
 */

import { isRecord } from '@piesp/browser-core/util';
import { resolveLimits } from '@settings/limits';

const MAX_ADD_MESSAGES_PER_BATCH = resolveLimits('queueMaxSize').max;
const SUPPORTED_LANE_DENSITY_FACTORS = new Set([0.5, 0.75, 1]);
const BLOCKED_CONFIG_KEYS = ['__proto__', 'constructor', 'prototype'] as const;
const RESOURCE_CONFIG_KEYS = [
  'maxConcurrentMessages',
  'queueMaxSize',
  'backgroundQueueMax',
  'emojiCacheMb',
  'photoCacheMb',
  'stickerCacheMb',
  'textCacheMb',
  'translationBatchSize',
  'emojiFetchLimit',
  'emojiFetchTimeoutMs',
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function hasOwn(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.hasOwn(record, key);
}

function isCanvasLike(value: unknown): boolean {
  return isRecord(value) && typeof value.getContext === 'function';
}

function isSafeConfig(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;

  if (BLOCKED_CONFIG_KEYS.some((key) => hasOwn(value, key))) return false;

  for (const configValue of Object.values(value)) {
    if (typeof configValue === 'number' && (!Number.isFinite(configValue) || configValue < 0)) {
      return false;
    }
  }

  for (const key of RESOURCE_CONFIG_KEYS) {
    if (!hasOwn(value, key)) continue;
    const configValue = value[key];
    if (typeof configValue !== 'number') return false;
    const limits = resolveLimits(key);
    if (configValue < limits.min || configValue > limits.max) return false;
  }

  return true;
}

// ── Worker control message guard ──────────────────────────────────────────

/**
 * Validate a renderer worker control message.
 *
 * Only validates low-frequency control messages (init, resize, updateConfig,
 * setPaused, destroy, etc.). High-frequency addMessages frames receive only
 * shallow validation (array check, id/text presence, finite width/height).
 *
 * @returns true if the message is a valid control message or addMessages payload
 */
export function isValidControlMessage(value: unknown): boolean {
  if (!isRecord(value)) return false;

  const type = value.type;
  if (typeof type !== 'string') return false;

  switch (type) {
    case 'init':
      return (
        isSafeConfig(value.config) &&
        isCanvasLike(value.canvas) &&
        isPositiveFiniteNumber(value.width) &&
        isPositiveFiniteNumber(value.height) &&
        isPositiveFiniteNumber(value.dpr)
      );
    case 'resize':
      return (
        typeof value.width === 'number' &&
        Number.isFinite(value.width) &&
        value.width > 0 &&
        typeof value.height === 'number' &&
        Number.isFinite(value.height) &&
        value.height > 0
      );
    case 'updateConfig':
      return isSafeConfig(value.config);
    case 'setPaused':
      return value.paused === true || value.paused === false;
    case 'setUserPaused':
      return value.paused === true || value.paused === false;
    case 'updateTranslation':
      return (
        typeof value.id === 'string' &&
        value.id.length > 0 &&
        (typeof value.translatedText === 'string' || value.translatedText === null)
      );
    case 'laneDensity':
      return typeof value.factor === 'number' && SUPPORTED_LANE_DENSITY_FACTORS.has(value.factor);
    case 'clearState':
      return true;
    case 'snapshotMessages':
      return (
        typeof value.requestId === 'number' &&
        Number.isSafeInteger(value.requestId) &&
        value.requestId >= 0
      );
    case 'destroy':
      return true;
    case 'ping':
      return true;
    case 'addMessages':
      return validateAddMessages(value);
    default:
      return false;
  }
}

/**
 * Shallow validation of addMessages payload.
 * Only checks that messages is an array with required id/text fields
 * and finite width/height/priority. Does NOT perform deep schema parsing
 * — the renderer handles individual message validation internally.
 */
function validateAddMessages(data: Record<string, unknown>): boolean {
  if (!Array.isArray(data.messages)) return false;
  if (data.messages.length > MAX_ADD_MESSAGES_PER_BATCH) return false;

  // Shallow-check each message's required fields without deeply parsing content.
  // Full validation is done per-message in the renderer
  for (const msg of data.messages) {
    if (!isRecord(msg)) return false;
    if (typeof msg.id !== 'string' || msg.id.length === 0) return false;
    if (typeof msg.text !== 'string') return false;
    if (!isFiniteNonNegative(msg.width)) return false;
    if (!isFiniteNonNegative(msg.height)) return false;
    if (!isFiniteNumber(msg.priority)) return false;
  }

  return true;
}
