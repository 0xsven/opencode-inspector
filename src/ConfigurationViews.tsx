import { createContext, createMemo, createSignal, For, Show, useContext } from 'solid-js';
import type { Accessor, JSX } from 'solid-js';
import { SolidMarkdown } from 'solid-markdown';
import { agentGroupHelp, agentGroupNames, type groupAgents } from './agent-groups';
import { resolveAgentSettings } from './agent-settings';
import { configText } from './display';
import { compareContext, formatLimit } from './model-capacity';
import { configRoute, type LocationView, type Route } from './navigation';
import { taskPermission } from './permissions';
import { configuredTaskRules, taskDecision } from './task-rules';
import type { Category, Entry } from './types';
import { RouteLink } from './WorkspaceLinks';

const categories: Category[] = ['Instructions', 'Agents', 'Skills', 'Commands', 'Models', 'MCP Servers', 'Plugins'];
const categoryLabel = (category: Category) => category === 'MCP Servers' ? 'MCP servers' : category;
const title = (entry: Entry) => entry.category === 'Agents'
  ? entry.name.replace(/(^|[-/])([a-z])/g, (_, separator, letter) => (separator ? ' ' : '') + letter.toUpperCase())
  : entry.name;

export const DisclosureContext = createContext<{
  view: Accessor<LocationView>; toggle: (key: string, open: boolean) => void; raw: (enabled: boolean) => void;
}>();

export function ConfigBreadcrumbs(props: { category: Category; detail: boolean; go: (route: Route) => void }) {
  const categoryRoute = () => ({ category: props.category, id: null });
  return <nav class="config-breadcrumbs" aria-label="Configuration breadcrumb">
    <RouteLink route={configRoute} choose={() => props.go(configRoute)}>Config</RouteLink>
    <span aria-hidden="true">/</span>
    <Show when={props.detail} fallback={<span aria-current="page">{categoryLabel(props.category)}</span>}>
      <RouteLink route={categoryRoute()} choose={() => props.go(categoryRoute())}>{categoryLabel(props.category)}</RouteLink>
    </Show>
  </nav>;
}

export function ConfigDirectory(props: { entries: Entry[]; loading: boolean; go: (route: Route) => void }) {
  return <div class="config-directory">
    <h1 tabIndex={-1} data-route-heading>Configuration</h1>
    <p class="secondary">Browse definitions in your local OpenCode configuration.</p>
    <Show when={props.loading}><p class="secondary" role="status">Reading configuration…</p></Show>
    <nav aria-label="Configuration categories"><ul><For each={categories}>{category => {
      const route: Route = { category, id: null };
      return <li><RouteLink class="list-row surface-card" route={route} choose={() => props.go(route)}>
        <span>{categoryLabel(category)}</span>
        <Show when={!props.loading}><span class="secondary">{props.entries.filter(entry => entry.category === category).length}</span></Show>
      </RouteLink></li>;
    }}</For></ul></nav>
  </div>;
}

export function CategoryList(props: {
  category: Category; items: Entry[]; groups?: ReturnType<typeof groupAgents>; choose: (entry: Entry) => void; loading: boolean;
  query: string; onQuery: (query: string) => void;
}) {
  const showSearch = () => props.items.length > 12;
  const activeQuery = () => showSearch() ? props.query : '';
  const filtered = createMemo(() => {
    const query = activeQuery().toLowerCase();
    return props.items.filter(entry => `${entry.name} ${entry.id} ${entry.description}`.toLowerCase().includes(query));
  });
  const rows = (items: Accessor<Entry[]>) => <ul class="config-entry-list surface-card"><For each={items()}>{entry =>
    <li><RouteLink class="list-row" route={{ category: entry.category, id: entry.id }} choose={() => props.choose(entry)}>
      <span><strong>{title(entry)}</strong><Show when={entry.description?.trim()}>{description => <small>{description()}</small>}</Show></span>
      <span class="chevron" aria-hidden="true"/>
    </RouteLink></li>
  }</For></ul>;
  return <section class="config-category" aria-label={`${categoryLabel(props.category)} list`}>
    <h1 tabIndex={-1} data-route-heading>{categoryLabel(props.category)}</h1>
    <Show when={showSearch()}><label class="config-filter">Filter {props.category.toLowerCase()}
      <input type="search" name="filter" value={props.query} onInput={event => props.onQuery(event.currentTarget.value)}/>
    </label></Show>
    <Show when={filtered().length} fallback={<p class="secondary" role="status">{props.loading ? 'Reading configuration…' : activeQuery() ? 'No matches.' : 'No configured definitions.'}</p>}>
      <Show when={props.groups} fallback={rows(filtered)}>{groups =>
        <For each={agentGroupNames}>{group => {
          const groupItems = createMemo(() => (groups().get(group) || []).filter(entry => filtered().includes(entry)));
          return <Show when={groupItems().length}><section class="agent-group"><h2 title={agentGroupHelp}>{group}</h2>
            {rows(groupItems)}
          </section></Show>;
        }}</For>
      }</Show>
    </Show>
  </section>;
}

