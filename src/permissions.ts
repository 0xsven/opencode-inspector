export function taskPermission(permission: any, name: string): { action: string; rule: string } {
  const task = typeof permission === 'string' ? permission : permission?.task;
  if (typeof task === 'string') return { action: task, rule: 'task shorthand' };
  let result = { action: 'unknown', rule: 'No matching configured rule' };
  for (const [pattern, action] of Object.entries(task && typeof task === 'object' ? task : {})) {
    const regex = '^' + pattern.split('*').map(s => s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\?/g, '.')).join('.*') + '$';
    if (new RegExp(regex).test(name)) result = { action: typeof action === 'string' ? action : 'unknown', rule: pattern };
  }
  return result;
}
