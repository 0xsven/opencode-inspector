import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import Markdown from 'react-markdown';
import type { Category, Entry, Snapshot } from './types';
import { configText } from './display';
import { taskPermission } from './permissions';
import { createBrowserNavigation, home, parseLocation, routePath, settingsRoute } from './navigation';
import type { LocationView, Route } from './navigation';
import { useInspectorTheme } from './useTheme';
import { agentGroupHelp, agentGroupNames, groupAgents } from './agent-groups';
import { compareContext, formatLimit } from './model-capacity';
import { resolveAgentSettings } from './agent-settings';
import { configuredTaskRules, taskDecision } from './task-rules';

const categories: Category[] = ['Agents', 'Skills', 'Commands', 'Models', 'MCP Servers', 'Plugins', 'Instructions'];
const singular: Record<Category, string> = {
  Agents: 'an agent', Skills: 'a skill', Commands: 'a command', Models: 'a model',
  'MCP Servers': 'an MCP server', Plugins: 'a plugin', Instructions: 'an instruction file',
};
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
  const { category, id, page } = view.route;
  const isSettings = !view.invalid && page === 'settings';
  const revision = `${view.invalid}:${page || 'inspector'}:${category}:${id}`;
  const go = (route: Route) => router?.go(route);
  const chooseCategory = (name: Category | null) => go({ category: name === category ? null : name, id: null });
  const entries = snapshot?.entries || [];
  const items = entries.filter(entry => entry.category === category);
  const selected = items.find(entry => entry.id === id);
  const agentGroups = category === 'Agents' ? groupAgents(items) : undefined;
  const themeState = useInspectorTheme(snapshot?.theme);

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
      <RouteLink className="app-title" aria-label="OpenCode Inspector home" route={home} choose={() => go(home)}>OpenCode Inspector</RouteLink>
      <span className="config-path" title={snapshot?.root}>{snapshot?.root || 'Local configuration'}</span>
    </header>

    <div className="mobile-navigation">
      <label><span className="visually-hidden">Category</span>
        <select name="category" value={isSettings ? 'settings' : category || ''} onChange={event => event.target.value === 'settings' ? go(settingsRoute) : chooseCategory(event.target.value as Category || null)}>
          <option value="">Choose a category…</option>
          <optgroup label="Categories">{categories.map(name => <option key={name} value={name}>{name} ({entries.filter(entry => entry.category === name).length})</option>)}</optgroup>
          <optgroup label="Preferences"><option value="settings">Settings</option></optgroup>
        </select>
      </label>
      {category && <label><span className="visually-hidden">Item</span>
        <select name="item" value={selected?.id || ''} onChange={event => go({ category, id: event.target.value || null })}>
          <option value="">Choose {singular[category]}…</option>
          {agentGroups ? agentGroupNames.map(group => {
            const groupItems = agentGroups.get(group)!;
            return groupItems.length ? <optgroup key={group} label={group}>{groupItems.map(entry => <option key={`${group}-${entry.id}`} value={entry.id}>{title(entry)}</option>)}</optgroup> : null;
          }) : items.map(entry => <option key={entry.id} value={entry.id}>{title(entry)}</option>)}
        </select>
      </label>}
    </div>

    <div className="workspace">
      <nav className="category-column" aria-label="Categories">
        <div className="category-list">{categories.map(name => <RouteLink className="list-row" key={name} aria-expanded={category === name} aria-current={category === name ? 'true' : undefined} route={{ category: category === name ? null : name, id: null }} choose={() => chooseCategory(name)}>
          <span>{name}</span><span className="secondary">{entries.filter(entry => entry.category === name).length}</span>
        </RouteLink>)}</div>
        <RouteLink className="list-row settings-link" route={settingsRoute} choose={() => go(settingsRoute)} aria-current={isSettings ? 'page' : undefined}>Settings</RouteLink>
      </nav>
      {category && <ItemColumn key={category} category={category} items={items} groups={agentGroups} selected={selected} choose={chooseItem} loading={loading}/>}
      <main className="detail-pane" key={revision} aria-label={isSettings ? 'Settings' : 'Definition details'}>
        {isSettings ? <SettingsPage themeState={themeState} snapshot={snapshot} loading={loading} error={error} retry={() => void load()}/>
          : error ? <div className="empty-state" role="alert"><h1>Couldn’t load configuration</h1><p>{error}</p><button className="plain-button" onClick={() => void load()}>Try again</button></div>
           : view.invalid ? <div className="empty-state"><h1>Page not found</h1><p>Choose a category or use your browser’s Back button to continue.</p></div>
          : !category ? <p className="empty-state">Choose a category to begin.</p>
          : !selected ? <div className="empty-state">{id !== null ? loading ? <p>Reading configuration…</p> : <><h1>Definition not found</h1><p>This definition is no longer available.</p></> : null}<p>Choose {singular[category]}.</p></div>
          : <DisclosureContext.Provider value={{ view, toggle: (key, open) => router?.disclosure(key, open), raw: enabled => router?.raw(enabled) }}><EntryDetail entry={selected} entries={entries} choose={chooseItem}/></DisclosureContext.Provider>}
      </main>
    </div>
  </div>;
}