function Section(props: { label: string; section: string; children: JSX.Element }) {
  const disclosure = useContext(DisclosureContext);
  return <details class="disclosure" data-section={props.section} open={disclosure?.view().open.includes(props.section)} on:toggle={event => {
    // A queued native toggle from a detached entry must not update its successor.
    if (event.currentTarget.isConnected) disclosure?.toggle(props.section, event.currentTarget.open);
  }}><summary>{props.label}</summary><div class="section-content">{props.children}</div></details>;
}

export function EntryDetail(props: { entry: Entry; entries: Entry[]; choose: (entry: Entry) => void }) {
  const entry = () => props.entry;
  const agents = () => entry().category === 'Agents';
  const instructions = () => entry().category === 'Instructions';
  const candidates = createMemo(() => props.entries.filter(candidate => candidate.category === 'Agents' && candidate.id !== entry().id && candidate.data.hidden !== true
    && (candidate.data.mode === 'all' || candidate.data.mode === 'subagent'
      || candidate.data.mode === undefined && ['general', 'explore'].includes(candidate.id))
    && (typeof candidate.data.disabled === 'boolean' ? candidate.data.disabled : candidate.data.disable) !== true)
    .map(candidate => ({ entry: candidate, ...taskPermission(entry().data.effectivePermission, candidate.id) })));
  const accessible = createMemo(() => candidates().filter(candidate => candidate.action === 'allow' || candidate.action === 'ask'));
  const rules = createMemo(() => configuredTaskRules(entry().data.effectivePermission));
  const promptLabel = () => instructions() ? 'Instructions' : 'Prompt';
  const promptSizeLabel = () => {
    const size = entry().promptSize;
    return size ? `~${size.count.toLocaleString('en-US')} tokens` : 'Token estimate unavailable';
  };
  const provenance = createMemo(() => Object.entries(entry().provenance));
  const timeouts = createMemo(() => Object.entries(entry().data.configuredTimeout || {}));

  return <article class="entry-detail">
    <header class="detail-heading"><h1 tabIndex={-1} data-route-heading>{title(entry())}</h1></header>
    <Show when={agents()}><AgentOverview entry={entry()} entries={props.entries} accessible={accessible()} choose={props.choose}/></Show>
    <div class="detail-sections">
      <Show when={!agents() && entry().description}><Section section="about" label="About"><p>{entry().description}</p></Section></Show>
      <Show when={agents()}>
        <Section section="model-settings" label="Model & settings"><ModelSettings entry={entry()} models={props.entries.filter(candidate => candidate.category === 'Models')}/></Section>
        <Section section="subagents" label={`Subagents (${accessible().length})`}>
          <p class="secondary">The last configured match in the inspected files wins; no match is unknown here. Shows known subagent candidates only, excluding self, hidden, disabled and primary-only agents. Unspecified runtime eligibility and task availability remain unknown; policies and approvals are not evaluated.</p>
          <TechnicalTable label="Subagent rule resolution" columns={['Agent', 'Decision', 'Matching rule']} rows={candidates().map(candidate => [
            <EntryLink entry={candidate.entry} choose={props.choose}/>,
            candidate.action === 'ask' ? 'ask — Requires approval' : taskDecision(candidate.action),
            <code>{candidate.rule}</code>,
          ])}/>
          <Show when={!candidates().length}><p class="secondary">No known candidate agents.</p></Show>
          <Section section="task-rules" label="Configured task rules">
            <TechnicalTable label="Configured task rules in matching order" columns={['Order', 'Pattern', 'Action']} rows={rules().map((rule, index) => [index + 1, <code>{rule.pattern}</code>, rule.action])}/>
            <Show when={!rules().length}><p class="secondary">No valid configured task rule list.</p></Show>
          </Section>
        </Section>
      </Show>
      <Show when={agents() || entry().category === 'Commands' || entry().category === 'Skills' || instructions() || entry().prompt}>
        <Section section={instructions() ? 'instructions' : 'prompt'} label={agents() ? promptLabel() : `${promptLabel()} · ${promptSizeLabel()}`}>
          <PromptContent entry={entry()}/>
        </Section>
      </Show>
      <Show when={entry().category === 'Models'}><Section section="context-limits" label="Context limits">
        <TechnicalTable label="Context limits" columns={['Setting', 'Value', 'Source']} rows={contextRows(entry())}/>
      </Section></Show>
      <Show when={entry().category === 'MCP Servers' && timeouts().length}>
        <p class="secondary">Configured timeouts combine values in the inspected files with server-specific overrides. Runtime defaults are not shown.</p>
        <TechnicalTable label="Configured MCP timeouts" columns={['Purpose', 'Milliseconds']} rows={
          timeouts().map(([key, value]) => [key, <code>{formatLimit(value)}</code>])}/>
      </Show>
      <Section section="sources" label="Sources">
        <For each={entry().sources}>{source => <div class="source">
          <p>{source.kind}{source.path !== source.realpath ? ' · Symlink resolved' : ''}</p>
          <dl class="source-paths"><dt>Source path</dt><dd><code>{source.path}</code></dd><dt>Real path</dt><dd><code>{source.realpath}</code></dd></dl>
        </div>}</For>
        <Show when={provenance().length}><Section section="provenance" label="Value provenance"><dl class="provenance">
          <For each={provenance()}>{([key, value]) => <div><dt>{key}</dt><dd>{value}</dd></div>}</For>
        </dl></Section></Show>
      </Section>
      <Section section="raw-configuration" label="Raw configuration"><pre>{JSON.stringify(entry().data, null, 2)}</pre></Section>
    </div>
  </article>;
}

