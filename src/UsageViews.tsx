import { createMemo, For, Show, type ComponentProps } from 'solid-js';
import { DelegationTrees, type MainAgentFilter } from './DelegationTrees';
import { OverviewChart, RankedCountChart, RankedModelChart, type ActivityView, type UsageMeasure } from './UsageCharts';
import { UsageTable } from './UsageTable';
import { UsageTimeline } from './UsageTimeline';
import type { ClockFormat } from './useClockFormat';
import { RouteLink } from './WorkspaceLinks';
import { usageRoute, type Route } from './navigation';
import type { usageRange } from './usage-period';
import type { UsageProject, UsageResponse, UsageTokens } from './usage-types';

export type AvailableUsage = Extract<UsageResponse, { status: 'available' | 'partial' }>;
export type SelectedProject = Pick<UsageProject, 'id' | 'name'>;
export type TimelineControls = Pick<ComponentProps<typeof UsageTimeline>,
  'view' | 'onViewChange' | 'role' | 'onRoleChange'>;
type ChartPeriod = ReturnType<typeof usageRange>;

const fmt = (value: number) => value.toLocaleString('en-US');
const compactUsageNumber = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const tokenColumns = ['Input', 'Output', 'Reasoning', 'Cache read', 'Cache write', 'Total tokens'];
const tokenValues = (tokens: UsageTokens) => [tokens.input, tokens.output, tokens.reasoning, tokens.cacheRead, tokens.cacheWrite, tokens.total];
const measureLabel = { tokens: 'tokens', steps: 'assistant steps' } as const;
const measureTotal = (row: { steps: number; tokens: UsageTokens }, measure: UsageMeasure) =>
  measure === 'tokens' ? row.tokens.total : row.steps;
const measureColumn = (measure: UsageMeasure) => measure === 'tokens' ? 7 : 1;
const topUsageRows = (rows: Array<{ title: string; note: string; count: number }>) =>
  rows.filter(row => row.count > 0).sort((a, b) => b.count - a.count).slice(0, 10);

function RankedRow(props: { index: number; title: string; note: string; count: number; unit: string }) {
  return <>
    <span class="usage-overview-rank" aria-hidden="true">{String(props.index + 1).padStart(2, '0')}.</span>
    <span class="usage-overview-ranked-label"><strong>{props.title}</strong><small>{props.note}</small></span>
    <span class="usage-overview-count">{fmt(props.count)}<span class="visually-hidden">{` ${props.unit}`}</span></span>
  </>;
}

const modelRoute: Route = { ...usageRoute, subpage: 'models' };
const agentRoute: Route = { ...usageRoute, subpage: 'agents' };

function OverviewUsageList(props: {
  title: 'Models' | 'Agents';
  rows: ReturnType<typeof topUsageRows>;
  unit: string;
  route: Route;
  go: (route: Route) => void;
}) {
  const group = () => props.title.toLowerCase();
  return <section class="usage-section">
      <h2>{props.title}</h2>
    <Show when={props.rows.length} fallback={<p class="secondary">No named {group()} with {props.unit} in this period.</p>}>
      <ol class="usage-overview-list surface-card" role="list" aria-label={`${props.title} by ${props.unit}`}>
        <For each={props.rows}>{(row, i) => <li>
          <RankedRow index={i()} title={row.title} note={row.note} count={row.count} unit={props.unit}/>
        </li>}</For>
      </ol>
    </Show>
    <RouteLink class="usage-overview-link" route={props.route} choose={() => props.go(props.route)}>View all {group()} ›</RouteLink>
  </section>;
}

