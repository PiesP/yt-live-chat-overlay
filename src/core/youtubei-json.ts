export type JsonObject = Record<string, unknown>;

export const isRecord = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null;

export const asRecord = (value: unknown): JsonObject | null => (isRecord(value) ? value : null);

export const getString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

export const getNumber = (value: unknown): number | undefined => {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

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

const MAX_PROCESSED = 500;

/**
 * Generic DFS search through a nested object tree for a specific key.
 * When the key is found, the extract callback decides whether the value
 * is acceptable and what to return. If extract returns null/undefined
 * the search continues.
 */
export function findFirstNestedByKey<T>(
  root: unknown,
  key: string,
  extract: (value: unknown) => T | null
): T | null {
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
    if (result != null) {
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
}

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

export const findFirstNestedStringByKey = (root: unknown, key: string): string | undefined =>
  findFirstNestedByKey(root, key, (v) => getString(v) ?? null) ?? undefined;
