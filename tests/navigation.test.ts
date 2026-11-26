import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderComponent, loadComponents } from './solid-render.js';
import { categorySlugs, configRoute, createBrowserNavigation, home, parseLocation, routePath, settingsRoute, usageRoute } from '../src/navigation.js';
import { usageRange } from '../src/usage-period.js';
import { inspect } from '../server/parser.js';
import path from 'node:path';

const { App } = await loadComponents<typeof import('../src/App.js')>('/src/App.tsx');
const { CategoryList, EntryDetail } = await loadComponents<typeof import('../src/ConfigurationViews.js')>('/src/ConfigurationViews.tsx');

test('route codec roundtrips every category and exact IDs without double decoding', () => {
  assert.deepEqual(parseLocation('/').route, home);
  for (const category of Object.keys(categorySlugs) as (keyof typeof categorySlugs)[]) {
    for (const id of [null, 'build', 'openai/gpt-6.1-sol', './plugins/foo.ts', '日本語 spaces/%?#', '%2F', '/absolute/path', '.', '..', '~.', '~name']) {
      const route = { category, id };
      assert.deepEqual(parseLocation(routePath(route)).route, route);
      assert.deepEqual(parseLocation(new URL(routePath(route), 'http://localhost').pathname).route, route);
      assert.equal(parseLocation(routePath(route)).invalid, false);
    }
  }
  assert.equal(routePath({ category: 'Models', id: 'openai/gpt-6.1-sol' }), '/config/models/openai%2Fgpt-6.1-sol');
  assert.equal(parseLocation('/models/openai/gpt-6.1-sol').route.id, 'openai/gpt-6.1-sol');
  for (const value of ['/unknown', '/Agents', '/agents/', '/agents/%', '/models/%E0%A4%A', '//agents']) assert.equal(parseLocation(value).invalid, true, value);
  assert.deepEqual(parseLocation('/agents/build', '?open=model-settings,prompt,prompt,bogus&raw=1&ignored=x').open, ['model-settings', 'prompt']);
  assert.equal(parseLocation('/', '?raw=true').raw, false);
});

function fakeBrowser(initial: string) {
  const events = new EventTarget();
  const stack = [{ url: new URL(initial, 'http://localhost:4317'), state: { other: 'preserved' } as any }];
  let index = 0;
  const move = (delta: number) => { index = Math.max(0, Math.min(stack.length - 1, index + delta)); events.dispatchEvent(new Event('popstate')); };
  return {
    get location() { return stack[index].url; },
    history: {
      get state() { return stack[index].state; },
      get length() { return stack.length; },
      replaceState(state: any, _: string, url: string) { stack[index] = { state, url: new URL(url, stack[index].url) }; },
      pushState(state: any, _: string, url: string) { stack.splice(index + 1); stack.push({ state, url: new URL(url, stack[index].url) }); index++; },
      back() { move(-1); }, forward() { move(1); }, go: move,
    },
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
  };
}

test('browser history restores subagent parent and its disclosures; replacement never adds steps', () => {
  const browser = fakeBrowser('/');
  const router = createBrowserNavigation(browser as unknown as Window);
  let notifications = 0;
  const unsubscribe = router.subscribe(() => notifications++);
  assert.equal(router.canBack(), false);
  router.go({ category: 'Agents', id: null });
  router.go({ category: 'Agents', id: 'build' });
  router.disclosure('subagents', true);
  router.raw(true);
  assert.equal(browser.history.length, 3);
  router.go({ category: 'Agents', id: 'quick' });
  assert.deepEqual(router.read().open, []);
  assert.equal(router.read().raw, false);
  browser.history.back();
  assert.equal(router.read().route.id, 'build');
  assert.deepEqual(router.read().open, ['subagents']);
  assert.equal(router.read().raw, true);
  browser.history.forward();
  router.back();
  assert.equal(router.read().route.id, 'build');
  router.go(home);
  router.back();
  assert.equal(router.read().route.id, 'build');
  assert.equal(browser.history.state.other, 'preserved');
  const before = notifications;
  unsubscribe();
  browser.history.back();
  assert.equal(notifications, before);
});

