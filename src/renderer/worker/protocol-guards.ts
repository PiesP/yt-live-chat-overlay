// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Runtime guards for renderer worker protocol messages.
 *
 * Validates control messages at the worker boundary before they are cast
 * to internal types. Malformed messages are rejected without mutating
 * renderer state.
 */

// ── Helpers ───────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
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
      // Content validation is handled by the renderer; just verify discriminant
      return true;
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
      return isRecord(value.config);
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
      // laneDensity is optional; accept any message with the discriminant
      return true;
    case 'clearState':
      return true;
    case 'snapshotMessages':
      return typeof value.requestId === 'number';
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

  // Quick shallow check: first message has required fields
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
