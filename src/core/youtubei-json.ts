// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

export type JsonObject = Record<string, unknown>;

/** Type guard that checks if a value is a non-null object record. */
export const isRecord = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null;

/** Casts a value to a JsonObject if it passes the record type guard, otherwise returns null. */
export const asRecord = (value: unknown): JsonObject | null => (isRecord(value) ? value : null);

/** Returns the value if it is a non-empty string, otherwise returns undefined. */
export const getString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/** Returns the value coerced to a finite number, or undefined if not numeric. */
export const getNumber = (value: unknown): number | undefined => {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

/** Traverses a nested object along the given path and returns the final value if it is a record, or null. */
export const getNestedRecord = (root: unknown, path: readonly string[]): JsonObject | null => {
  let current: unknown = root;

  for (const key of path) {
    if (!isRecord(current)) {
      return null;
    }

    current = current[key];
  }

  return isRecord(current) ? current : null;
};

/**
 * YouTube ytInitialData is ~2000+ DFS nodes for a watch page (secondaryResults
 * with 20 related videos alone totals ~1600 nodes). A 500-node limit risks
 * missing the liveChatRenderer buried deep inside conversationBar, causing
 * false "unavailable" results on valid live-chat pages.
 *
 * Raised to 3000 to provide adequate traversal budget without unbounded growth.
 */
const MAX_PROCESSED = 3000;

/**
 * Generic DFS search through a nested object tree for a specific key.
 * Prioritizes the 'contents' key branch first — YouTube's page structure
 * nests chat renderers under contents/objects that contain the live chat panel.
 * When the key is found, the extract callback decides whether the value
 * is acceptable and what to return. If extract returns null/undefined
 * the search continues.
 */
const findFirstNestedByKey = <T>(
  root: unknown,
  key: string,
  extract: (value: unknown) => T | null
): T | null => {
  const stack: unknown[] = [root];
  let processed = 0;

  while (stack.length > 0) {
    if (++processed > MAX_PROCESSED) {
      break;
    }

    const current = stack.pop();
    if (!isRecord(current)) {
      continue;
    }

    const candidate = current[key];
    const result = extract(candidate);
    if (result !== null) {
      return result;
    }

    // Push children onto stack. YouTube page structure nests chat-related
    // objects inside 'contents' arrays — prioritize those by pushing them
    // LAST (LIFO: last-pushed = explored first), then the 'contents' key.
    const entries = Object.entries(current);

    // First pass: push non-'contents' values
    for (const [k, value] of entries) {
      if (k === 'contents') continue;
      if (Array.isArray(value)) {
        for (const item of value) stack.push(item);
        continue;
      }
      stack.push(value);
    }

    // Second pass: push 'contents' values LAST so they're explored FIRST
    const contentsValue = current.contents;
    if (Array.isArray(contentsValue)) {
      for (const item of contentsValue) stack.push(item);
    } else if (contentsValue !== undefined) {
      stack.push(contentsValue);
    }
  }

  return null;
};

/**
 * DFS search for the first record containing the given key whose value passes the optional predicate.
 * @param root - The root object to search.
 * @param key - The key to look for at each level.
 * @param predicate - Optional filter applied to records found.
 */
export const findFirstNestedRecordByKey = (
  root: unknown,
  key: string,
  predicate?: (value: JsonObject) => boolean
): JsonObject | null => {
  return findFirstNestedByKey(root, key, (v) => {
    if (!isRecord(v)) return null;
    if (predicate && !predicate(v)) return null;
    return v;
  });
};

/**
 * DFS search for the first non-empty string value for the given key in a nested structure.
 * @param root - The root object to search.
 * @param key - The key to look for at each level.
 */
export const findFirstNestedStringByKey = (root: unknown, key: string): string | undefined =>
  findFirstNestedByKey(root, key, (v) => getString(v) ?? null) ?? undefined;
