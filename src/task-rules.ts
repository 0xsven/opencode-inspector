import { subagentRules } from './permissions';

export function taskDecision(value: unknown): string {
  return value === 'allow' || value === 'ask' || value === 'deny' ? value : 'unknown';
}

// Display configured order without inventing file provenance or runtime defaults.
export function configuredTaskRules(permission: unknown): { pattern: string; action: string }[] {
  if (Array.isArray(permission)) return subagentRules(permission).map(rule => ({ pattern: `${rule.action}: ${rule.resource}`, action: rule.effect }));
  const task = typeof permission === 'string' ? permission
    : permission && typeof permission === 'object' ? (permission as Record<string, unknown>).task : undefined;
  if (typeof task === 'string') return [{ pattern: 'task shorthand', action: taskDecision(task) }];
  if (!task || typeof task !== 'object' || Array.isArray(task)) return [];
  return Object.entries(task).map(([pattern, action]) => ({ pattern, action: taskDecision(action) }));
}