test('direct-link toolbar Back stays in the app; query edits preserve unknown params', () => {
  const browser = fakeBrowser('/agents/build?custom=yes');
  const router = createBrowserNavigation(browser as unknown as Window);
  const unsubscribe = router.subscribe(() => {});
  router.disclosure('prompt', true);
  router.disclosure('prompt', true);
  assert.equal(browser.history.length, 1);
  assert.equal(browser.location.pathname, '/agents/build', 'disclosure edits do not rewrite an old bookmark');
  assert.equal(browser.location.searchParams.get('custom'), 'yes');
  router.back();
  assert.deepEqual(router.read().route, { category: 'Agents', id: null });
  assert.equal(browser.location.pathname, '/config/agents');
  router.back();
  assert.deepEqual(router.read().route, home);
  assert.equal(router.canBack(), false);
  unsubscribe();
});

test('Settings is a distinct page with history restoration and a safe direct-link Back fallback', () => {
  assert.equal(routePath(settingsRoute), '/settings');
  assert.deepEqual(parseLocation('/settings').route, settingsRoute);
  assert.equal(parseLocation('/settings').invalid, false);
  for (const value of ['/settings/', '/settings/foo', '/settings/%', '/Settings']) assert.equal(parseLocation(value).invalid, true, value);
  const browser = fakeBrowser('/');
  const router = createBrowserNavigation(browser as unknown as Window);
  const unsubscribe = router.subscribe(() => {});
  router.go(settingsRoute);
  assert.equal(browser.location.pathname, '/settings');
  assert.equal(browser.history.length, 2);
  router.go(settingsRoute);
  assert.equal(browser.history.length, 2);
  router.go(home);
  assert.equal(browser.location.pathname, '/usage');
  router.back();
  assert.deepEqual(router.read().route, settingsRoute);
  browser.history.back();
  assert.deepEqual(router.read().route, home);
  browser.history.forward();
  assert.deepEqual(router.read().route, settingsRoute);
  router.go({ category: 'Agents', id: 'build' });
  router.disclosure('prompt', true);
  router.go(settingsRoute);
  router.back();
  assert.equal(router.read().route.id, 'build');
  assert.deepEqual(router.read().open, ['prompt']);
  unsubscribe();
  const direct = createBrowserNavigation(fakeBrowser('/settings/indexing') as unknown as Window);
  assert.equal(direct.canBack(), true);
  direct.back();
  assert.deepEqual(direct.read().route, home);
  assert.equal(direct.canBack(), false);
});

test('Usage route is direct-linkable and calendar ranges use local calendar boundaries', () => {
  assert.equal(routePath(usageRoute), '/usage');
  assert.deepEqual(parseLocation('/usage').route, usageRoute);
  assert.equal(parseLocation('/usage').invalid, false);
  for (const value of ['/usage/', '/usage/extra']) assert.equal(parseLocation(value).invalid, true, value);
  const week = usageRange(new Date(2024, 2, 13, 15), 'week');
  assert.deepEqual(week, { from: +new Date(2024, 2, 7), to: +new Date(2024, 2, 14), granularity: 'day' });
  const month = usageRange(new Date(2024, 1, 29, 12), 'month');
  assert.equal(new Date(month.from).getDate(), 1);
  assert.equal(new Date(month.to).getDate(), 1);
  assert.equal(new Date(month.to).getMonth(), 2);
  const today = new Date(2024, 2, 30, 12);
  assert.equal(usageRange(today, 'month').from, +new Date(2024, 1, 29));
  assert.deepEqual(usageRange(today, 'quarter'), { from: +new Date(2023, 11, 31), to: +new Date(2024, 2, 31), granularity: 'week' });
  assert.deepEqual(usageRange(today, { from: '2024-01-15', to: '2024-01-15' }), { from: +new Date(2024, 0, 15), to: +new Date(2024, 0, 16), granularity: 'hour' });
  assert.deepEqual(usageRange(today, 'all'), { from: 0, to: +new Date(2024, 2, 31), granularity: 'month' });
});