export function UsageOverview(props: {
  data: AvailableUsage;
  period: ChartPeriod;
  project?: SelectedProject;
  measure: UsageMeasure;
  activityView: ActivityView;
  onActivityViewChange: (view: ActivityView) => void;
  active: boolean;
  clockFormat?: ClockFormat;
  onProjectClick: (project: UsageProject) => void;
  go: (route: Route) => void;
}) {
  const summary = () => props.data.summary;
  const summaryValues = () => [summary().activeSessions, summary().steps, summary().tokens.total];
  const breakdownValues = () => [
    summary().activeSessions, summary().newSessions, summary().subagentSessions, summary().steps, ...tokenValues(summary().tokens),
  ];
  const activityLabel = () => props.period.granularity === 'week' ? 'Weekly activity' : props.period.granularity === 'month' ? 'Monthly activity' : 'Daily activity';
  const activityDateLabel = () => props.period.granularity === 'week' ? 'Week of' : props.period.granularity === 'month' ? 'Month starting' : 'Date';
  const unit = () => measureLabel[props.measure];
  const topModels = createMemo(() => topUsageRows(props.data.models.flatMap(model => model.model === null ? [] : [{
    title: model.model, note: model.provider ?? 'Unknown provider', count: measureTotal(model, props.measure),
  }])));
  const topAgents = createMemo(() => topUsageRows(props.data.agents.filter(agent => agent.name !== 'Unknown').map(agent => ({
    title: agent.name, note: `${fmt(agent.sessions)} ${agent.sessions === 1 ? 'session' : 'sessions'}`, count: measureTotal(agent, props.measure),
  }))));
  const visibleProjects = createMemo(() => {
    const measure = props.measure;
    return [...props.data.projects].sort((a, b) => b[measure] - a[measure]).slice(0, 10);
  });
  // A running Inspector can serve the new client bundle before its API is restarted.
  const topSessions = (): AvailableUsage['topSessions'] | undefined =>
    props.measure === 'tokens' ? props.data.topSessionsByTokens : props.data.topSessions;

  return <>
    <section class="usage-section usage-lead surface-card" aria-label="Period summary">
      <dl class="usage-count-grid"><For each={['Active sessions', 'Assistant steps', 'Tokens']}>{(label, i) => {
        const value = () => summaryValues()[i()];
        return <div><dt>{label}</dt><dd title={fmt(value())}><span aria-hidden="true">{compactUsageNumber.format(value())}</span><span class="visually-hidden">{fmt(value())}</span></dd></div>;
      }}</For></dl>
    </section>
    <section class="usage-section">
      <h2>Activity</h2>
      <OverviewChart activity={props.data.activity} activityByHour={props.data.activityByHour} from={props.period.from} to={props.period.to}
        granularity={props.period.granularity} metric={props.measure} view={props.activityView} onViewChange={props.onActivityViewChange} active={props.active} clockFormat={props.clockFormat}/>
    </section>
    <div class="usage-overview-lists">
      <Show when={!props.project}>
        <section class="usage-section">
          <h2>Projects</h2>
          <Show when={visibleProjects().length} fallback={<p class="secondary">No project activity in this period.</p>}>
            <ol class="usage-overview-list surface-card" role="list">
              <For each={visibleProjects()}>{(option, i) => <li>
                <button type="button" onClick={() => props.onProjectClick(option)}>
                  <RankedRow index={i()} title={option.name}
                    note={`${fmt(option.sessions)} active ${option.sessions === 1 ? 'session' : 'sessions'}`}
                    count={option[props.measure]} unit={unit()}/>
                </button>
              </li>}</For>
            </ol>
          </Show>
        </section>
      </Show>
      <section class="usage-section">
        <h2>Top sessions</h2>
        <Show when={topSessions()?.length} fallback={<p class="secondary">{topSessions()
          ? `No sessions with ${unit()} in this period.`
          : 'Restart Inspector to see top sessions by tokens. The Steps ranking is still available.'}</p>}>
          <ol class="usage-overview-list surface-card" role="list" aria-label={`Top sessions by ${unit()}`}>
            <For each={topSessions()}>{(session, i) => <li>
              <RankedRow index={i()} title={session.title || 'Untitled session'} note={session.project ?? 'Unattributed'} count={session[props.measure]} unit={unit()}/>
            </li>}</For>
          </ol>
        </Show>
      </section>
    </div>
    <div class="usage-overview-lists">
      <OverviewUsageList title="Models" rows={topModels()} unit={unit()} route={modelRoute} go={props.go}/>
      <OverviewUsageList title="Agents" rows={topAgents()} unit={unit()} route={agentRoute} go={props.go}/>
    </div>
    <details class="usage-period-details surface-card"><summary>Period breakdown</summary>
      <dl><For each={['Active sessions', 'New root sessions', 'Subagent sessions', 'Assistant steps', ...tokenColumns]}>{(label, i) =>
        <div><dt>{label}</dt><dd>{fmt(breakdownValues()[i()])}</dd></div>
      }</For></dl>
    </details>
    <details class="usage-period-details surface-card"><summary>{activityLabel()}</summary>
      <Show when={props.data.activity.length} fallback={<p class="secondary">No recorded activity in this period.</p>}>
        <UsageTable label={activityLabel()} columns={[activityDateLabel(), 'Active roots', 'New roots', 'Subagents', 'Steps', ...tokenColumns]} highlights={[0, props.measure === 'tokens' ? 9 : 3]}
          rows={props.data.activity.map(day => ({ id: day.date, name: () => <time dateTime={day.date}>{day.date}</time>,
            values: [day.activeSessions, day.newSessions, day.subagentSessions, day.steps, ...tokenValues(day.tokens)].map(fmt) }))}/>
      </Show>
    </details>
  </>;
}

type TimelineViewProps = { data: AvailableUsage; period: ChartPeriod; measure: UsageMeasure; timeline: TimelineControls };

function UsageSeries(props: {
  activity: AvailableUsage['modelActivity'] | AvailableUsage['agentActivity'];
  kind?: 'agent';
  period: ChartPeriod;
  measure: UsageMeasure;
  timeline: TimelineControls;
}) {
  return <UsageTimeline activity={props.activity} from={props.period.from} to={props.period.to} granularity={props.period.granularity}
    kind={props.kind} view={props.timeline.view} onViewChange={props.timeline.onViewChange} metric={props.measure}
    role={props.timeline.role} onRoleChange={props.timeline.onRoleChange}/>;
}

