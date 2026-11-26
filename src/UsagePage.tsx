import { batch, createEffect, createMemo, createSignal, For, Match, on, onCleanup, onMount, Show, Switch, type ComponentProps, type JSX } from 'solid-js';
import type { MainAgentFilter } from './DelegationTrees';
import type { UsageMeasure } from './UsageCharts';
import { UsageDateRangePicker, UsageDisclosure } from './UsageDateRange';
import { UsageFilters } from './UsageFilters';
import { UsageAgents, UsageModels, UsageOverview, UsageSkills, type SelectedProject, type TimelineControls } from './UsageViews';
import type { Route, UsagePage as UsageSubpage } from './navigation';
import { localDateInput, usageRange, usageRequestUrl, type UsageDateSelection } from './usage-period';
import type { IndexedUsageResponse, UsageIndexState, UsageProject } from './usage-types';
import { usageWarningSummary } from './usage-warnings';

const headings = { overview: 'Overview', agents: 'Agents', models: 'Models', skills: 'Skills' } as const;
const noWarnings: string[] = [];
const statusInterval = 45_000;
const buildInterval = 1_000;
const isBuilding = (index?: UsageIndexState) => index?.state === 'indexing' || index?.state === 'refreshing';
const sourceWarning = 'Couldn’t check for new usage history.';
const legacyWarning = 'New usage may be available. Restart Inspector to turn on automatic updates.';

