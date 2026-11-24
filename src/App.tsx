import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import Markdown from 'react-markdown';
import type { Category, Entry, Snapshot } from './types';
import { configText } from './display';
import { taskPermission } from './permissions';
import { createBrowserNavigation, home, parseLocation, routePath, routeSection, settingsRoute, usageRoute } from './navigation';
import type { ListState, LocationView, NavigationSection, Route, UsagePage as UsageSubpage } from './navigation';
import type { IndexedUsageResponse, UsageResponse, UsageTokens, UsageCounts } from './usage-types';
import { DelegationTrees } from './DelegationTrees';
import { useInspectorTheme } from './useTheme';
import { agentGroupHelp, agentGroupNames, groupAgents } from './agent-groups';
import { compareContext, formatLimit } from './model-capacity';
import { resolveAgentSettings } from './agent-settings';
import { OverviewChart, RankedCountChart, RankedTokenChart } from './UsageCharts';
import { UsageTimeline, type TimelineRole } from './UsageTimeline';
import { configuredTaskRules, taskDecision } from './task-rules';

const categories: Category[] = ['Instructions', 'Agents', 'Skills', 'Commands', 'Models', 'MCP Servers', 'Plugins'];
const title = (entry: Entry) => entry.category === 'Agents'
  ? entry.name.replace(/(^|[-/])([a-z])/g, (_, separator, letter) => (separator ? ' ' : '') + letter.toUpperCase())
  : entry.name;

const DisclosureContext = createContext<{ view: LocationView; toggle: (key: string, open: boolean) => void; raw: (enabled: boolean) => void } | null>(null);

function RouteLink({ route, choose, children, ...props }: { route: Route; choose: () => void; children: ReactNode } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  return <a {...props} href={routePath(route)} onClick={event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); choose();
  }}>{children}</a>;
}

export function Sidebar({ route, expanded, expand, go, entries, prefix }: {
  route: Route; expanded: NavigationSection | null; expand: (section: NavigationSection | null) => void;
  go: (route: Route) => void; entries: Entry[]; prefix: string;
}) {
  const sections: { name: NavigationSection; links: { label: string; route: Route; count?: number }[] }[] = [
    { name: 'Usage', links: ['Overview', 'Agents', 'Models', 'Skills'].map(label => ({ label, route: { ...usageRoute, subpage: label.toLowerCase() as UsageSubpage } })) },
    { name: 'Config', links: categories.map(category => ({ label: category === 'MCP Servers' ? 'MCP servers' : category, route: { category, id: null }, count: entries.filter(entry => entry.category === category).length })) },
    { name: 'Settings', links: ['General', 'Theme'].map(label => ({ label, route: { ...settingsRoute, subpage: label.toLowerCase() as 'general' | 'theme' } })) },
  ];
  return <nav className="sidebar" aria-label="Main navigation">{sections.map(section => <div className="sidebar-section" key={section.name}>
    <h2><button className="list-row section-toggle" aria-expanded={expanded === section.name} aria-controls={`${prefix}-${section.name}`} data-active={routeSection(route) === section.name || undefined} onClick={() => expand(expanded === section.name ? null : section.name)}>
      <span>{section.name}</span><span className="chevron" aria-hidden="true"/>
    </button></h2>
    <div id={`${prefix}-${section.name}`} className="sidebar-subpages" hidden={expanded !== section.name}>{section.links.map(link => <RouteLink key={link.label} className="list-row" route={link.route} choose={() => go(link.route)} aria-current={link.route.category ? route.category === link.route.category ? 'page' : undefined : routePath(route) === routePath(link.route) ? 'page' : undefined}>
      <span>{link.label}</span>{link.count !== undefined && <span className="secondary">{link.count}</span>}
    </RouteLink>)}</div>
  </div>)}</nav>;
}

function NavigationDrawer({ children, close, opener }: { children: ReactNode; close: () => void; opener: HTMLButtonElement | null }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); opener?.focus(); };
  }, [opener]);
  return <dialog className="navigation-drawer" ref={dialog} aria-label="Navigation" onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="drawer-content"><button className="plain-button drawer-close" onClick={close} autoFocus>Close navigation</button>{children}</div>
  </dialog>;
}

