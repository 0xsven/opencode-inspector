import type { Entry } from './types';

export const agentGroupHelp = 'Uses configured mode or known built-in role.';
export const agentGroupNames = ['Main agents', 'Subagents', 'Internal agents', 'Other agents'] as const;
export type AgentGroup = typeof agentGroupNames[number];

export function groupAgents(items: Entry[]): Map<AgentGroup, Entry[]> {
  const groups = new Map<AgentGroup, Entry[]>(agentGroupNames.map(name => [name, []]));
  for (const entry of items) {
    const mode = entry.data.mode;
    const name = entry.id;
    const group: AgentGroup = mode === 'all' ? 'Main agents'
      : mode === 'primary' ? 'Main agents'
        : mode === 'subagent' ? 'Subagents'
          : mode !== undefined ? 'Other agents'
            : ['compaction', 'title', 'summary'].includes(name) ? 'Internal agents'
              : ['build', 'plan'].includes(name) ? 'Main agents'
                : ['general', 'explore', 'scout'].includes(name) ? 'Subagents'
                  : 'Other agents';
    groups.get(group)!.push(entry);
    if (mode === 'all') groups.get('Subagents')!.push(entry);
  }
  return groups;
}
