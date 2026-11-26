import type { UsagePage } from './navigation';

// The server currently sends diagnostic text, not warning codes. Keep display
// copy separate and never put an unrecognized diagnostic in the overlay.
const diagnostics = new Map<string, string>([
  ['Some history tables have an unsupported schema and were excluded.', 'history'],
  ['Malformed history records were excluded.', 'history'],
  ['Some usage records have missing or invalid token counters; totals include only known counters.', 'counters'],
  ['Some migrated compactions have no retained token counters; compaction usage may be incomplete.', 'compaction'],
  ['Compaction projection-to-event correspondence is unverified; totals include only retained durable usage events.', 'compaction'],
  ['Some V2 history lacks its retained native creation lifecycle; imported title, compaction and generate usage coverage is unverified.', 'backgroundTokens'],
  ['V2 durable usage events are unavailable; compaction, title and generate token usage may be incomplete.', 'backgroundTokens'],
  ['Some delegation sessions have invalid identities; ancestry is incomplete.', 'sessionLinks'],
  ['Some delegation attempts have no retained child-session association; requested resumes are not treated as verified links.', 'delegationLinks'],
  ['Some delegation attempts have unknown caller or requested callee agents.', 'delegationAgents'],
  ['V2 task records may retain migrated creation timestamps or interrupted lifecycle states.', 'delegationTiming'],
  ['Some delegation records have unknown lifecycle states.', 'delegationStatus'],
  ['Some delegation attempts lack a valid creation timestamp and cannot be assigned to a period.', 'delegationCoverage'],
  ['Some delegation history has an unsupported schema and was excluded.', 'delegationCoverage'],
  ['V2 split delegation history has an unsupported schema and was excluded.', 'delegationCoverage'],
  ['Some delegation records have invalid owner identities and were excluded.', 'delegationCoverage'],
  ['Legacy delegation tool history is unavailable.', 'delegationCoverage'],
  ['Some V2 delegation content has an unsupported shape and was excluded.', 'delegationCoverage'],
  ['V2 split skill history has an unsupported schema and was excluded.', 'skillCoverage'],
  ['Some terminal skill attempts lack a completion timestamp and could not be assigned to the range.', 'skillCoverage'],
  ['Some V2 skill attachments lack a recorded ID and were excluded.', 'skillCoverage'],
  ['Skill load history is unavailable for legacy records.', 'skillCoverage'],
  ['Some delegation call identities are missing or invalid; distinct record-local identities were used.', 'internal'],
  ['Duplicate delegation call records were excluded.', 'internal'],
  ['Duplicate legacy skill records were excluded.', 'internal'],
  ['Duplicate V2 skill records were excluded.', 'internal'],
]);

export function usageWarningSummary(warnings: readonly string[], delegationWarnings: readonly string[], page: UsagePage) {
  const delegation = new Set(delegationWarnings);
  const impacts = new Set([...warnings, ...delegation].map(warning => diagnostics.get(warning)
    ?? (warning.startsWith('Some delegation ancestry is ') ? 'delegationLinks'
      : delegation.has(warning) ? 'unknownDelegation' : 'unknown')));
  const summary: string[] = [];
  if (impacts.has('history')) summary.push('Some usage history couldn’t be read and isn’t included.');
  if (page !== 'skills' && (impacts.has('counters') || impacts.has('compaction') || impacts.has('backgroundTokens'))) {
    const coverage = impacts.has('backgroundTokens') ? ' Background work, such as naming sessions or summarizing older messages, may be missing.'
      : impacts.has('compaction') ? ' Work to summarize older messages may be missing.' : '';
    summary.push(`Token totals may be incomplete. Only recorded counts are included.${coverage}`);
  }
  if (page === 'overview' && impacts.has('sessionLinks')) {
    summary.push('Some subagent work may not be included in its parent session’s totals.');
  }
  if (page === 'skills' && impacts.has('skillCoverage')) summary.push('Some skill load attempts may be missing from this period.');
  if (page === 'agents') {
    const otherWarnings = summary.length;
    if (impacts.has('delegationCoverage')) summary.push('Some delegation attempts may be missing from this period.');
    if (impacts.has('delegationLinks') || impacts.has('sessionLinks')) summary.push('Some delegation links couldn’t be verified.');
    if (impacts.has('delegationAgents')) summary.push('Some delegations don’t identify both agents.');
    if (impacts.has('delegationTiming')) summary.push('Some delegation dates or statuses may not reflect what happened.');
    else if (impacts.has('delegationStatus')) summary.push('Some delegation statuses are unknown.');
    if (impacts.has('unknownDelegation') && summary.length === otherWarnings) {
      summary.push('Some delegation details may be incomplete.');
    }
  }
  if (impacts.has('unknown') && !impacts.has('history')) summary.push('Some usage data may be incomplete.');
  return summary;
}