export function App({ initialSnapshot, initialRoute }: { initialSnapshot?: Snapshot; initialRoute?: string }) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [loading, setLoading] = useState(!initialSnapshot);
  const [error, setError] = useState('');
  const [router] = useState(() => typeof window === 'undefined' ? null : createBrowserNavigation(window));
  const [view, setView] = useState(() => {
    if (initialRoute) { const url = new URL(initialRoute, 'http://localhost'); return parseLocation(url.pathname, url.search); }
    return router?.read() || parseLocation('/');
  });
  useEffect(() => {
    if (!router) return;
    const sync = () => setView(router.read());
    const unsubscribe = router.subscribe(sync);
    sync();
    return unsubscribe;
  }, [router]);
  const { category, id, page, subpage } = view.route;
  const isSettings = !view.invalid && page === 'settings';
  const isUsage = !view.invalid && page === 'usage';
  const revision = `${view.invalid}:${page || 'inspector'}:${subpage}:${category}:${id}`;
  const [expanded, setExpanded] = useState<NavigationSection | null>(() => routeSection(view.route) || 'Usage');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const main = useRef<HTMLElement>(null);
  const itemColumn = useRef<HTMLElement>(null);
  const detailPane = useRef<HTMLDivElement>(null);
  const listStates = useRef<Partial<Record<Category, ListState>>>({});
  const previousItems = useRef<Partial<Record<Category, string>>>({});
  const focusedRevision = useRef<string | null>(null);
  const skipRouteFocus = useRef(false);
  useEffect(() => { setExpanded(routeSection(view.route) || 'Usage'); }, [revision]);
  const closeDrawer = () => setDrawerOpen(false);
  const go = (route: Route) => {
    if (drawerOpen && routePath(route) !== routePath(view.route)) skipRouteFocus.current = true;
    router?.go(route, route.category ? listStates.current[route.category] : undefined);
    if (drawerOpen) closeDrawer();
  };
  const saveList = (value: ListState) => {
    if (!category) return;
    listStates.current[category] = value;
    router?.saveList(value);
  };
  const entries = snapshot?.entries || [];
  const items = entries.filter(entry => entry.category === category);
  const selected = items.find(entry => entry.id === id);
  const agentGroups = category === 'Agents' ? groupAgents(items) : undefined;
  const themeState = useInspectorTheme(snapshot?.theme);
  useLayoutEffect(() => {
    if (category && router) listStates.current[category] = router.list();
    if (itemColumn.current?.clientHeight) itemColumn.current.scrollTop = router?.list().scroll || 0;
    if (detailPane.current) detailPane.current.scrollTop = 0;
    else if (main.current) main.current.scrollTop = 0;
  }, [revision, snapshot]);
  useEffect(() => {
    if (focusedRevision.current === revision) return;
    if (category && id !== null) previousItems.current[category] = id;
    // Keep focus in the mobile picker during entry switching, and let drawer
    // unmount cleanup restore its opener without competing route focus.
    if (skipRouteFocus.current || drawerOpen || view.invalid || !category) {
      skipRouteFocus.current = false;
      focusedRevision.current = revision;
      return;
    }
    const previous = previousItems.current[category];
    const item = id === null && previous !== undefined
      ? Array.from(main.current?.querySelectorAll<HTMLAnchorElement>('.item-list a[href]') || [])
        .find(link => link.getAttribute('href') === routePath({ category, id: previous }))
      : undefined;
    const target = item || main.current?.querySelector<HTMLElement>(id === null ? '.item-column h1' : '.detail-heading h1');
    if (target) {
      target.focus({ preventScroll: true });
      focusedRevision.current = revision;
    }
  }, [revision, snapshot]);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/snapshot');
      if (!response.ok) throw new Error('Unable to read the configured directory. Check its path and permissions, then retry.');
      setSnapshot(await response.json());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to connect to the local API.');
    } finally { setLoading(false); }
  }
  useEffect(() => { if (!initialSnapshot) void load(); }, []);

  function chooseItem(entry: Entry) {
    go({ category: entry.category, id: entry.id });
  }

  return <div className="app">
    <header className="toolbar">
      <button className="plain-button menu-button" ref={menuButton} aria-haspopup="dialog" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(true)}>Menu</button>
      <RouteLink className="app-title" aria-label="OpenCode Inspector home" route={home} choose={() => go(home)}>OpenCode Inspector</RouteLink>
      <span className="config-path" title={snapshot?.root}>{snapshot?.root || 'Local configuration'}</span>
    </header>

    <div className="workspace">
      <div className="desktop-sidebar"><Sidebar route={view.invalid ? home : view.route} expanded={expanded} expand={setExpanded} go={go} entries={entries} prefix="desktop"/></div>
      {drawerOpen && <NavigationDrawer close={closeDrawer} opener={menuButton.current}><Sidebar route={view.invalid ? home : view.route} expanded={expanded} expand={setExpanded} go={go} entries={entries} prefix="mobile"/></NavigationDrawer>}
      <main className={category && !view.invalid ? 'detail-pane config-workspace' : 'detail-pane'} data-has-entry={(category && id !== null) || undefined} ref={main} aria-label={isSettings ? 'Settings' : isUsage ? 'Usage' : 'Configuration'}>
        {isUsage ? <UsagePage subpage={subpage as UsageSubpage}/> : isSettings ? <SettingsPage subpage={subpage} themeState={themeState} snapshot={snapshot} loading={loading} error={error} retry={() => void load()}/>
          : error ? <div className="empty-state" role="alert"><h1>Couldn’t load configuration</h1><p>{error}</p><button className="plain-button" onClick={() => void load()}>Try again</button></div>
           : view.invalid ? <div className="empty-state"><h1>Page not found</h1><p>Choose a category or use your browser’s Back button to continue.</p></div>
           : !category ? <div className="empty-state"><h1>Welcome to OpenCode Inspector</h1><p>Choose a section to begin. Usage reads recorded history when you select a Usage page; Config explores your local definitions.</p></div>
           : <>
             <ItemColumn key={category} category={category} items={items} groups={agentGroups} selected={selected} choose={chooseItem} loading={loading} columnRef={itemColumn} query={router?.list().query || ''} onQuery={query => {
               saveList({ query, scroll: itemColumn.current?.scrollTop || 0 });
               setView(router?.read() || view);
             }} onScroll={event => {
               // A mobile detail hides this column; its zero-sized layout must
               // not overwrite the remembered position of the visible list.
               if (event.currentTarget.clientHeight) saveList({ query: router?.list().query || '', scroll: event.currentTarget.scrollTop });
              }}/>
              <div className="config-detail" ref={detailPane}>
                {id !== null && <label className="mobile-item-picker">{category === 'Agents' ? 'Agent' : 'Definition'}
                  <select name="config-item" value={id} onChange={event => {
                    const nextId = event.target.value || null;
                    if (nextId !== null && nextId !== id) skipRouteFocus.current = true;
                    go({ category, id: nextId });
                  }}>
                    <option value="">{category === 'Agents' ? 'Choose an agent…' : 'Choose a definition…'}</option>
                    {!selected && <option value={id} disabled>{loading ? 'Reading configuration…' : 'Unavailable definition'}</option>}
                    {items.map(entry => <option key={entry.id} value={entry.id}>{title(entry)}</option>)}
                  </select>
                </label>}
                <div key={revision}>
                  {id === null ? <p className="empty-state">Choose a definition from {category.toLowerCase()} to view its details.</p>
                    : !selected ? <div className="empty-state">{loading ? <p>Reading configuration…</p> : <><h1>Definition not found</h1><p>This definition is no longer available.</p></>}</div>
                      : <DisclosureContext.Provider value={{ view, toggle: (key, open) => router?.disclosure(key, open), raw: enabled => router?.raw(enabled) }}><EntryDetail key={`${category}:${id}`} entry={selected} entries={entries} choose={chooseItem}/></DisclosureContext.Provider>}
               </div>
             </div>
           </>}
      </main>
    </div>
  </div>;
}

