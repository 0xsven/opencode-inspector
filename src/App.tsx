import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import { groupAgents } from './agent-groups';
import { CategoryList, ConfigBreadcrumbs, ConfigDirectory, DisclosureContext, EntryDetail } from './ConfigurationViews';
import { configRoute, createBrowserNavigation, home, parseLocation, routePath, settingsRoute, usageRoute } from './navigation';
import type { ListState, Route, UsagePage as UsageSubpage } from './navigation';
import { SettingsPage } from './SettingsPage';
import type { Category, Entry, Snapshot } from './types';
import { UsagePage } from './UsagePage';
import { useInspectorTheme } from './useTheme';
import { useClockFormat } from './useClockFormat';
import { RouteLink } from './WorkspaceLinks';

const usageLabels = { overview: 'Overview', agents: 'Agents', models: 'Models', skills: 'Skills' } as const;
const usageLinks = (Object.keys(usageLabels) as UsageSubpage[]).map(subpage => ({ label: usageLabels[subpage], route: { ...usageRoute, subpage } }));

const noEntries: Entry[] = [];

export function App(props: { initialSnapshot?: Snapshot; initialRoute?: string }) {
  const [snapshot, setSnapshot] = createSignal(props.initialSnapshot);
  const [loading, setLoading] = createSignal(!props.initialSnapshot);
  const [error, setError] = createSignal('');
  const router = typeof window === 'undefined' ? undefined : createBrowserNavigation(window);
  const initial = props.initialRoute ? new URL(props.initialRoute, 'http://localhost') : undefined;
  const [view, setView] = createSignal(initial ? parseLocation(initial.pathname, initial.search) : router?.read() ?? parseLocation('/'));
  const clockState = useClockFormat();
  const route = () => view().route;
  const category = () => route().category;
  const id = () => route().id;
  const isSettings = () => !view().invalid && route().page === 'settings';
  const isUsage = () => !view().invalid && route().page === 'usage';
  const isConfig = () => !isSettings() && !isUsage();
  const isCategoryList = () => isConfig() && category() !== null && id() === null;
  const revision = createMemo(() => JSON.stringify([view().invalid, route().page, route().subpage, category(), id()]));
  const configFrame = createMemo(() => {
    view(); // Traversals can also change the frame without changing the path.
    return `${router?.position() ?? 0}:${revision()}`;
  });
  const [lastUsage, setLastUsage] = createSignal<UsageSubpage | null>(isUsage() ? route().subpage as UsageSubpage : null);
  createEffect(on([isUsage, () => route().subpage], ([visible, subpage]) => {
    if (visible) setLastUsage(subpage as UsageSubpage);
  }));
  const returnRoute = createMemo(() => ({
    ...usageRoute,
    subpage: isUsage() ? route().subpage as UsageSubpage : lastUsage() ?? 'overview',
  }));
  const pageLabel = () => isUsage() ? usageLabels[returnRoute().subpage] : isSettings() ? 'Settings' : 'Config';

  const entries = () => snapshot()?.entries ?? noEntries;
  const items = createMemo(() => entries().filter(entry => entry.category === category()));
  const selected = createMemo(() => items().find(entry => entry.id === id()));
  const agentGroups = createMemo(() => category() === 'Agents' ? groupAgents(items()) : undefined);
  const themeState = useInspectorTheme(() => snapshot()?.theme);
  const listStates: Partial<Record<Category, ListState>> = {};
  const listQuery = createMemo(() => {
    view();
    return router?.list().query ?? '';
  });
  let focusedRevision = isUsage() ? revision() : null;
  const [pageLinksOpen, setPageLinksOpen] = createSignal(false);
  let pageButton: HTMLButtonElement | undefined;
  let pagePicker: HTMLDivElement | undefined;
  let settingsMain: HTMLElement | undefined;
  let usageContent: HTMLDivElement | undefined;
  let configMain: HTMLElement | undefined;
  let listScrollOwner: HTMLElement | undefined;

  const dismissPageLinks = () => {
    if (!pageLinksOpen()) return;
    // Keep focus out of the panel before hiding it, including on a same-route choice.
    if (pagePicker?.contains(pagePicker.ownerDocument.activeElement)) pageButton?.focus({ preventScroll: true });
    setPageLinksOpen(false);
  };
  const saveList = (value: ListState) => {
    const group = category();
    if (!group || !isCategoryList()) return;
    listStates[group] = value;
    router?.saveList(value);
  };
  const go = (destination: Route, focusedId?: string) => {
    dismissPageLinks();
    const list = router?.list();
    if (list && listScrollOwner?.isConnected) {
      saveList({ ...list, scroll: listScrollOwner.scrollTop, focusedId: focusedId ?? list.focusedId });
    }
    router?.go(destination, destination.category && destination.id === null ? listStates[destination.category] : undefined);
  };
  const chooseItem = (entry: Entry) => go({ category: entry.category, id: entry.id }, entry.id);
  const backToUsage = () => <RouteLink route={returnRoute()} choose={() => go(returnRoute())}><span aria-hidden="true">←</span> Back to Usage · {usageLabels[returnRoute().subpage]}</RouteLink>;
  const disclosure = {
    view,
    toggle: (key: string, open: boolean) => router?.disclosure(key, open),
    raw: (enabled: boolean) => router?.raw(enabled),
  };

  createEffect(() => {
    if (!pageLinksOpen() || !pagePicker) return;
    const document = pagePicker.ownerDocument;
    const outside = (event: Event) => {
      // The picker fills the remaining header width to constrain the panel.
      if (event.target instanceof Node && (event.target === pagePicker || !pagePicker?.contains(event.target))) {
        setPageLinksOpen(false);
      }
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside, true);
    onCleanup(() => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside, true);
    });
  });
  createEffect(on([configFrame, loading, error], () => {
    listScrollOwner = isCategoryList() && !loading() && !error() && configMain?.isConnected ? configMain : undefined;
    const group = category();
    const saved = router?.list();
    if (listScrollOwner && group && saved) {
      listStates[group] = saved;
      listScrollOwner.scrollTop = saved.scroll;
    }
  }));
  createEffect(on([revision, snapshot], () => {
    if (isSettings() && settingsMain?.isConnected) settingsMain.scrollTop = 0;
  }));
  createEffect(on(lastUsage, () => { if (usageContent) usageContent.scrollTop = 0; }));
  const focusKey = () => isConfig() ? configFrame() : revision();
  createEffect(on([focusKey, snapshot, loading, error], ([currentRevision]) => {
    if (focusedRevision === currentRevision) return;
    if (isUsage()) {
      pageButton?.focus({ preventScroll: true });
      focusedRevision = currentRevision;
      return;
    }
    const main = isSettings() ? settingsMain : configMain;
    const group = category();
    const previous = isCategoryList() ? router?.list().focusedId : undefined;
    const item = group && previous !== undefined
      ? Array.from(main?.querySelectorAll<HTMLAnchorElement>('.config-entry-list a[href]') ?? [])
        .find(link => link.getAttribute('href') === routePath({ category: group, id: previous }))
      : undefined;
    const target = item || main?.querySelector<HTMLElement>('[data-route-heading]');
    if (target) {
      // The history frame owns the scroll position, not the focused row.
      target.focus({ preventScroll: true });
      focusedRevision = currentRevision;
    }
  }));

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
  onMount(() => {
    if (router) {
      const sync = () => setView(router.read());
      // Back/Forward can also traverse history entries for the same route.
      window.addEventListener('popstate', dismissPageLinks);
      onCleanup(() => window.removeEventListener('popstate', dismissPageLinks));
      onCleanup(router.subscribe(sync));
      sync();
    }
    if (!props.initialSnapshot) void load();
  });

  return <div class="app">
    <header class="toolbar">
      <div class="toolbar-content" classList={{ 'toolbar-content-centered': isUsage() || isConfig() }}>
        <RouteLink class="app-title" aria-label="OpenCode Inspector home" route={home} choose={() => go(home)}>OpenCode Inspector</RouteLink>
        <span class="page-divider" aria-hidden="true">/</span>
        <div class="page-picker" ref={pagePicker} onKeyDown={event => {
          if (event.key === 'Escape' && pageLinksOpen()) {
            event.preventDefault();
            event.stopPropagation();
            dismissPageLinks();
          }
        }}>
          <button type="button" class="page-picker-trigger" ref={pageButton} aria-expanded={pageLinksOpen()}
            aria-controls="inspector-pages" onClick={event => {
              event.currentTarget.focus({ preventScroll: true });
              setPageLinksOpen(open => !open);
            }}>{pageLabel()}<span class="page-picker-chevron" aria-hidden="true"/></button>
          <nav id="inspector-pages" class="page-picker-links surface-card" aria-label="Inspector pages" hidden={!pageLinksOpen()}>
            <For each={usageLinks}>{link => <RouteLink route={link.route} choose={() => go(link.route)}
              aria-current={isUsage() && link.route.subpage === returnRoute().subpage ? 'page' : undefined}>{link.label}</RouteLink>}</For>
            <hr/>
            <RouteLink route={configRoute} choose={() => go(configRoute)}
              aria-current={route().page === 'config' ? 'page' : category() ? 'location' : undefined}>Config</RouteLink>
            <RouteLink route={settingsRoute} choose={() => go(settingsRoute)}
              aria-current={isSettings() ? routePath(route()) === routePath(settingsRoute) ? 'page' : 'location' : undefined}>Settings</RouteLink>
          </nav>
        </div>
      </div>
    </header>

    <Show when={lastUsage() !== null}>
      <main class="usage-workspace" hidden={!isUsage()} aria-label="Usage">
        <div class="usage-workspace-content" ref={usageContent}><UsagePage subpage={returnRoute().subpage} active={isUsage()} go={go} clockFormat={clockState.format}/></div>
      </main>
    </Show>

    <Show when={isSettings()}>
      <div class="return-to-usage">{backToUsage()}</div>
      <div class="workspace">
        <main class="detail-pane" ref={settingsMain} aria-label="Settings">
          <SettingsPage subpage={route().subpage} themeState={themeState} clockState={clockState} snapshot={snapshot()} loading={loading()} error={error()} retry={() => void load()} go={go}/>
        </main>
      </div>
    </Show>

    <Show when={isConfig() && configFrame()} keyed>{frame =>
      <main class="config-workspace detail-pane" aria-label="Configuration" ref={configMain} on:scroll={event => {
        const owner = event.currentTarget;
        const list = router?.list();
        // Native scroll events queued on the outgoing page must not write to the new frame.
        if (list && owner === listScrollOwner && owner.isConnected && frame === configFrame()) saveList({ ...list, scroll: owner.scrollTop });
      }}>
        <div class="config-page">
          <div class="config-navigation">
            <Show when={category()}>{group => <ConfigBreadcrumbs category={group()} detail={id() !== null} go={go}/>}</Show>
            <div class="config-return">{backToUsage()}</div>
          </div>
          {view().invalid ? <div class="config-message"><h1 tabIndex={-1} data-route-heading>Page not found</h1><p>Open the configuration directory or use your browser’s Back button to continue.</p></div>
            : error() ? <div class="config-message" role="alert"><h1 tabIndex={-1} data-route-heading>Couldn’t load configuration</h1><p>{error()}</p><button class="plain-button" onClick={() => void load()}>Try again</button></div>
            : <Show when={category()} fallback={<ConfigDirectory entries={entries()} loading={loading()} go={go}/>}>{group =>
              <Show when={id() !== null} fallback={<CategoryList category={group()} items={items()} groups={agentGroups()} choose={chooseItem}
                loading={loading()} query={listQuery()} onQuery={query => {
                  saveList({ ...router?.list(), query, scroll: configMain?.scrollTop ?? 0 });
                  setView(router?.read() ?? view());
                }}/>}>
                <Show when={selected()} fallback={<div class="config-message">
                  <Show when={loading()} fallback={<><h1 tabIndex={-1} data-route-heading>Definition not found</h1><p>This definition is no longer available.</p></>}>
                    <p role="status">Reading configuration…</p>
                  </Show>
                </div>}>{entry =>
                  <DisclosureContext.Provider value={disclosure}><EntryDetail entry={entry()} entries={entries()} choose={chooseItem}/></DisclosureContext.Provider>
                }</Show>
              </Show>
            }</Show>}
        </div>
      </main>
    }</Show>
  </div>;
}