// solid-markdown 2.1.1 ignores raw nodes. Convert them to ordinary text to
// retain the source without parsing it as markup or creating HTML elements.
type MarkdownNode = { type: string; children?: MarkdownNode[] };
function escapeRawHtml() {
  return function visit(node: MarkdownNode) {
    if (node.type === 'raw') node.type = 'text';
    node.children?.forEach(visit);
  };
}

function PromptContent(props: { entry: Entry }) {
  const [localRaw, setLocalRaw] = createSignal(false);
  const disclosure = useContext(DisclosureContext);
  const rawPrompt = () => disclosure?.view().raw ?? localRaw();
  const setRawPrompt = disclosure?.raw ?? setLocalRaw;
  return <Show when={props.entry.prompt} fallback={<p class="secondary">{props.entry.category === 'Instructions'
    ? 'No local instruction text is available. URLs, globs, and substitutions are not resolved.'
    : 'No local prompt body is available. Built-in prompts and file substitutions are not resolved.'}</p>}>{prompt =>
    <>
      <Show when={props.entry.category !== 'Agents' && props.entry.promptSize}><p class="secondary">Estimated from the local text with o200k_base. The selected model’s token count may differ.</p></Show>
      <button class="plain-button prompt-toggle" aria-pressed={rawPrompt()} onClick={() => setRawPrompt(!rawPrompt())}>{rawPrompt() ? 'Show Markdown' : 'Show raw text'}</button>
      <Show when={rawPrompt()} fallback={<SolidMarkdown class="markdown" rehypePlugins={[escapeRawHtml]} components={{
        img: () => <span class="secondary">[External image not loaded]</span>,
        a: props => <span class="document-link">{props.children}</span>,
      }}>{prompt()}</SolidMarkdown>}>
        <pre>{prompt()}</pre>
      </Show>
    </>
  }</Show>;
}

function EntryLink(props: { entry: Entry; choose: (entry: Entry) => void; approval?: boolean; children?: JSX.Element }) {
  const label = () => title(props.entry);
  return <RouteLink route={{ category: props.entry.category, id: props.entry.id }} choose={() => props.choose(props.entry)}
    aria-label={props.approval ? `${label()} — requires approval` : undefined} title={props.approval ? 'Requires approval' : undefined}>{props.children ?? label()}</RouteLink>;
}