type Period = 'day' | 'week' | 'month';
export function usageRange(date: Date, period: Period) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (period === 'week') start.setDate(start.getDate() - 6);
  if (period === 'month') start.setDate(1);
  const end = new Date(start);
  if (period === 'day') end.setDate(end.getDate() + 1);
  else if (period === 'week') end.setDate(end.getDate() + 7);
  else end.setMonth(end.getMonth() + 1);
  return { from: start.getTime(), to: end.getTime() };
}

export function usageRequestUrl(params: URLSearchParams, intent: number, consumed: { current: number }) {
  const request = new URLSearchParams(params);
  if (intent > consumed.current) {
    consumed.current = intent;
    request.set('refresh', '1');
  }
  return `/api/usage?${request}`;
}

function UsagePage({ subpage }: { subpage: UsageSubpage }) {
  const [period, setPeriod] = useState<Period>('week');
  const [timelineView, setTimelineView] = useState<'bars' | 'lines'>('bars');
  const [timelineMetric, setTimelineMetric] = useState<'tokens' | 'sessions' | 'steps'>('tokens');
  const [timelineRole, setTimelineRole] = useState<TimelineRole>('all');
  const [anchor, setAnchor] = useState(() => new Date());
  const [loadedResult, setResult] = useState<IndexedUsageResponse>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [retry, setRetry] = useState(0);
  const consumedRefreshIntent = useRef(0);
  const range = usageRange(anchor, period);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const granularity = period === 'day' ? 'hour' : 'day';
  const result = loadedResult && (!('range' in loadedResult) || (loadedResult.range.from === range.from && loadedResult.range.to === range.to && loadedResult.range.timezone === timezone && (loadedResult.range.granularity ?? 'day') === granularity)) ? loadedResult : undefined;
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true); setError('');
    const params = new URLSearchParams({ from: String(range.from), to: String(range.to), timezone });
    if (granularity === 'hour') params.set('granularity', granularity);
    let first = true;
    const poll = async () => {
      try {
        const response = await fetch(usageRequestUrl(params, refresh, consumedRefreshIntent), { signal: controller.signal });
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { message?: unknown } | null;
          throw new Error(typeof body?.message === 'string' ? body.message : `Usage request failed (${response.status}).`);
        }
        const value = await response.json() as IndexedUsageResponse;
        if (controller.signal.aborted) return;
        setResult(value);
        const active = value.index.state === 'indexing' || value.index.state === 'refreshing';
        setRefreshing(value.index.state === 'refreshing');
        if (active) timer = setTimeout(() => void poll(), 1000);
      } catch (cause) {
        if (!controller.signal.aborted) {
          setRefreshing(false);
          setError(cause instanceof Error ? cause.message : 'Unable to load recorded usage.');
        }
      } finally {
        if (first) { first = false; if (!controller.signal.aborted) setLoading(false); }
      }
    };
    void poll();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [range.from, range.to, timezone, granularity, refresh, retry]);
  const move = (direction: number) => setAnchor(current => {
    const next = new Date(current);
    if (period === 'day') next.setDate(next.getDate() + direction);
    else if (period === 'week') next.setDate(next.getDate() + 7 * direction);
    else { next.setDate(1); next.setMonth(next.getMonth() + direction); }
    return next;
  });
  const current = () => { setAnchor(new Date()); };
  const fmt = (value: number) => value.toLocaleString('en-US');
  const dateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const rangeText = period === 'month'
    ? new Date(range.from).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    : dateFormatter.formatRange(new Date(range.from), new Date(range.to - 1));
  const anchorDate = `${anchor.getFullYear()}-${String(anchor.getMonth() + 1).padStart(2, '0')}-${String(anchor.getDate()).padStart(2, '0')}`;
  const isCurrentPeriod = usageRange(new Date(), period).from === range.from;
  const hasNewHistory = result?.index.sourceChanged === true && !refreshing;
  const knownCurrent = result?.index.sourceChanged === false && !refreshing;
  const delegationWarnings = subpage === 'agents' && result && 'delegations' in result ? result.delegations?.warnings ?? [] : [];
  const warnings = result?.status === 'partial' ? result.warnings.filter(warning => !delegationWarnings.includes(warning)) : [];
  const renderTokens = (tokens: UsageTokens) => <dl className="usage-token-grid">{([['Input', tokens.input], ['Output', tokens.output], ['Reasoning', tokens.reasoning], ['Cache read', tokens.cacheRead], ['Cache write', tokens.cacheWrite], ['Total', tokens.total]] as const).map(([label, value]) => <div className="surface-card" key={label}><dt>{label}</dt><dd>{fmt(value)}</dd></div>)}</dl>;
  const renderCounts = (counts: UsageCounts) => <><dl className="usage-count-grid">{([['Active root sessions', counts.activeSessions], ['New root sessions', counts.newSessions], ['Subagent sessions', counts.subagentSessions], ['Assistant steps', counts.steps]] as const).map(([label, value]) => <div className="surface-card" key={label}><dt>{label}</dt><dd>{fmt(value)}</dd></div>)}</dl>{renderTokens(counts.tokens)}</>;
  return <div className="usage-page">
    <div className="usage-heading"><h1>Usage · {subpage === 'agents' ? 'Agents' : subpage === 'models' ? 'Models' : subpage === 'skills' ? 'Skills' : 'Overview'}</h1>
      <p className="usage-metadata">{timezone} · <span title="Indexed source snapshot">{result?.index.indexedAt ? `Indexed ${new Date(result.index.indexedAt).toLocaleString()}` : 'Index date unavailable'}</span></p>
    </div>
    <div className="usage-controls">
      <div className="usage-period-switch" role="group" aria-label="Calendar period">{(['day', 'week', 'month'] as const).map(value => <button key={value} aria-pressed={period === value} onClick={() => setPeriod(value)}>{value === 'week' ? '7 days' : value[0].toUpperCase() + value.slice(1)}</button>)}</div>
      <div className="usage-range-navigation" role="group" aria-label={`${period} navigation`}>
        <button className="plain-button" onClick={() => move(-1)} aria-label={`Previous ${period}`} title={`Previous ${period}`}><span aria-hidden="true">‹</span></button>
        <span className="usage-range-label" aria-live="polite">{rangeText}</span>
        <button className="plain-button" onClick={() => move(1)} aria-label={`Next ${period}`} title={`Next ${period}`}><span aria-hidden="true">›</span></button>
      </div>
      <button className="plain-button" onClick={current} disabled={isCurrentPeriod}>{period === 'day' ? 'Today' : period === 'week' ? 'Last 7 days' : 'This month'}</button>
      <label className="usage-date-jump"><span className="visually-hidden">Jump to date</span><input type="date" aria-label="Jump to date" title={period === 'week' ? 'Choose the last day of the seven-day range' : 'Choose any date to view its calendar period'} value={anchorDate} onChange={event => {
        if (!event.target.value) return;
        const [year, month, day] = event.target.value.split('-').map(Number);
        const date = new Date(0); date.setFullYear(year, month - 1, day); date.setHours(0, 0, 0, 0);
        if (Number.isFinite(date.getTime())) setAnchor(date);
      }}/></label>
      <div className="usage-refresh-controls">
        <button className="plain-button usage-refresh" data-source-state={knownCurrent ? 'current' : hasNewHistory ? 'changed' : 'unknown'} title={hasNewHistory ? 'New history available. Refresh to rebuild the index.' : knownCurrent ? 'No new source history detected. Refresh to rebuild the index anyway.' : undefined} onClick={() => { setRefreshing(true); setRefresh(value => value + 1); }} disabled={loading || refreshing}>{refreshing ? 'Rebuilding index…' : hasNewHistory ? 'Refresh available' : 'Refresh'}{hasNewHistory && <><span className="usage-refresh-dot" aria-hidden="true"/><span className="visually-hidden"> — new history available</span></>}</button>
        {(warnings.length > 0 || delegationWarnings.length > 0) && <details className="usage-warnings" onKeyDown={event => {
          if (event.key === 'Escape' && event.currentTarget.open) {
            event.currentTarget.open = false;
            event.currentTarget.querySelector('summary')?.focus();
          }
        }}>
          <summary className="plain-button" title="Usage data warnings"><span aria-hidden="true">!</span><span className="visually-hidden">Usage data warnings</span></summary>
          <div className="usage-warning-panel surface-card">
            {warnings.length > 0 && <div><strong>Partial usage data</strong>
              <ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
            {delegationWarnings.length > 0 && <div><strong>Delegation data warnings</strong>
              <ul>{delegationWarnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
          </div>
        </details>}
      </div>
    </div>
    {loading && <p role="status" className="secondary">Loading recorded usage…</p>}
    {error && <div role="alert" className="settings-error surface-card"><p>{error}</p><button className="plain-button" onClick={() => setRetry(value => value + 1)}>Retry</button></div>}
    {result?.index.state === 'indexing' && result.status === 'indexing' && <div role="status" className="usage-notice surface-card"><h2>Building usage index</h2><p>This one-time initial scan may take several minutes. The app remains responsive while it runs.</p></div>}
    {result?.index.state === 'refreshing' && <div role="status" className="usage-notice surface-card"><strong>Rebuilding index…</strong><p>Showing the previous snapshot from {result.index.indexedAt ? new Date(result.index.indexedAt).toLocaleString() : 'an unknown date'} until the refresh completes.</p></div>}
    {result?.status !== 'partial' && result?.index.sourceChanged === null && <p className="usage-notice surface-card">The source history could not be checked for changes.</p>}
    {result?.status !== 'partial' && result?.index.state === 'failed' && <div role="alert" className="usage-notice surface-card"><h2>Index build failed</h2><p>{result.index.message || 'The usage index could not be built.'}</p><button className="plain-button" onClick={() => { setRefreshing(true); setRefresh(value => value + 1); }}>Retry</button></div>}
    {result?.status === 'unavailable' && <div role="status" className="usage-notice surface-card"><h2>Usage unavailable</h2><p>{result.message}</p><button className="plain-button" onClick={() => { setRefreshing(true); setRefresh(value => value + 1); }}>Build index</button></div>}
    {result && result.status !== 'unavailable' && result.status !== 'indexing' && <>
       {subpage === 'models' && <section className="usage-section">
         <h2>Per-model usage</h2>
          <p className="secondary">Recorded provider and model identities only. Sessions include roots and children and may appear under multiple models. Title, compaction, and session generation have no recorded model identity and count as Unknown with zero steps. Token categories are disjoint; total is their sum.</p>
            <UsageTimeline activity={result.modelActivity} from={range.from} to={range.to} granularity={granularity} view={timelineView} onViewChange={setTimelineView} metric={timelineMetric} onMetricChange={setTimelineMetric} role={timelineRole} onRoleChange={setTimelineRole}/>
          {result.models.length > 0 && <RankedTokenChart rows={[...result.models].sort((a, b) => b.tokens.total - a.tokens.total).map(model => ({ label: `${model.provider ?? 'Unknown'} / ${model.model ?? 'Unknown'}`, tokens: model.tokens }))}/>}
        {result.models.length ? <div className="usage-table-wrap"><table className="technical-table usage-model-table" aria-label="Per-model usage">
          <thead><tr>{['Provider', 'Model', 'Sessions', 'Steps', 'Input', 'Output', 'Reasoning', 'Cache read', 'Cache write', 'Total'].map(col => <th key={col}>{col}</th>)}</tr></thead>
          <tbody>{result.models.map(model => <tr key={JSON.stringify([model.provider, model.model])}>
            <td data-label="Provider">{model.provider ?? 'Unknown'}</td><th scope="row" data-label="Model">{model.model ?? 'Unknown'}</th>
            {[model.sessions, model.steps, model.tokens.input, model.tokens.output, model.tokens.reasoning, model.tokens.cacheRead, model.tokens.cacheWrite, model.tokens.total].map((n, i) => <td data-label={['Sessions','Steps','Input','Output','Reasoning','Cache read','Cache write','Total'][i]} key={i}>{fmt(n)}</td>)}
          </tr>)}</tbody>
        </table></div> : <p className="secondary">No model usage recorded in this period.</p>}
      </section>}
       {subpage === 'overview' && <><section className="usage-section"><h2>Period summary</h2>{renderCounts(result.summary)}</section>
       <section className="usage-section"><h2>Daily recorded token totals</h2><OverviewChart activity={result.activity} from={result.range.from} to={result.range.to}/></section>
      <section className="usage-section"><h2>Daily activity</h2>{result.activity.length ? <div className="usage-table-wrap"><table className="technical-table" aria-label="Daily usage activity"><thead><tr>{['Date', 'Active roots', 'New roots', 'Subagents', 'Steps', 'Input', 'Output', 'Reasoning', 'Cache read', 'Cache write', 'Total'].map(col => <th key={col}>{col}</th>)}</tr></thead><tbody>{result.activity.map(day => <tr key={day.date}><th scope="row" data-label="Date">{day.date}</th>{[day.activeSessions, day.newSessions, day.subagentSessions, day.steps, day.tokens.input, day.tokens.output, day.tokens.reasoning, day.tokens.cacheRead, day.tokens.cacheWrite, day.tokens.total].map((n, i) => <td data-label={['Active roots','New roots','Subagents','Steps','Input','Output','Reasoning','Cache read','Cache write','Total'][i]} key={i}>{fmt(n)}</td>)}</tr>)}</tbody></table></div> : <p className="secondary">No recorded activity in this period.</p>}</section>
      </>}
       {subpage === 'agents' && <>
         <section className="usage-section"><h2>Agent usage over time</h2>
            <UsageTimeline activity={result.agentActivity} from={range.from} to={range.to} granularity={granularity} kind="agent" view={timelineView} onViewChange={setTimelineView} metric={timelineMetric} onMetricChange={setTimelineMetric} role={timelineRole} onRoleChange={setTimelineRole}/>
         </section>
         <section className="usage-section" aria-label="Delegation trees"><DelegationTrees delegations={result.delegations}/></section>
         <section className="usage-section">
           <h2>Agent totals</h2>
           <p className="secondary">Totals for all agents across the selected period.</p>
           {result.agents.length ? <div className="usage-table-wrap"><table className="technical-table" aria-label="Agent totals">
             <thead><tr>{['Agent', 'Sessions', 'Steps', 'Input', 'Output', 'Reasoning', 'Cache read', 'Cache write', 'Total'].map(col => <th key={col}>{col}</th>)}</tr></thead>
             <tbody>{result.agents.map(agent => <tr key={agent.name}>
               <th scope="row" data-label="Agent">{agent.name}</th>
               {[agent.sessions, agent.steps, agent.tokens.input, agent.tokens.output, agent.tokens.reasoning, agent.tokens.cacheRead, agent.tokens.cacheWrite, agent.tokens.total].map((n, i) => <td data-label={['Sessions', 'Steps', 'Input', 'Output', 'Reasoning', 'Cache read', 'Cache write', 'Total'][i]} key={i}>{fmt(n)}</td>)}
             </tr>)}</tbody>
           </table></div> : <p className="secondary">No agent usage recorded in this period.</p>}
         </section>
       </>}
       {subpage === 'skills' && <section className="usage-section"><h2>Skill activity</h2><p className="secondary">Loads include successful skill tool calls, explicit activations, and each distinct skill attached to a delivered V2 user message. Failed tool calls are counted separately. These counts do not measure skill adherence.</p>{result.skills.length > 0 && <RankedCountChart label="Recorded skill load attempts" successLabel="Successful loads" failureLabel="Failed loads" rows={[...result.skills].sort((a, b) => b.loads + b.failedLoads - a.loads - a.failedLoads).map(skill => ({ name: skill.name, success: skill.loads, failure: skill.failedLoads }))}/ >}{result.skills.length ? <div className="usage-table-wrap"><table className="technical-table" aria-label="Recorded skill activity"><thead><tr><th>Skill</th><th>Loads</th><th>Failures</th><th>Sessions</th></tr></thead><tbody>{result.skills.map(skill => <tr key={skill.name}><th scope="row" data-label="Skill">{skill.name}</th><td data-label="Loads">{fmt(skill.loads)}</td><td data-label="Failures">{fmt(skill.failedLoads)}</td><td data-label="Sessions">{fmt(skill.sessions)}</td></tr>)}</tbody></table></div> : <p className="secondary">No recorded skill activity in this period.</p>}</section>}
    </>}
  </div>;
}

function SettingsPage({ subpage, themeState, snapshot, loading, error, retry }: {
  subpage?: Route['subpage']; themeState: ReturnType<typeof useInspectorTheme>; snapshot?: Snapshot; loading: boolean; error: string; retry: () => void;
}) {
  const theme = snapshot?.theme;
  const { preferences, updatePreferences, applied, storageFailed } = themeState;
  const themeOptions = theme?.palettes || [];
  const knownOverride = ['follow', 'inspector:default', 'builtin:system', ...themeOptions.map(option => option.id)].includes(preferences.theme);
  return <div className="settings-page">
    <h1>Settings · {subpage === 'theme' ? 'Theme' : 'General'}</h1>
    <p className="secondary">{subpage === 'theme' ? 'Preferences for this browser. Your OpenCode configuration is unchanged.' : 'Read-only information about your local OpenCode configuration.'}</p>
    {loading && <p className="secondary" role="status">{subpage === 'theme' ? 'Reading configured theme and available palettes…' : 'Reading configuration…'}</p>}
    {error && <div className="settings-error surface-card" role="alert"><p>{error} Configured theme information may be unavailable or out of date.</p><button className="plain-button" onClick={retry}>Try again</button></div>}
    {subpage === 'theme' ? <><fieldset className="appearance-controls surface-card">
      <legend>Appearance</legend>
      <label>Theme<select name="inspector-theme" value={preferences.theme} onChange={event => updatePreferences({ ...preferences, theme: event.target.value })}>
        <option value="follow">Follow OpenCode</option>
        <option value="inspector:default">Inspector default</option>
        <option value="builtin:system">System (browser approximation)</option>
        {themeOptions.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
        {!knownOverride && <option value={preferences.theme}>Unavailable override</option>}
      </select></label>
      <label>Color mode<select name="inspector-color-mode" value={preferences.mode} onChange={event => updatePreferences({ ...preferences, mode: event.target.value as typeof preferences.mode })}>
        <option value="auto">{preferences.theme === 'follow' ? 'Auto (follow or browser)' : 'Auto (browser)'}</option><option value="light">Light</option><option value="dark">Dark</option>
      </select></label>
      <p className="appearance-status">{applied.label} · {applied.mode}<br/><span className="secondary">{applied.source}</span></p>
      {applied.palette && <p className="secondary">Palette: {applied.palette.source}</p>}
      {applied.note && <p className="secondary">{applied.note}</p>}
      {storageFailed && <p className="secondary">Browser storage is unavailable. This override lasts for the current page only.</p>}
    </fieldset>
    <p className="secondary">Theme overrides affect only this Inspector browser. Follow reads configured CLI settings first for the global root and falls back to legacy TUI preferences only when CLI settings are absent. Auto honors an explicit CLI light or dark mode when following; otherwise it uses your browser’s color scheme. Desktop has separate browser storage and its preferences are not inspected.</p>
    <p className="secondary">System is a browser approximation using Inspector colors and browser color-mode detection. It cannot reproduce the terminal palette or terminal transparency.</p>
    {theme?.warnings.map((warning, index) => <p className="secondary" key={index}>{warning}</p>)}
    </> : <section className="settings-information surface-card">
      <h2>Configuration information{snapshot?.warnings.length ? ` · ${snapshot.warnings.length} notices` : ''}</h2>
      <dl className="source-paths"><dt>Config root</dt><dd><code>{snapshot?.root || 'Connecting…'}</code></dd><dt>Real path</dt><dd><code>{snapshot?.realpath || 'Unknown'}</code></dd></dl>
      <p className="secondary">Read-only, static inspection of local configuration. Runtime defaults and availability are not verified. Secrets are masked with best-effort redaction; paths remain visible. Inspect before sharing. No telemetry.</p>
      {snapshot?.warnings.map((warning, index) => <p className="secondary" key={index}>{warning}</p>)}
    </section>}
  </div>;
}

export function ItemColumn({ category, items, groups, selected, choose, loading, query = '', onQuery, columnRef, onScroll }: {
  category: Category; items: Entry[]; groups?: ReturnType<typeof groupAgents>; selected?: Entry; choose: (entry: Entry) => void; loading: boolean;
  query?: string; onQuery?: (query: string) => void; columnRef?: RefObject<HTMLElement | null>; onScroll?: React.UIEventHandler<HTMLElement>;
}) {
  const showSearch = items.length > 12;
  const activeQuery = showSearch ? query : '';
  const filtered = items.filter(entry => `${entry.name} ${entry.id} ${entry.description}`.toLowerCase().includes(activeQuery.toLowerCase()));
  return <section className="item-column" aria-label={`${category} list`} ref={columnRef} onScroll={onScroll}>
    <h1 tabIndex={-1}>{category}</h1>
    {showSearch && <label className="filter-label">Filter {category.toLowerCase()}
      <input type="search" name="filter" value={query} onChange={event => onQuery?.(event.target.value)}/>
    </label>}
    <div className="item-list">
      {groups ? agentGroupNames.map(group => {
        const groupItems = (groups.get(group) || []).filter(entry => filtered.includes(entry));
        return groupItems.length ? <div className="agent-group" key={group}><h2 title={agentGroupHelp}>{group}</h2>
          {groupItems.map(entry => <RouteLink className="list-row" key={`${group}-${entry.id}`} aria-current={selected?.id === entry.id ? 'page' : undefined} route={{ category: entry.category, id: entry.id }} choose={() => choose(entry)}>{title(entry)}</RouteLink>)}
        </div> : null;
      }) : filtered.map(entry => <RouteLink className="list-row" key={entry.id} aria-current={selected?.id === entry.id ? 'page' : undefined} route={{ category: entry.category, id: entry.id }} choose={() => choose(entry)}>{title(entry)}</RouteLink>)}
      {!filtered.length && <p className="list-message secondary">{loading ? 'Reading configuration…' : activeQuery ? 'No matches.' : 'No configured definitions.'}</p>}
    </div>
  </section>;
}

function Section({ label, section, children }: { label: string; section: string; children: ReactNode }) {
  const disclosure = useContext(DisclosureContext);
  return <details className="disclosure" data-section={section} open={disclosure ? disclosure.view.open.includes(section) : undefined} onToggle={event => {
    // A queued native toggle from a detached entry must not update its successor.
    if (event.currentTarget.isConnected) disclosure?.toggle(section, event.currentTarget.open);
  }}><summary>{label}</summary><div className="section-content">{children}</div></details>;
}

export function EntryDetail({ entry, entries, choose }: { entry: Entry; entries: Entry[]; choose: (entry: Entry) => void }) {
  const [localRaw, setLocalRaw] = useState(false);
  const disclosure = useContext(DisclosureContext);
  const rawPrompt = disclosure?.view.raw ?? localRaw;
  const setRawPrompt = disclosure?.raw ?? setLocalRaw;
  const candidates = entries.filter(candidate => candidate.category === 'Agents' && candidate.id !== entry.id && candidate.data.hidden !== true
    && (candidate.data.mode === 'all' || candidate.data.mode === 'subagent'
      || candidate.data.mode === undefined && ['general', 'explore'].includes(candidate.id))
    && (typeof candidate.data.disabled === 'boolean' ? candidate.data.disabled : candidate.data.disable) !== true)
    .map(candidate => ({ entry: candidate, ...taskPermission(entry.data.effectivePermission, candidate.id) }));
  const accessible = candidates.filter(candidate => candidate.action === 'allow' || candidate.action === 'ask');
  const promptLabel = entry.category === 'Instructions' ? 'Instructions' : 'Prompt';
  const promptSizeLabel = entry.promptSize ? `~${entry.promptSize.count.toLocaleString('en-US')} tokens` : 'Token estimate unavailable';

  return <article className="entry-detail">
    <header className="detail-heading"><h1 tabIndex={-1}>{title(entry)}</h1></header>
    {entry.category === 'Agents' && <AgentOverview entry={entry} entries={entries} accessible={accessible} choose={choose}/>}
    <div className="detail-sections">
    {entry.category !== 'Agents' && entry.description && <Section section="about" label="About"><p>{entry.description}</p></Section>}
    {entry.category === 'Agents' && <>
      <Section section="model-settings" label="Model & settings"><ModelSettings entry={entry} models={entries.filter(candidate => candidate.category === 'Models')}/></Section>
      <Section section="subagents" label={`Subagents (${accessible.length})`}>
        <p className="secondary">The last configured match in the inspected files wins; no match is unknown here. Shows known subagent candidates only, excluding self, hidden, disabled and primary-only agents. Unspecified runtime eligibility and task availability remain unknown; policies and approvals are not evaluated.</p>
        <TechnicalTable label="Subagent rule resolution" columns={['Agent', 'Decision', 'Matching rule']} rows={candidates.map(candidate => [
          <RouteLink route={{ category: candidate.entry.category, id: candidate.entry.id }} choose={() => choose(candidate.entry)}>{title(candidate.entry)}</RouteLink>,
          candidate.action === 'ask' ? 'ask — Requires approval' : taskDecision(candidate.action),
          <code>{candidate.rule}</code>,
        ])}/>
        {!candidates.length && <p className="secondary">No known candidate agents.</p>}
        <Section section="task-rules" label="Configured task rules">
          <TechnicalTable label="Configured task rules in matching order" columns={['Order', 'Pattern', 'Action']} rows={configuredTaskRules(entry.data.effectivePermission).map((rule, index) => [index + 1, <code>{rule.pattern}</code>, rule.action])}/>
          {!configuredTaskRules(entry.data.effectivePermission).length && <p className="secondary">No valid configured task rule list.</p>}
        </Section>
      </Section>
    </>}
    {(entry.category === 'Agents' || entry.category === 'Commands' || entry.category === 'Skills' || entry.category === 'Instructions' || entry.prompt) && <Section section={entry.category === 'Instructions' ? 'instructions' : 'prompt'} label={entry.category === 'Agents' ? promptLabel : `${promptLabel} · ${promptSizeLabel}`}>
      {entry.prompt ? <>
        {entry.category !== 'Agents' && entry.promptSize && <p className="secondary">Estimated from the local text with o200k_base. The selected model’s token count may differ.</p>}
        <button className="plain-button prompt-toggle" aria-pressed={rawPrompt} onClick={() => setRawPrompt(!rawPrompt)}>{rawPrompt ? 'Show Markdown' : 'Show raw text'}</button>
        {rawPrompt ? <pre>{entry.prompt}</pre> : <div className="markdown"><Markdown components={{
          img: () => <span className="secondary">[External image not loaded]</span>,
          a: ({ children }) => <span className="document-link">{children}</span>,
        }}>{entry.prompt}</Markdown></div>}
      </> : <p className="secondary">{entry.category === 'Instructions' ? 'No local instruction text is available. URLs, globs, and substitutions are not resolved.' : 'No local prompt body is available. Built-in prompts and file substitutions are not resolved.'}</p>}
    </Section>}
    {entry.category === 'Models' && <Section section="context-limits" label="Context limits"><ContextLimits model={entry}/></Section>}
    {entry.category === 'MCP Servers' && Object.keys(entry.data.configuredTimeout || {}).length > 0 && <>
      <p className="secondary">Configured timeouts combine values in the inspected files with server-specific overrides. Runtime defaults are not shown.</p>
      <TechnicalTable label="Configured MCP timeouts" columns={['Purpose', 'Milliseconds']} rows={
        Object.entries(entry.data.configuredTimeout).map(([key, value]) => [key, <code>{formatLimit(value)}</code>])}/>
    </>}
    <Section section="sources" label="Sources">
      {entry.sources.map((source, index) => <div className="source" key={`${source.path}-${index}`}>
        <p>{source.kind}{source.path !== source.realpath ? ' · Symlink resolved' : ''}</p>
        <dl className="source-paths"><dt>Source path</dt><dd><code>{source.path}</code></dd><dt>Real path</dt><dd><code>{source.realpath}</code></dd></dl>
      </div>)}
      {!!Object.keys(entry.provenance).length && <Section section="provenance" label="Value provenance"><dl className="provenance">
        {Object.entries(entry.provenance).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}
      </dl></Section>}
    </Section>
    <Section section="raw-configuration" label="Raw configuration"><Json value={entry.data}/></Section>
    </div>
  </article>;
}

function AgentOverview({ entry, entries, accessible, choose }: {
  entry: Entry; entries: Entry[]; accessible: (ReturnType<typeof taskPermission> & { entry: Entry })[];
  choose: (entry: Entry) => void;
}) {
  const { model, modelLabel, reasoningLabel, reasoningSource } = resolveAgentSettings(entry, entries);
  const context = model?.data.limit?.context;
  const capped = compareContext(context, model?.modelCapacity?.context) === 'lower';
  return <section className="agent-overview" aria-label="Agent overview">
    <div className="overview-description">
      <p className="overview-about" aria-label="About">{entry.description || 'No local description available.'}</p>
    </div>
    <dl className="overview-facts">
      <div className="surface-card overview-model"><dt>Model</dt><dd>{model
        ? <RouteLink route={{ category: 'Models', id: model.id }} choose={() => choose(model)}>{modelLabel}</RouteLink>
        : modelLabel}</dd></div>
      <div className="surface-card overview-reasoning"><dt>Reasoning variant</dt><dd title={reasoningSource}><span className="reasoning-value">{reasoningLabel}</span><span className="secondary">{reasoningSource}</span></dd></div>
      <div className="surface-card overview-context"><dt>Context limit</dt><dd><span className="overview-number">{formatLimit(context)}</span><span className="secondary" title={capped ? `Configured limit below published capacity of ${formatLimit(model?.modelCapacity?.context)} tokens. See Model & settings for provenance.` : 'Configured provider model context limit; runtime support is unknown.'}>{capped ? 'Configured · Capped' : context === undefined ? 'Not configured' : 'Configured'}</span></dd></div>
      <div className="surface-card overview-prompt"><dt>Prompt length</dt><dd title="Estimated with o200k_base from the original configured local prompt before redaction. Excludes runtime instructions, tools and conversation; model tokenization may differ."><span className={`overview-number${entry.promptSize ? '' : ' unavailable'}`}>{entry.promptSize ? `~${entry.promptSize.count.toLocaleString('en-US')}` : 'Not available'}</span>{entry.promptSize && <span className="overview-unit"> tokens</span>}<span className="secondary">{entry.promptSize ? 'Estimated · local prompt' : entry.prompt ? 'Local estimate unavailable' : 'Built-in prompt unknown'}</span></dd></div>
    </dl>
    <div className="overview-subagents">
      <span className="secondary">Subagents ({accessible.length})</span>
      {accessible.length ? <ul>{accessible.map(candidate => <li key={candidate.entry.id}>
        <RouteLink route={{ category: candidate.entry.category, id: candidate.entry.id }} choose={() => choose(candidate.entry)} aria-label={candidate.action === 'ask' ? `${title(candidate.entry)} — requires approval` : undefined} title={candidate.action === 'ask' ? 'Requires approval' : undefined}>{title(candidate.entry)}</RouteLink>
      </li>)}</ul> : <span className="secondary">None known allowed or requiring approval</span>}
    </div>
  </section>;
}

function Json({ value }: { value: unknown }) {
  return <pre>{JSON.stringify(value, null, 2)}</pre>;
}

function TechnicalTable({ label, columns, rows }: { label: string; columns: string[]; rows: ReactNode[][] }) {
  return <table role="table" className="technical-table" aria-label={label}>
    <thead role="rowgroup"><tr role="row">{columns.map(column => <th role="columnheader" scope="col" key={column}>{column}</th>)}</tr></thead>
    <tbody role="rowgroup">{rows.map((row, index) => <tr role="row" key={index}>{row.map((cell, column) => column === 0
      ? <th role="rowheader" scope="row" data-label={columns[column]} key={column}>{cell}</th>
      : <td role="cell" data-label={columns[column]} key={column}>{cell}</td>)}</tr>)}</tbody>
  </table>;
}

function ModelSettings({ entry, models }: { entry: Entry; models: Entry[] }) {
  const { model, modelLabel, variant, variantSource, reasoning, reasoningSource } = resolveAgentSettings(entry, models);
  const settings = [
    { label: 'Model', value: modelLabel, source: entry.provenance.model || 'Unknown · not configured' },
    { label: 'Reasoning', value: configText(reasoning), source: reasoningSource },
    { label: 'Variant', value: configText(variant ?? entry.data.variant), source: variantSource || 'Unknown · not configured' },
    { label: 'Mode', value: configText(entry.data.mode), source: entry.provenance.mode || 'Unknown · not configured' },
  ];
  return <TechnicalTable label="Model and settings" columns={['Setting', 'Value', 'Source']} rows={[
    ...settings.map(setting => [setting.label, <code>{setting.value}</code>, setting.source]),
    ...contextRows(model),
  ]}/>;
}

function contextRows(model?: Entry): ReactNode[][] {
  const configured = model?.data.limit?.context;
  const capacity = model?.modelCapacity;
  const comparison = compareContext(configured, capacity?.context);
  const source = (key: string) => model?.data.limit?.[key] === undefined ? 'Unknown · not configured' : 'Configured · provider model';
  return [
    ['Configured context', <code>{formatLimit(configured)}</code>, source('context')],
    ['Model capacity', <code>{formatLimit(capacity?.context)}</code>, capacity ? <>Published catalogue · <code>{capacity.provider}/{capacity.model}</code><br/><a href="https://models.dev/api.json" target="_blank" rel="noreferrer">Models.dev</a> · checked {capacity.source.checked}. Published context capacity, not a guarantee of runtime support. Offline snapshot.</> : 'No verified exact match in the bundled catalogue'],
    ...['input', 'output'].map(key => [`Configured ${key}`, <code>{formatLimit(model?.data.limit?.[key])}</code>, source(key)]),
    ['Cap status', comparison === 'lower' ? 'Capped below model capacity' : comparison === 'greater' ? 'Configured context exceeds published model capacity' : comparison === 'equal' ? 'Matches published capacity' : 'Unknown', 'Configured vs published context comparison. Runtime support and enforcement are unknown.'],
  ];
}

function ContextLimits({ model }: { model?: Entry }) {
  return <TechnicalTable label="Context limits" columns={['Setting', 'Value', 'Source']} rows={contextRows(model)}/>;
}
