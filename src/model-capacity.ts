export type ContextComparison = 'lower' | 'equal' | 'greater' | 'unknown';

export function tokenLimit(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function compareContext(configured: unknown, capacity: unknown): ContextComparison {
  const left = tokenLimit(configured), right = tokenLimit(capacity);
  if (left === undefined || right === undefined) return 'unknown';
  return left < right ? 'lower' : left > right ? 'greater' : 'equal';
}

export function formatLimit(value: unknown): string {
  const limit = tokenLimit(value);
  return limit !== undefined ? limit.toLocaleString('en-US') : value === undefined ? 'Unknown' : 'Unknown · unsupported value';
}