function SettingsPage({ themeState, snapshot, loading, error, retry }: {
  themeState: ReturnType<typeof useInspectorTheme>; snapshot?: Snapshot; loading: boolean; error: string; retry: () => void;
}) {
  const theme = snapshot?.theme;
  const { preferences, updatePreferences, applied, storageFailed } = themeState;
  const themeOptions = theme?.palettes || [];
  const knownOverride = ['follow', 'inspector:default', 'builtin:system', ...themeOptions.map(option => option.id)].includes(preferences.theme);
  return <div className="settings-page">
    <h1>Settings</h1>
    <p className="secondary">Preferences for this browser. Your OpenCode configuration is unchanged.</p>
    {loading && <p className="secondary" role="status">Reading configured theme and available palettes…</p>}
    {error && <div className="settings-error" role="alert"><p>{error} Configured theme information may be unavailable or out of date.</p><button className="plain-button" onClick={retry}>Try again</button></div>}
    <fieldset className="appearance-controls">
      <legend>Appearance</legend>
      <label>Theme<select name="inspector-theme" value={preferences.theme} onChange={event => updatePreferences({ ...preferences, theme: event.target.value })}>
        <option value="follow">Follow OpenCode</option>
        <option value="inspector:default">Inspector default</option>
        <option value="builtin:system">System (browser approximation)</option>
        {themeOptions.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
        {!knownOverride && <option value={preferences.theme}>Unavailable override</option>}
      </select></label>
      <label>Color mode<select name="inspector-color-mode" value={preferences.mode} onChange={event => updatePreferences({ ...preferences, mode: event.target.value as typeof preferences.mode })}>
        <option value="auto">Auto (browser)</option><option value="light">Light</option><option value="dark">Dark</option>
      </select></label>
      <p className="appearance-status">{applied.label} · {applied.mode}<br/><span className="secondary">{applied.source}</span></p>
      {applied.palette && <p className="secondary">Palette: {applied.palette.source}</p>}
      {applied.note && <p className="secondary">{applied.note}</p>}
      {storageFailed && <p className="secondary">Browser storage is unavailable. This override lasts for the current page only.</p>}
    </fieldset>
    <p className="secondary">Theme overrides affect only this Inspector browser. Follow reads configured TUI/legacy settings, then saved CLI preferences for the global root only. Desktop has separate browser storage, which is not inspected. Auto uses your browser’s color scheme, not the terminal mode.</p>
    <p className="secondary">System is a browser approximation using Inspector colors and browser color-mode detection. It cannot reproduce the terminal palette or terminal transparency.</p>
    {theme?.warnings.map((warning, index) => <p className="secondary" key={index}>{warning}</p>)}
    <details className="settings-information">
      <summary>Configuration information{snapshot?.warnings.length ? ` · ${snapshot.warnings.length} notices` : ''}</summary>
      <dl className="source-paths"><dt>Config root</dt><dd><code>{snapshot?.root || 'Connecting…'}</code></dd><dt>Real path</dt><dd><code>{snapshot?.realpath || 'Unknown'}</code></dd></dl>
      <p className="secondary">Read-only, static inspection of local configuration. Runtime defaults and availability are not verified. Secrets are masked with best-effort redaction; paths remain visible. Inspect before sharing. No telemetry.</p>
      {snapshot?.warnings.map((warning, index) => <p className="secondary" key={index}>{warning}</p>)}
    </details>
  </div>;
}

export function ItemColumn({ category, items, groups, selected, choose, loading }: {
  category: Category; items: Entry[]; groups?: ReturnType<typeof groupAgents>; selected?: Entry; choose: (entry: Entry) => void; loading: boolean;
}) {
  const [query, setQuery] = useState('');
  useEffect(() => { setQuery(''); }, [selected?.id]);
  const showSearch = items.length > 12;
  const activeQuery = showSearch ? query : '';
  const filtered = items.filter(entry => `${entry.name} ${entry.id} ${entry.description}`.toLowerCase().includes(activeQuery.toLowerCase()));
  return <section className="item-column" aria-label={`${category} list`}>
    {showSearch && <label className="filter-label">Filter {category.toLowerCase()}
      <input type="search" name="filter" value={query} onChange={event => setQuery(event.target.value)}/>
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
  const candidates = entries.filter(candidate => candidate.category === 'Agents' && candidate.id !== entry.id && candidate.data.mode !== 'primary' && candidate.data.disable !== true)
    .map(candidate => ({ entry: candidate, ...taskPermission(entry.data.effectivePermission, candidate.id) }));
  const accessible = candidates.filter(candidate => candidate.action === 'allow' || candidate.action === 'ask');

  return <article className="entry-detail">
    <header className="detail-heading"><h1>{title(entry)}</h1></header>
    {entry.category === 'Agents' && <AgentOverview entry={entry} entries={entries} accessible={accessible} choose={choose}/>}
    <div className="detail-sections">
    {entry.category !== 'Agents' && entry.description && <Section section="about" label="About"><p>{entry.description}</p></Section>}
    {entry.category === 'Agents' && <>
      <Section section="model-settings" label="Model & settings"><ModelSettings entry={entry} models={entries.filter(candidate => candidate.category === 'Models')}/></Section>
      <Section section="subagents" label={`Subagents (${accessible.length})`}>
        <p className="secondary">Last matching rule wins; no match is unknown. Excludes self, disabled and primary-only agents. Unspecified runtime eligibility and task availability remain unknown.</p>
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
    {(entry.category === 'Agents' || entry.category === 'Commands' || entry.category === 'Skills' || entry.category === 'Instructions' || entry.prompt) && <Section section={entry.category === 'Instructions' ? 'instructions' : 'prompt'} label={entry.category === 'Instructions' ? 'Instructions' : 'Prompt'}>
      {entry.prompt ? <>
        <button className="plain-button prompt-toggle" aria-pressed={rawPrompt} onClick={() => setRawPrompt(!rawPrompt)}>{rawPrompt ? 'Show Markdown' : 'Show raw text'}</button>
        {rawPrompt ? <pre>{entry.prompt}</pre> : <div className="markdown"><Markdown components={{
          img: () => <span className="secondary">[External image not loaded]</span>,
          a: ({ children }) => <span className="document-link">{children}</span>,
        }}>{entry.prompt}</Markdown></div>}
      </> : <p className="secondary">No local prompt body is available. Built-in prompts and file substitutions are not resolved.</p>}
    </Section>}
    {entry.category === 'Models' && <Section section="context-limits" label="Context limits"><ContextLimits model={entry}/></Section>}
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
  const { model, reasoningLabel, reasoningSource } = resolveAgentSettings(entry, entries);
  const context = model?.data.limit?.context;
  const capped = compareContext(context, model?.modelCapacity?.context) === 'lower';
  return <section className="agent-overview" aria-label="Agent overview">
    <div className="overview-description">
      <p className="overview-about" aria-label="About">{entry.description || 'No local description available.'}</p>
    </div>
    <dl className="overview-facts">
      <div className="overview-model"><dt>Model</dt><dd>{model
        ? <RouteLink route={{ category: 'Models', id: model.id }} choose={() => choose(model)}>{configText(entry.data.model)}</RouteLink>
        : configText(entry.data.model)}</dd></div>
      <div className="overview-reasoning"><dt>Reasoning variant</dt><dd title={reasoningSource}><span className="reasoning-value">{reasoningLabel}</span></dd></div>
      <div className="overview-context"><dt>Context limit</dt><dd><span className="overview-number">{formatLimit(context)}</span><span className="secondary" title={capped ? `Configured limit below published capacity of ${formatLimit(model?.modelCapacity?.context)} tokens. See Model & settings for provenance.` : 'Configured provider model context limit; runtime support is unknown.'}>{capped ? 'Configured · Capped' : context === undefined ? 'Not configured' : 'Configured'}</span></dd></div>
      <div className="overview-prompt"><dt>Prompt length</dt><dd title="Estimated with o200k_base from the original configured local prompt before redaction. Excludes runtime instructions, tools and conversation; model tokenization may differ."><span className={`overview-number${entry.promptSize ? '' : ' unavailable'}`}>{entry.promptSize ? `~${entry.promptSize.count.toLocaleString('en-US')}` : 'Not available'}</span>{entry.promptSize && <span className="overview-unit"> tokens</span>}<span className="secondary">{entry.promptSize ? 'Estimated · local prompt' : entry.prompt ? 'Local estimate unavailable' : 'Built-in prompt unknown'}</span></dd></div>
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
  const { model, reasoning, reasoningSource } = resolveAgentSettings(entry, models);
  const settings = [
    { label: 'Model', value: configText(entry.data.model), source: entry.provenance.model || 'Unknown · not configured' },
    { label: 'Reasoning', value: configText(reasoning), source: reasoningSource },
    { label: 'Variant', value: configText(entry.data.variant), source: entry.provenance.variant || 'Unknown · not configured' },
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