function AgentOverview(props: {
  entry: Entry; entries: Entry[]; accessible: (ReturnType<typeof taskPermission> & { entry: Entry })[];
  choose: (entry: Entry) => void;
}) {
  const settings = createMemo(() => resolveAgentSettings(props.entry, props.entries));
  const context = () => settings().model?.data.limit?.context;
  const capacity = () => settings().model?.modelCapacity?.context;
  const capped = () => compareContext(context(), capacity()) === 'lower';
  const size = () => props.entry.promptSize;
  return <section class="agent-overview" aria-label="Agent overview">
    <div class="overview-description">
      <p class="overview-about" aria-label="About">{props.entry.description || 'No local description available.'}</p>
    </div>
    <dl class="overview-facts">
      <div class="surface-card overview-model"><dt>Model</dt><dd><Show when={settings().model} fallback={settings().modelLabel}>{model =>
        <EntryLink entry={model()} choose={props.choose}>{settings().modelLabel}</EntryLink>
      }</Show></dd></div>
      <div class="surface-card overview-reasoning"><dt>Reasoning variant</dt><dd title={settings().reasoningSource}><span class="reasoning-value">{settings().reasoningLabel}</span><span class="secondary">{settings().reasoningSource}</span></dd></div>
      <div class="surface-card overview-context"><dt>Context limit</dt><dd><span class="overview-number">{formatLimit(context())}</span><span class="secondary" title={capped() ? `Configured limit below published capacity of ${formatLimit(capacity())} tokens. See Model & settings for provenance.` : 'Configured provider model context limit; runtime support is unknown.'}>{capped() ? 'Configured · Capped' : context() === undefined ? 'Not configured' : 'Configured'}</span></dd></div>
      <div class="surface-card overview-prompt"><dt>Prompt length</dt><dd title="Estimated with o200k_base from the original configured local prompt before redaction. Excludes runtime instructions, tools and conversation; model tokenization may differ."><span class={`overview-number${size() ? '' : ' unavailable'}`}>{size() ? `~${size()?.count.toLocaleString('en-US')}` : 'Not available'}</span><Show when={size()}><span class="overview-unit"> tokens</span></Show><span class="secondary">{size() ? 'Estimated · local prompt' : props.entry.prompt ? 'Local estimate unavailable' : 'Built-in prompt unknown'}</span></dd></div>
    </dl>
    <div class="overview-subagents">
      <span class="secondary">Subagents ({props.accessible.length})</span>
      <Show when={props.accessible.length} fallback={<span class="secondary">None known allowed or requiring approval</span>}>
        <ul><For each={props.accessible}>{candidate => <li>
          <EntryLink entry={candidate.entry} choose={props.choose} approval={candidate.action === 'ask'}/>
        </li>}</For></ul>
      </Show>
    </div>
  </section>;
}

function TechnicalTable(props: { label: string; columns: string[]; rows: JSX.Element[][] }) {
  return <table role="table" class="technical-table" aria-label={props.label}>
    <thead role="rowgroup"><tr role="row"><For each={props.columns}>{column => <th role="columnheader" scope="col">{column}</th>}</For></tr></thead>
    <tbody role="rowgroup"><For each={props.rows}>{row => <tr role="row"><For each={row}>{(cell, column) =>
      <Show when={column() === 0} fallback={<td role="cell" data-label={props.columns[column()]}>{cell}</td>}>
        <th role="rowheader" scope="row" data-label={props.columns[column()]}>{cell}</th>
      </Show>
    }</For></tr>}</For></tbody>
  </table>;
}

function ModelSettings(props: { entry: Entry; models: Entry[] }) {
  const rows = createMemo(() => {
    const { model, modelLabel, variant, variantSource, reasoning, reasoningSource } = resolveAgentSettings(props.entry, props.models);
    return [
      ['Model', <code>{modelLabel}</code>, props.entry.provenance.model || 'Unknown · not configured'],
      ['Reasoning', <code>{configText(reasoning)}</code>, reasoningSource],
      ['Variant', <code>{configText(variant ?? props.entry.data.variant)}</code>, variantSource || 'Unknown · not configured'],
      ['Mode', <code>{configText(props.entry.data.mode)}</code>, props.entry.provenance.mode || 'Unknown · not configured'],
      ...contextRows(model),
    ];
  });
  return <TechnicalTable label="Model and settings" columns={['Setting', 'Value', 'Source']} rows={rows()}/>;
}

function contextRows(model?: Entry): JSX.Element[][] {
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
