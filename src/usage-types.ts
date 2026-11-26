/** Recorded usage only; categories are disjoint and total is their sum.
 * For partial responses, totals include only known valid counters.
 */
export interface UsageTokens {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export type UsageGranularity = 'hour' | 'day' | 'week' | 'month';
export type UsageRange = {
  from: number; to: number; timezone: string; granularity?: UsageGranularity;
  project?: string;
  /** Sorted distinct IDs for a selection of two or more; replaces `project`. */
  projects?: string[];
};

export interface UsageProject {
  /** Opaque, source-derived ID or the reserved `unattributed` bucket. */
  id: string;
  name: string;
  sessions: number;
  steps: number;
  tokens: number;
}

export interface UsageTopSession {
  id: string;
  title: string | null;
  project: string | null;
  steps: number;
  /** Known valid in-period tokens attributed to this root and its verified descendants. */
  tokens: number;
}

interface UsageTimelineBucket {
  /** Local YYYY-MM-DD at the bucket start, or a UTC ISO instant for hourly buckets. */
  date: string;
  /** Known valid tokens only. */
  tokens: number;
  /** Distinct contributing sessions in this series and bucket; not additive across series or buckets. */
  sessions: number;
  /** Recorded assistant steps, even if the token counters are missing. */
  steps: number;
}
export interface UsageCounts {
  /** Unique parentless sessions with user/assistant activity in the range. */
  activeSessions: number;
  /** Parentless sessions created in the range with retained original user/assistant
   * activity anywhere in their history. Creation date drives daily counts, even
   * when the first activity is later. Empty and copied-only sessions are excluded.
   */
  newSessions: number;
  /** Unique active child sessions, including resumed children. */
  subagentSessions: number;
  /** Recorded assistant steps, assigned by table creation time, not user turns. */
  steps: number;
  tokens: UsageTokens;
}

export interface UsageHourOfDay {
  /** Local clock hour (0–23), combining repeated hours. */
  hour: number;
  steps: number;
  tokens: UsageTokens;
}

export type UsageDelegationStatus = 'pending' | 'streaming' | 'running' | 'completed' | 'error' | 'unknown';
export interface UsageDelegationNode {
  id: string;
  parentId: string | null;
  agent: string | null;
  role: 'main' | 'subagent' | 'unknown';
  countBasis: 'outgoing' | 'incoming';
  attempts: number;
  statuses: Record<UsageDelegationStatus, number>;
  contextOnly: boolean;
  ancestry: 'verified' | 'unknown' | 'ambiguous' | 'cycle' | 'limited';
}
export interface UsageDelegations {
  metric: 'recorded-attempts';
  timeBasis: 'creation';
  totalAttempts: number;
  /** Snapshot-wide diagnostic: these records cannot be assigned to any period. */
  unlocatedAttempts: number;
  warnings: string[];
  /** Each period attempt contributes once to an incoming node. Main roots mirror
   * their direct outgoing attempts; summing every node would double-count them.
   * Context ancestors contribute no out-of-range attempts. Tool completion is
   * not necessarily child completion (background calls can return immediately).
   */
  nodes: UsageDelegationNode[];
}

export type UsageResponse = {
  status: 'unavailable';
  updatedAt: string;
  message: string;
} | {
  status: 'available' | 'partial';
  updatedAt: string;
  /** Milliseconds since epoch; to is exclusive. */
  range: UsageRange;
  formats: string[];
  warnings: string[];
  summary: UsageCounts;
  /** Period totals across all projects, even when the rest of the response is scoped. */
  projects: UsageProject[];
  /** Up to ten sessions, ranked by in-period assistant steps in the selected scope. */
  topSessions: UsageTopSession[];
  /** Up to ten sessions, ranked by known in-period tokens in the selected scope. */
  topSessionsByTokens: UsageTopSession[];
  activity: Array<UsageCounts & { date: string }>;
  /** Exactly 24 buckets in hour order, including zeroes. Older servers may omit this. */
  activityByHour?: UsageHourOfDay[];
  /** Historical assistant attribution; missing names and durable auxiliary usage
   * (compaction/title/generate, with no assistant step) are grouped as "Unknown".
   */
  agents: Array<{ name: string; sessions: number; steps: number; tokens: UsageTokens }>;
  /** Per-record historical provider/model pair; null identities are unknown.
   * Sessions counts distinct contributing root and child sessions, like agents.
   * A session can contribute to multiple models. Durable title/compaction/generate usage
   * has no recorded identity and contributes zero assistant steps.
   */
  models: Array<{ provider: string | null; model: string | null; sessions: number; steps: number; tokens: UsageTokens }>;
  modelActivity: Array<UsageTimelineBucket & { provider: string | null; model: string | null; role: 'main' | 'subagent' }>;
  /** Same buckets and counters as modelActivity, grouped by recorded agent. */
  agentActivity: Array<UsageTimelineBucket & { agent: string; role: 'main' | 'subagent' }>;
  /** Tool loads/failures by completion time, explicit V2 activations, and
   * distinct skill IDs per delivered V2 user message by message creation time.
   * Sessions is the unique union of successes and failures; not skill adherence.
   */
  skills: Array<{ name: string; loads: number; failedLoads: number; sessions: number }>;
  delegations: UsageDelegations;
};

/** Index lifecycle is separate from the accounting coverage in status/warnings. */
export interface UsageIndexState {
  state: 'indexing' | 'refreshing' | 'ready' | 'failed';
  /** Time the source read snapshot was pinned, not build completion/request time. */
  indexedAt: string | null;
  /** null means the source could not be checked. Status checks can wake a rebuild. */
  sourceChanged: boolean | null;
  /** Sanitized lifecycle error; no filenames, SQL or source content. */
  message?: string;
}

/** GET /api/usage. Check GET /api/usage/status for freshness and progress.
 * Send refresh=1 once for an explicit rebuild (the only retry after a failed initial build).
 */
export type IndexedUsageResponse = (UsageResponse & { index: UsageIndexState }) | {
  status: 'indexing';
  updatedAt: string;
  range: UsageRange;
  index: UsageIndexState & { state: 'indexing'; indexedAt: null };
};
