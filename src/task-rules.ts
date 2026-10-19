export function taskDecision(value: unknown): string {
  return value === 'allow' || value === 'ask' || value === 'deny' ? value : 'unknown';
}

// Display the effective configured order without inventing file provenance.
export function configuredTaskRules(permission: unknown): { pattern: string; action: string }[] {
  const task = typeof permission === 'string' ? permission
    : permission && typeof permission === 'object' ? (permission as Record<string, unknown>).task : undefined;
  if (typeof task === 'string') return [{ pattern: 'task shorthand', action: taskDecision(task) }];
  if (!task || typeof task !== 'object' || Array.isArray(task)) return [];
  return Object.entries(task).map(([pattern, action]) => ({ pattern, action: taskDecision(action) }));
}
