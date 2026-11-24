export type PermissionRule = { action: string; resource: string; effect: 'allow' | 'ask' | 'deny' };

export function permissionRules(value: unknown): PermissionRule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(rule => rule && typeof rule.action === 'string' && typeof rule.resource === 'string'
    && (rule.effect === 'allow' || rule.effect === 'ask' || rule.effect === 'deny')
    ? [{ action: rule.action, resource: rule.resource, effect: rule.effect }] : []);
}

function wildcard(pattern: string, value: string): boolean {
  // Greedy whole-value glob matching without backtracking through a generated regex.
  let p = 0, v = 0, star = -1, retry = 0;
  while (v < value.length) {
    if (pattern[p] === '*') { star = p++; retry = v; }
    else if (pattern[p] === '?' || pattern[p] === value[v]) { p++; v++; }
    else if (star >= 0) { p = star + 1; v = ++retry; }
    else return false;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}

export function subagentRules(value: unknown): PermissionRule[] {
  return permissionRules(value).filter(rule => wildcard(rule.action, 'subagent'));
}

export function taskPermission(permission: any, name: string): { action: string; rule: string } {
  let result = { action: 'unknown', rule: 'No matching configured rule' };
  if (Array.isArray(permission)) {
    for (const rule of subagentRules(permission)) if (wildcard(rule.resource, name)) {
      result = { action: rule.effect, rule: `${rule.action}: ${rule.resource}` };
    }
    return result;
  }
  const task = typeof permission === 'string' ? permission : permission?.task;
  if (typeof task === 'string') return { action: task, rule: 'task shorthand' };
  for (const [pattern, action] of Object.entries(task && typeof task === 'object' && !Array.isArray(task) ? task : {})) {
    if (wildcard(pattern, name)) result = { action: typeof action === 'string' ? action : 'unknown', rule: pattern };
  }
  return result;
}