test('Settings routes show only their pane, and Indexing is independent of configuration loading', async () => {
  const snapshot = await inspect(path.resolve('examples/demo'));
  const html = renderComponent(App, { initialSnapshot: snapshot, initialRoute: '/settings' });
  assert.doesNotMatch(html, /about-view|popoverTarget|toolbar-actions|Collapse all|>Reload<|>Back</);
  assert.match(html, /Configuration information/);
  assert.match(html, /Config root/);
  assert.match(html, /<h1[^>]*>Settings · General<\/h1>/);
  assert.doesNotMatch(html, /appearance-controls/);
  assert.match(html, /aria-label="Settings pages"[^>]*><a(?=[^>]*aria-current="page")[^>]*href="\/settings"/);
  const theme = renderComponent(App, { initialSnapshot: snapshot, initialRoute: '/settings/theme' });
  assert.match(theme, /<h1[^>]*>Settings · Theme<\/h1>/);
  assert.match(theme, /Preferences for this browser\. Your OpenCode configuration is unchanged\./);
  for (const text of ['<legend>Appearance</legend>', 'Inspector default', 'appearance-status', 'Follow reads configured', 'Desktop has separate browser storage', 'System is a browser approximation']) assert.ok(theme.includes(text), text);
  assert.doesNotMatch(theme, /Configuration information|Config root/);
  assert.doesNotMatch(html, /class="item-column"|name="item"|Choose a category to begin/);
  const pending = renderComponent(App, { initialRoute: '/settings' });
  assert.match(pending, /<h1[^>]*>Settings · General<\/h1>/);
  assert.match(pending, /Reading configuration/);
  const indexing = renderComponent(App, { initialRoute: '/settings/indexing' });
  assert.match(indexing, /<h1[^>]*data-route-heading[^>]*>Settings · Indexing<\/h1>/);
  assert.match(indexing, /aria-current="location" href="\/settings">Settings/);
  const settingsNav = indexing.match(/<nav[^>]*aria-label="Settings pages"[\s\S]*?<\/nav>/)![0];
  assert.deepEqual([...settingsNav.matchAll(/href="([^"]+)"/g)].map(match => match[1]), ['/settings', '/settings/theme', '/settings/indexing']);
  assert.match(settingsNav, /aria-current="page" href="\/settings\/indexing"/);
  assert.match(indexing, /<button[^>]*>Rebuild index<\/button>/);
  assert.doesNotMatch(indexing, /Reading configuration|Configuration information|appearance-controls/);
  const invalid = renderComponent(App, { initialSnapshot: snapshot, initialRoute: '/settings/foo' });
  assert.match(invalid, /Page not found/);
  assert.doesNotMatch(invalid, /<h1>Settings<\/h1>|appearance-controls|class="item-column"/);
});

test('direct-route initial render selects exactly the URL item, with honest missing/invalid states', async () => {
  const snapshot = await inspect(path.resolve('examples/demo'));
  const render = (initialRoute: string) => renderComponent(App, { initialSnapshot: snapshot, initialRoute });
  assert.match(render('/agents/build?open=model-settings,prompt&raw=1'), /<h1[^>]*data-route-heading[^>]*>Build<\/h1>/);
  assert.match(render('/agents/build?open=model-settings,prompt&raw=1'), /<details[^>]*\sopen(?:=""|(?=[\s>]))[^>]*><summary>Model &amp; settings/);
  assert.match(render('/agents/build?open=prompt&raw=1'), /Show Markdown/);
  assert.doesNotMatch(render('/agents'), /class="entry-detail"/);
  assert.match(render('/agents/missing'), /Definition not found/);
  assert.doesNotMatch(render('/agents/missing'), /class="entry-detail"/);
  assert.match(render('/unknown'), /Page not found/);
  const pending = renderComponent(App, { initialRoute: '/agents/build' });
  assert.match(pending, /Reading configuration/);
  assert.doesNotMatch(pending, /Definition not found|Choose a category to begin/);
});

test('root renders Usage Overview with a single header; item disclosures stay closed by default', async () => {
  const snapshot = await inspect(path.resolve('examples/demo'));
  const initial = renderComponent(App, { initialSnapshot: snapshot });
  assert.match(initial, /<h1[^>]*>Usage · Overview<\/h1>/);
  assert.match(initial, /<button[^>]*aria-controls="inspector-pages"[^>]*>Overview</);
  assert.doesNotMatch(initial, /desktop-sidebar|class="item-column"|class="entry-detail"|role="tablist"/);
  assert.equal((initial.match(/<header\b/g) || []).length, 1);
  assert.doesNotMatch(initial, /about-view|popoverTarget|toolbar-actions|Collapse all|>Reload<|>Back</);
  assert.match(initial, /aria-label="OpenCode Inspector home" href="\/usage"/);
  assert.doesNotMatch(initial, /class="navigation-bar"|class="breadcrumbs"|class="header-line"|class="path-line"/);
  const build = snapshot.entries.find(entry => entry.category === 'Agents' && entry.id === 'build')!;
  const detail = renderComponent(EntryDetail, { entry: build, entries: snapshot.entries, choose: () => {} });
   for (const label of ['Model &amp; settings', 'Subagents (4)', 'Prompt', 'Sources', 'Raw configuration']) assert.ok(detail.includes(label), label);
   assert.doesNotMatch(detail, /data-section="(?:about|permissions|agent-rules)"/);
  assert.doesNotMatch(detail, /<details[^>]*\sopen(?:=|\s|>)/);
  assert.match(detail, /Show raw text/);
});

test('search is shown only above twelve entries, based on the full category list', async () => {
  const snapshot = await inspect(path.resolve('examples/demo'));
  const entry = snapshot.entries.find(entry => entry.category === 'Agents')!;
  for (const count of [0, 1, 12, 13]) {
    const items = Array.from({ length: count }, (_, index) => ({ ...entry, id: `agent-${index}` }));
    const markup = renderComponent(CategoryList, { category: 'Agents', items, choose: () => {}, loading: false, query: '', onQuery: () => {} });
    assert.equal(markup.includes('type="search"'), count > 12, `${count} entries`);
  }
});

test('directory and subpage routes roundtrip, aliases agree, and history distinguishes Usage pages', () => {
  for (const pathname of ['/usage', '/usage/agents', '/usage/models', '/usage/skills', '/config', '/config/agents', '/settings', '/settings/theme', '/settings/indexing']) {
    const view = parseLocation(pathname);
    assert.equal(view.invalid, false, pathname);
    assert.equal(routePath(view.route), pathname);
  }
  assert.deepEqual(parseLocation('/'), parseLocation('/usage/overview'));
  assert.deepEqual(parseLocation('/usage'), parseLocation('/usage/overview'));
  assert.deepEqual(parseLocation('/settings'), parseLocation('/settings/general'));
  assert.deepEqual(parseLocation('/agents/build'), parseLocation('/config/agents/build'));
  for (const pathname of ['/usage/theme', '/settings/agents', '/usage/agents/', '/settings/theme/extra', '/config/extra']) assert.equal(parseLocation(pathname).invalid, true, pathname);
  const browser = fakeBrowser('/');
  const router = createBrowserNavigation(browser as unknown as Window);
  router.subscribe(() => {});
  router.go(usageRoute);
  assert.equal(browser.history.length, 1, 'alias and canonical page are the same destination');
  router.go({ ...usageRoute, subpage: 'agents' });
  router.go({ ...usageRoute, subpage: 'models' });
  router.go(configRoute);
  router.go({ category: 'Agents', id: 'build' });
  browser.history.back();
  assert.deepEqual(router.read().route, configRoute);
  browser.history.back();
  assert.equal(router.read().route.subpage, 'models');
  browser.history.back();
  assert.equal(router.read().route.subpage, 'agents');
  browser.history.back();
  assert.equal(router.read().route.subpage, 'overview');
  browser.history.forward();
  assert.equal(router.read().route.subpage, 'agents');
});

test('the header links to all pages and preserves local configuration navigation', async () => {
  const snapshot = await inspect(path.resolve('examples/demo'));
  const render = (initialRoute: string) => renderComponent(App, { initialSnapshot: snapshot, initialRoute });
  const usage = render('/usage/models');
  const header = usage.match(/<header\b[^>]*>[\s\S]*?<\/header>/)![0];
  assert.match(header, /<button[^>]*aria-expanded="false"[^>]*aria-controls="inspector-pages"[^>]*>Models</);
  assert.doesNotMatch(usage, /aria-label="Usage pages"|Explore configuration|>More<\/button>|role="menu/);
  const pages = header.match(/<nav[^>]*aria-label="Inspector pages"[\s\S]*?<\/nav>/)![0];
  assert.match(pages, /id="inspector-pages"[^>]*\shidden/);
  assert.deepEqual([...pages.matchAll(/href="([^"]+)">([^<]+)<|<(hr)\b/g)].map(match => match[3] ?? match.slice(1, 3)), [
    ['/usage', 'Overview'], ['/usage/agents', 'Agents'], ['/usage/models', 'Models'], ['/usage/skills', 'Skills'],
    'hr', ['/config', 'Config'], ['/settings', 'Settings'],
  ]);
  assert.match(pages, /aria-current="page" href="\/usage\/models"/);
  assert.equal((pages.match(/aria-current=/g) || []).length, 1);

  const directory = render('/config');
  assert.match(directory, /<h1[^>]*>Configuration<\/h1>/);
  assert.match(directory, /Back to Usage · Overview/);
  assert.match(directory, /class="config-return"><a href="\/usage"/);
  assert.doesNotMatch(directory, /class="return-to-usage"/);
  assert.match(directory, /aria-controls="inspector-pages"[^>]*>Config</);
  assert.match(directory, /aria-current="page" href="\/config">Config</);
  const theme = render('/settings/theme');
  assert.match(theme, /aria-controls="inspector-pages"[^>]*>Settings</);
  assert.match(theme, /aria-current="location" href="\/settings">Settings</);
  const categoryLinks = directory.match(/<nav[^>]*aria-label="Configuration categories"[\s\S]*?<\/nav>/)![0];
  assert.equal((categoryLinks.match(/<a\b/g) || []).length, 7);
  for (const category of Object.keys(categorySlugs) as (keyof typeof categorySlugs)[]) {
    const listRoute = routePath({ category, id: null });
    const count = snapshot.entries.filter(entry => entry.category === category).length;
    assert.ok(categoryLinks.includes(`href="${listRoute}"><span>${category === 'MCP Servers' ? 'MCP servers' : category}</span><span class="secondary">${count}</span>`), category);
    const entry = snapshot.entries.find(candidate => candidate.category === category)!;
    const html = render(routePath({ category, id: entry.id }));
    assert.match(html, /<main class="config-workspace detail-pane"[^>]*>[\s\S]*<article class="entry-detail"/);
    const crumbs = html.match(/<nav class="config-breadcrumbs"[\s\S]*?<\/nav>/)![0];
    assert.match(crumbs, /href="\/config">Config<\/a>/);
    assert.ok(crumbs.includes(`href="${listRoute}"`), category);
    assert.doesNotMatch(html, /class="config-category"|class="config-entry-list|name="filter"|class="return-to-usage"/);
    const landing = render(listRoute);
    const label = category === 'MCP Servers' ? 'MCP servers' : category;
    assert.ok(landing.includes(`aria-label="${label} list"`), category);
    assert.ok(landing.includes(`href="${routePath({ category, id: entry.id })}"`), category);
    assert.match(landing, /<nav class="config-breadcrumbs"[^>]*><a href="\/config">Config<\/a>/);
    assert.doesNotMatch(landing, /class="entry-detail"|Choose a definition/);
  }
  const legacyAgents = render('/agents');
  assert.match(legacyAgents, /aria-controls="inspector-pages"[^>]*>Config</);
  assert.match(legacyAgents, /aria-current="location" href="\/config">Config</);
  assert.match(legacyAgents, /class="agent-group"[\s\S]*class="config-entry-list surface-card"[\s\S]*<strong>[^<]+<\/strong><small>[^<]+<\/small>/);
  for (const pathname of ['/usage/overview', '/usage/agents', '/usage/skills', '/settings/general', '/settings/theme']) assert.doesNotMatch(render(pathname), /class="config-workspace|class="config-breadcrumbs/);
});

test('list history restores the exact query and pixel scroll independently of detail disclosures and branch changes', async () => {
  const browser = fakeBrowser('/agents');
  const router = createBrowserNavigation(browser as unknown as Window);
  router.subscribe(() => {});
  const saved = { query: 'agent-12', scroll: 487, focusedId: 'agent-12' };
  const originalPosition = router.position();
  router.saveList(saved);
  assert.equal(browser.history.length, 1);
  router.go({ category: 'Agents', id: 'build' });
  assert.deepEqual(router.list(), { query: '', scroll: 0 }, 'the detail has no list state of its own');
  router.disclosure('subagents', true);
  router.raw(true);
  router.go({ category: 'Agents', id: 'quick' });
  router.back();
  assert.equal(router.read().route.id, 'build');
  assert.deepEqual(router.read().open, ['subagents']);
  assert.equal(router.read().raw, true);
  browser.history.back();
  assert.deepEqual(router.list(), saved);
  browser.history.forward();
  router.go({ category: 'Agents', id: null }, saved);
  assert.deepEqual(router.list(), saved, 'a breadcrumb can reopen the remembered category list');
  assert.deepEqual(router.read().open, []);
  assert.equal(router.read().raw, false);
  router.saveList({ query: 'other', scroll: 92 });
  const laterPosition = router.position();
  browser.history.go(-2);
  assert.equal(routePath(router.read().route), '/config/agents');
  assert.notEqual(laterPosition, router.position(), 'same-route traversal identifies a different scroll owner');
  assert.equal(router.position(), originalPosition);
  assert.deepEqual(router.list(), saved, 'older list history is not overwritten by a later visit');
  browser.history.go(2);
  assert.deepEqual(router.list(), { query: 'other', scroll: 92 });
  browser.history.go(-2);
  router.go({ category: 'Skills', id: null });
  assert.deepEqual(router.list(), { query: '', scroll: 0 }, 'a new branch clears discarded entry state');
  const snapshot = await inspect(path.resolve('examples/demo'));
  const entry = snapshot.entries.find(entry => entry.category === 'Agents')!;
  const items = Array.from({ length: 13 }, (_, index) => ({ ...entry, id: `agent-${index}`, name: `agent-${index}` }));
  const list = (query: string, loading = false, entries = items) => renderComponent(CategoryList, {
    category: 'Agents', items: entries, choose: () => {}, loading, query, onQuery: () => {},
  });
  const html = list(saved.query);
  assert.match(html, /type="search"[^>]*value="agent-12"/);
  assert.match(html, /href="\/config\/agents\/agent-12"/);
  assert.doesNotMatch(html, /href="\/config\/agents\/agent-11"/);
  assert.match(list('no-such-agent'), /No matches/);
  assert.match(list('', false, []), /No configured definitions/);
  assert.match(list('', true, []), /Reading configuration/);
});
