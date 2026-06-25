// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

export type JsonObject = Record<string, unknown>;

/**
 * Type guard that checks whether a value is a non-null, non-array object.
 * Used to safely narrow `unknown` values parsed from YouTube API JSON responses.
 *
 * @param value - The value to check
 * @returns `true` if the value is a plain object record
 */
export const isRecord = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Safely casts a value to a {@link JsonObject} if it is a record, otherwise
 * returns `null`. Useful for defensive unwrapping of parsed JSON.
 *
 * @param value - The value to cast
 * @returns The value as a record, or `null` if it is not a plain object
 */
export const asRecord = (value: unknown): JsonObject | null => (isRecord(value) ? value : null);

/**
 * Extracts a non-empty string from an unknown value.
 * Returns `undefined` for non-string or empty-string values.
 *
 * @param value - The value to extract a string from
 * @returns The string value, or `undefined` if not a non-empty string
 */
export const getString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/**
 * Coerces a value to a finite number, returning `undefined` if the value
 * is not numeric. Accepts numeric strings (e.g. `"42"`).
 *
 * @param value - The value to coerce to a number
 * @returns A finite number, or `undefined` if the value is not numeric
 */
export const getNumber = (value: unknown): number | undefined => {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

/**
 * Traverses a nested object along the given key path and returns the final
 * value if it is a record. Returns `null` if any segment along the path
 * is not a record or if the final value is not a record.
 *
 * @param root - The root object to traverse
 * @param path - Ordered array of keys forming the traversal path
 * @returns The nested record at the end of the path, or `null`
 */
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

    for (const value of Object.values(current)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          stack.push(item);
        }
        continue;
      }

      stack.push(value);
    }
  }

  return null;
};

/**
 * Depth-first search for the first nested record that has the given key,
 * optionally filtered by a predicate. The search is bounded by a node-visit
 * limit ({@link MAX_PROCESSED}) to prevent runaway traversal on very deep
 * YouTube API response trees.
 *
 * @param root - The root object to search
 * @param key - The key to look for at each level of nesting
 * @param predicate - Optional filter applied to candidate records; only
 *   records for which the predicate returns `true` are returned
 * @returns The first matching record, or `null` if none found
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
 * Depth-first search for the first non-empty string value associated with
 * the given key anywhere in a nested object tree. Delegates to
 * {@link findFirstNestedByKey} with a string extractor.
 *
 * @param root - The root object to search
 * @param key - The key to look for at each level of nesting
 * @returns The first non-empty string value, or `undefined` if none found
 */
export const findFirstNestedStringByKey = (root: unknown, key: string): string | undefined =>
  findFirstNestedByKey(root, key, (v) => getString(v) ?? null) ?? undefined;
