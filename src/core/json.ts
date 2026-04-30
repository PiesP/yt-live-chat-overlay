export type JsonObject = Record<string, unknown>;

export const isRecord = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null;

export const asRecord = (value: unknown): JsonObject | null => (isRecord(value) ? value : null);

export const getString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

export const getNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
};