export function UsageModels(props: TimelineViewProps) {
  const models = createMemo(() => {
    const measure = props.measure;
    return [...props.data.models].sort((a, b) => measureTotal(b, measure) - measureTotal(a, measure));
  });
  const rankedBy = () => measureColumn(props.measure);
  return <section class="usage-section">
    <h2>Per-model usage</h2>
    <UsageSeries activity={props.data.modelActivity} period={props.period} measure={props.measure} timeline={props.timeline}/>
    <p class="secondary">Sessions may appear under multiple models. Title, compaction, and session generation count as Unknown with zero steps.</p>
    <Show when={props.data.models.length} fallback={<p class="secondary">No model usage recorded in this period.</p>}>
      <p class="usage-list-note secondary">Models ranked by {measureLabel[props.measure]}.</p>
      <RankedModelChart label={`Models ranked by ${measureLabel[props.measure]}`} measure={props.measure}
        rows={models().map(model => ({ label: `${model.provider ?? 'Unknown'} / ${model.model ?? 'Unknown'}`, tokens: model.tokens, steps: model.steps }))}/>
      <UsageTable label="Per-model usage" columns={['Model', 'Sessions', 'Steps', ...tokenColumns]} highlights={[0, rankedBy()]} rankedBy={rankedBy()}
        rows={models().map(model => ({ id: JSON.stringify([model.provider, model.model]),
          name: () => <>{model.model ?? 'Unknown'}<small class="usage-provider">{model.provider ?? 'Unknown provider'}</small></>,
          values: [model.sessions, model.steps, ...tokenValues(model.tokens)].map(fmt) }))}/>
    </Show>
  </section>;
}

export function UsageAgents(props: TimelineViewProps & {
  project?: SelectedProject; mainAgent?: MainAgentFilter; onMainAgentChange: (agent: MainAgentFilter | undefined) => void;
}) {
  const agents = createMemo(() => {
    const measure = props.measure;
    return [...props.data.agents].sort((a, b) => measureTotal(b, measure) - measureTotal(a, measure));
  });
  const rankedBy = () => measureColumn(props.measure);
  return <>
    <section class="usage-section"><h2>Agent usage over time</h2>
      <UsageSeries activity={props.data.agentActivity} kind="agent" period={props.period} measure={props.measure} timeline={props.timeline}/>
    </section>
    <section class="usage-section" aria-label="Delegation trees">
      <DelegationTrees delegations={props.data.delegations} mainAgent={props.mainAgent} onMainAgentChange={props.onMainAgentChange}/>
    </section>
    <section class="usage-section">
      <h2>Agent totals</h2>
      <p class="secondary">Totals for {props.project ? `agents in ${props.project.name}` : 'all agents'} across the selected period, ranked by {measureLabel[props.measure]}.</p>
      <Show when={props.data.agents.length} fallback={<p class="secondary">No agent usage recorded in this period.</p>}>
        <UsageTable label="Agent totals" columns={['Agent', 'Sessions', 'Steps', ...tokenColumns]} highlights={[0, rankedBy()]} rankedBy={rankedBy()}
          rows={agents().map(agent => ({ id: agent.name, name: () => agent.name,
            values: [agent.sessions, agent.steps, ...tokenValues(agent.tokens)].map(fmt) }))}/>
      </Show>
    </section>
  </>;
}

export function UsageSkills(props: { data: AvailableUsage }) {
  const skills = createMemo(() => props.data.skills.map(skill => ({ ...skill, attempts: skill.loads + skill.failedLoads }))
    .sort((a, b) => b.attempts - a.attempts));
  return <section class="usage-section">
    <h2>Skill activity</h2><p class="secondary">Ranked by load attempts (loads plus failures). Loads include successful skill tool calls, explicit activations, and each distinct skill attached to a delivered V2 user message. Failed tool calls are counted separately. These counts do not measure skill adherence.</p>
    <Show when={props.data.skills.length} fallback={<p class="secondary">No recorded skill activity in this period.</p>}>
      <RankedCountChart label="Recorded skill load attempts" successLabel="Successful loads" failureLabel="Failed loads"
        rows={skills().map(skill => ({ name: skill.name, success: skill.loads, failure: skill.failedLoads }))}/>
      <UsageTable label="Recorded skill activity" columns={['Skill', 'Load attempts', 'Loads', 'Failures', 'Sessions']} highlights={[0, 1]} rankedBy={0}
        rows={skills().map(skill => ({ id: skill.name, name: () => skill.name, values: [skill.attempts, skill.loads, skill.failedLoads, skill.sessions].map(fmt) }))}/>
    </Show>
  </section>;
}