export function UsagePage(props: { subpage: UsageSubpage; active: boolean; go: (route: Route) => void }) {
  const [dateSelection, setDateSelection] = createSignal<UsageDateSelection>('week');
  const [project, setProject] = createSignal<SelectedProject>();
  const [mainAgent, setMainAgent] = createSignal<MainAgentFilter>();
  let filterButton: HTMLButtonElement | undefined;
  const [measure, setMeasure] = createSignal<UsageMeasure>('tokens');
  const [timelineView, setTimelineView] = createSignal<TimelineControls['view']>('bars');
  const [timelineRole, setTimelineRole] = createSignal<TimelineControls['role']>('all');
  const timeline: TimelineControls = {
    get view() { return timelineView(); }, onViewChange: setTimelineView,
    get role() { return timelineRole(); }, onRoleChange: setTimelineRole,
  };
  const [today, setToday] = createSignal(new Date());
  const [loadedResult, setResult] = createSignal<{ key: string; value: IndexedUsageResponse }>();
  const [availableProjects, setAvailableProjects] = createSignal<UsageProject[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [refresh, setRefresh] = createSignal(0);
  const [retry, setRetry] = createSignal(0);
  const [index, setIndex] = createSignal<UsageIndexState>();
  const [visible, setVisible] = createSignal(false);
  const [legacyServer, setLegacyServer] = createSignal(false);
  const consumedRefreshIntent = { current: 0 };
  let consumedRetry = 0;
  let failedRange: { key: string; retryAfter: number } | undefined;
  function updateDay() {
    const now = new Date();
    if (localDateInput(now) === localDateInput(today())) return false;
    setToday(now);
    return true;
  }
  const range = createMemo(() => usageRange(today(), dateSelection()), undefined, {
    equals: (a, b) => a.from === b.from && a.to === b.to && a.granularity === b.granularity,
  });
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const requestKey = createMemo(() => {
    const { from, to, granularity } = range();
    const params = new URLSearchParams({ from: String(from), to: String(to), timezone });
    if (granularity !== 'day') params.set('granularity', granularity);
    const id = project()?.id;
    if (id) params.set('project', id);
    return params.toString();
  });
  const result = createMemo(() => {
    const loaded = loadedResult();
    return loaded?.key === requestKey() ? loaded.value : undefined;
  });
  const projectOptions = createMemo(() => {
    const options = new Map(availableProjects().map(({ id, name }) => [id, name]));
    const current = project();
    if (current && !options.has(current.id)) options.set(current.id, current.name);
    return Array.from(options, ([id, label]) => ({ id, label }));
  });
  function changeProject(id?: string) {
    const selected = projectOptions().find(option => option.id === id);
    setProject(selected ? { id: selected.id, name: selected.label } : undefined);
  }
  function selectRankedProject(option: UsageProject) {
    filterButton?.focus();
    setProject({ id: option.id, name: option.name });
  }

  onMount(() => {
    const sync = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', sync);
    onCleanup(() => document.removeEventListener('visibilitychange', sync));
    sync();
  });

  createEffect(on([() => props.active, visible, requestKey, refresh, retry], ([active, shown, key, intent, retryIntent]) => {
    if (!active || !shown || document.hidden) return;
    if (failedRange?.key !== key) setError('');
    const controller = new AbortController();
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const params = new URLSearchParams(key);
    const rangeCoolingDown = () => failedRange?.key === key && Date.now() < failedRange.retryAfter;
    const legacyInterval = () => rangeCoolingDown() ? statusInterval : buildInterval;
    // A changed preset key starts this effect again. Don't use the old key
    // (or consume a pending explicit retry/refresh) on the way out.
    const canContinue = () => {
      if (signal.aborted || document.hidden) return false;
      const relative = typeof dateSelection() === 'string';
      return !updateDay() || !relative;
    };
    const loadRange = async (foreground: boolean) => {
      setLoading(foreground && !result());
      if (foreground) setError('');
      try {
        const response = await fetch(usageRequestUrl(params, intent, consumedRefreshIntent), { signal, cache: 'no-store' });
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { message?: unknown } | null;
          throw new Error(typeof body?.message === 'string' ? body.message : `Usage request failed (${response.status}).`);
        }
        const value = await response.json() as IndexedUsageResponse;
        if (signal.aborted) return;
        if (failedRange?.key === key) failedRange = undefined;
        batch(() => {
          setError('');
          setResult({ key, value });
          if (value.status === 'available' || value.status === 'partial') setAvailableProjects(value.projects);
          setIndex(value.index);
        });
      } catch (cause) {
        if (!signal.aborted) {
          failedRange = { key, retryAfter: Date.now() + statusInterval };
          setError(cause instanceof Error ? cause.message : 'Unable to load recorded usage.');
        }
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    };
    const schedule = (poll: () => Promise<void>, interval: number) => {
      if (!signal.aborted && !document.hidden) {
        timer = setTimeout(() => { if (canContinue()) void poll(); }, interval);
      }
    };
    const pollLegacy = async () => {
      await loadRange(false);
      if (isBuilding(index())) schedule(pollLegacy, legacyInterval());
    };
    const checkStatus = async () => {
      let status: UsageIndexState | undefined;
      try {
        const response = await fetch('/api/usage/status', { signal, cache: 'no-store' });
        if (signal.aborted || document.hidden) return;
        if (response.status === 404) {
          setLegacyServer(true);
          if (isBuilding(index())) schedule(pollLegacy, legacyInterval());
          return;
        }
        if (response.ok) status = await response.json() as UsageIndexState;
      } catch { /* A transport error is not an index failure. */ }
      if (signal.aborted || document.hidden) return;
      if (status) {
        batch(() => {
          // A source replacement can invalidate the server's snapshot. Retain
          // old data through refreshes, but not when no snapshot is valid.
          if (status.indexedAt === null && loadedResult()?.value.index.indexedAt) {
            setResult(undefined);
            setAvailableProjects([]);
          }
          setIndex(status);
        });
        const current = result();
        // A worker may already be building again after publication. Reload the
        // published snapshot, but throttle range transport retries even then.
        if (!rangeCoolingDown() && (status.indexedAt !== null
          ? current?.index.indexedAt !== status.indexedAt
          : !current && !isBuilding(status))) await loadRange(false);
      } else if (!result() && !rangeCoolingDown() && !isBuilding(index())) {
        // A status transport failure should not block an ordinary range selection.
        await loadRange(true);
      }
      schedule(checkStatus, status && isBuilding(index()) ? buildInterval : statusInterval);
    };
    onCleanup(() => {
      controller.abort();
      clearTimeout(timer);
      setLoading(false);
    });
    void (async () => {
      if (!canContinue()) return;
      const explicit = intent > consumedRefreshIntent.current || retryIntent !== consumedRetry;
      consumedRetry = retryIntent;
      if (explicit || (!rangeCoolingDown() && (!index() || (!result() && !isBuilding(index()))))) await loadRange(true);
      if (signal.aborted || document.hidden) return;
      if (!legacyServer()) await checkStatus();
      else if (isBuilding(index())) schedule(pollLegacy, legacyInterval());
    })();
  }));

  const warnings = createMemo(() => {
    const value = result();
    if (value?.status !== 'available' && value?.status !== 'partial') return noWarnings;
    return usageWarningSummary(
      value.status === 'partial' ? value.warnings.filter(warning => warning !== value.index.message) : noWarnings,
      value.delegations?.warnings ?? noWarnings,
      props.subpage,
    );
  });
  const usage = createMemo(() => {
    const value = result();
    return value?.status === 'available' || value?.status === 'partial' ? value : undefined;
  });
  const chartPeriod = createMemo(() => {
    const period = range();
    if (dateSelection() !== 'all') return period;
    const firstBucket = usage()?.activity[0]?.date;
    return { ...period, from: firstBucket ? new Date(`${firstBucket}T00:00:00`).getTime() : period.to - 1 };
  });
  const refreshIndex = () => setRefresh(value => value + 1);

  return <div class="usage-page">
    <h1 class="visually-hidden">Usage · {headings[props.subpage]}</h1>
    <UsageControls selection={dateSelection()} range={range()} active={props.active} onChange={selection => batch(() => {
      updateDay();
      setDateSelection(selection);
    })} filters={<UsageFilters options={projectOptions()} selected={project()?.id} onChange={changeProject}
      active={props.active} buttonRef={button => { filterButton = button; }}/>}
      measure={props.subpage === 'skills' ? undefined : measure()} onMeasureChange={setMeasure}
      index={index()} retryIndex={refreshIndex} focusFallback={() => filterButton?.focus({ preventScroll: true })}
      warnings={warnings()} showingUsage={!!usage()} legacyStale={legacyServer() && loadedResult()?.value.index.sourceChanged === true}/>
    <UsageNotices result={result()} index={index()} loading={loading()} error={error()} retry={() => setRetry(value => value + 1)}/>
    <Show when={usage()}>{data => <Switch>
      <Match when={props.subpage === 'overview'}>
        <UsageOverview data={data()} period={chartPeriod()} project={project()} measure={measure()}
          onProjectClick={selectRankedProject} go={props.go}/>
      </Match>
      <Match when={props.subpage === 'agents'}>
        <UsageAgents data={data()} period={chartPeriod()} project={project()} mainAgent={mainAgent()} onMainAgentChange={setMainAgent} measure={measure()} timeline={timeline}/>
      </Match>
      <Match when={props.subpage === 'models'}>
        <UsageModels data={data()} period={chartPeriod()} measure={measure()} timeline={timeline}/>
      </Match>
      <Match when={props.subpage === 'skills'}><UsageSkills data={data()}/></Match>
    </Switch>}</Show>
  </div>;
}

function UsageControls(props: ComponentProps<typeof UsageDateRangePicker> & {
  index?: UsageIndexState; retryIndex: () => void; focusFallback: () => void;
  warnings: string[]; showingUsage: boolean; legacyStale: boolean; filters: JSX.Element;
  measure?: UsageMeasure; onMeasureChange: (measure: UsageMeasure) => void;
}) {
  const building = () => isBuilding(props.index);
  const failed = () => props.index?.state === 'failed';
  const sourceUnknown = () => props.index?.sourceChanged === null;
  const hasWarnings = () => failed() || sourceUnknown() || props.legacyStale || !!props.index?.message || props.warnings.length > 0;
  const progress = () => props.index?.state === 'indexing' ? 'Building usage index' : 'Rebuilding usage index';
  const statusLabel = () => building()
    ? `${progress()}${hasWarnings() ? ' — usage data warnings' : ''}`
    : failed() ? 'Usage index failed — usage data warnings' : 'Usage data warnings';
  function IndexControl() {
    let control!: HTMLDivElement;
    onCleanup(() => {
      if (props.active && control.contains(document.activeElement)) props.focusFallback();
    });
    function FailureDetails(actions: { close: () => void; focusTrigger: () => void }) {
      let retryButton!: HTMLButtonElement;
      onCleanup(() => { if (props.active && document.activeElement === retryButton) actions.focusTrigger(); });
      return <div><strong>Couldn’t update usage data</strong>
        <Show when={props.showingUsage}><p>Showing the last saved usage data.</p></Show>
        <button ref={retryButton} type="button" class="plain-button usage-index-retry" onClick={() => { actions.close(); props.retryIndex(); }}>Retry index build</button>
      </div>;
    }
    return <div ref={control} class="usage-status">
      <UsageDisclosure class="usage-status-disclosure" panelClass="usage-warning-panel" alignEnd scrollFocusable active={props.active}
        label={statusLabel()} title={statusLabel()} summary={<>
          <Show when={building()}><span class="usage-status-spinner" aria-hidden="true"/></Show>
          <Show when={hasWarnings()}><span class="usage-status-warning" aria-hidden="true">!</span></Show>
        </>}>
        {(close, focusTrigger) => <>
          <Show when={building()}><div><strong>{progress()}…</strong>
            <Show when={props.index?.indexedAt}>{time => <p>Showing usage as of {new Date(time()).toLocaleString()} while this finishes.</p>}</Show>
          </div></Show>
          <Show when={failed()}><FailureDetails close={close} focusTrigger={focusTrigger}/></Show>
          <Show when={!failed() && !sourceUnknown() && props.index?.message}><div>New usage couldn’t be loaded.</div></Show>
          <Show when={sourceUnknown()}><div>{sourceWarning}</div></Show>
          <Show when={props.legacyStale}><div>{legacyWarning}</div></Show>
          <Show when={props.warnings.length > 0}><div><strong>Partial usage data</strong>
            <ul><For each={props.warnings}>{warning => <li>{warning}</li>}</For></ul></div></Show>
        </>}
      </UsageDisclosure>
    </div>;
  }

  return <div class="usage-controls">
    <UsageDateRangePicker selection={props.selection} range={props.range} active={props.active} onChange={props.onChange}/>
    {props.filters}
    <Show when={props.measure}>{measure => {
      const label = () => measure() === 'tokens' ? 'Tokens' : 'Steps';
      return <UsageDisclosure class="usage-measure-options" panelClass="usage-measure-menu" active={props.active}
        label={`Usage measure: ${label()}`} summary={<>{label()}<span class="usage-date-chevron" aria-hidden="true"/></>}>
        {close => <div class="usage-toolbar-options">
          <button type="button" aria-pressed={measure() === 'tokens'} onClick={() => { props.onMeasureChange('tokens'); close(); }}>Tokens</button>
          <button type="button" aria-pressed={measure() === 'steps'} onClick={() => { props.onMeasureChange('steps'); close(); }}>Steps</button>
        </div>}
      </UsageDisclosure>;
    }}</Show>
    <Show when={building() || hasWarnings()}><IndexControl/></Show>
  </div>;
}

function UsageNotices(props: {
  result?: IndexedUsageResponse; index?: UsageIndexState; loading: boolean; error: string; retry: () => void;
}) {
  const noSnapshot = () => props.result?.status !== 'available' && props.result?.status !== 'partial';
  return <>
     <Show when={props.loading}><p role="status" class="secondary">Loading recorded usage…</p></Show>
     <Show when={props.error}><div role="alert" class="settings-error surface-card"><p>{props.error}</p><button class="plain-button" onClick={props.retry}>Retry</button></div></Show>
    <Show when={props.index?.state === 'indexing' && noSnapshot()}>
      <div role="status" class="usage-notice surface-card"><h2>Building usage index</h2><p>This one-time initial scan may take several minutes. The app remains responsive while it runs.</p></div>
    </Show>
    <Show when={props.index?.state === 'failed' && noSnapshot()}><div role="alert" class="usage-notice surface-card">
      <h2>Usage unavailable</h2><p>{props.index?.sourceChanged === null
        ? 'Inspector couldn’t read OpenCode’s history.'
        : 'The usage index couldn’t be built. Open the warning menu to retry.'}</p></div></Show>
  </>;
}
