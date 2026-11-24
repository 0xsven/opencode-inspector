import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { App, EntryDetail, ItemColumn, Sidebar } from '../src/App.js';
import { categorySlugs, createBrowserNavigation, home, parseLocation, routePath, routeSection, settingsRoute, usageRoute } from '../src/navigation.js';
import { usageRange } from '../src/App.js';
import { inspect } from '../server/parser.js';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

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
  assert.equal(routePath({ category: 'Models', id: 'openai/gpt-6.1-sol' }), '/models/openai%2Fgpt-6.1-sol');
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
      back() { move(-1); }, forward() { move(1); },
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
  assert.equal(browser.location.searchParams.get('custom'), 'yes');
  router.back();
  assert.deepEqual(router.read().route, { category: 'Agents', id: null });
  router.back();
  assert.deepEqual(router.read().route, home);
  assert.equal(router.canBack(), false);
  unsubscribe();
});

test('Settings is a distinct page with history restoration and a safe direct-link Back fallback', () => {
  assert.equal(routePath(settingsRoute), '/settings/general');
  assert.deepEqual(parseLocation('/settings').route, settingsRoute);
  assert.equal(parseLocation('/settings').invalid, false);
  for (const value of ['/settings/', '/settings/foo', '/settings/%', '/Settings']) assert.equal(parseLocation(value).invalid, true, value);
  const browser = fakeBrowser('/');
  const router = createBrowserNavigation(browser as unknown as Window);
  const unsubscribe = router.subscribe(() => {});
  router.go(settingsRoute);
  assert.equal(browser.location.pathname, '/settings/general');
  assert.equal(browser.history.length, 2);
  router.go(settingsRoute);
  assert.equal(browser.history.length, 2);
  router.go(home);
  assert.equal(browser.location.pathname, '/');
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
  const direct = createBrowserNavigation(fakeBrowser('/settings') as unknown as Window);
  assert.equal(direct.canBack(), true);
  direct.back();
  assert.deepEqual(direct.read().route, home);
  assert.equal(direct.canBack(), false);
});

test('Usage route is direct-linkable and calendar ranges use local calendar boundaries', () => {
  assert.equal(routePath(usageRoute), '/usage/overview');
  assert.deepEqual(parseLocation('/usage').route, usageRoute);
  assert.equal(parseLocation('/usage').invalid, false);
  for (const value of ['/usage/', '/usage/extra']) assert.equal(parseLocation(value).invalid, true, value);
  const week = usageRange(new Date(2024, 2, 13, 15), 'week');
  assert.deepEqual(week, { from: +new Date(2024, 2, 7), to: +new Date(2024, 2, 14) });
  const month = usageRange(new Date(2024, 1, 29, 12), 'month');
  assert.equal(new Date(month.from).getDate(), 1);
  assert.equal(new Date(month.to).getDate(), 1);
  assert.equal(new Date(month.to).getMonth(), 2);
  const janEnd = new Date(2024, 0, 31, 12);
  janEnd.setDate(1); janEnd.setMonth(janEnd.getMonth() + 1);
  assert.deepEqual(usageRange(janEnd, 'month'), usageRange(new Date(2024, 1, 1), 'month'));
});

test('Settings General and Theme own their existing content, with the legacy alias landing on General', async () => {
  const snapshot = await inspect(path.resolve('examples/demo'));
  const html = renderToStaticMarkup(createElement(App, { initialSnapshot: snapshot, initialRoute: '/settings' }));
  assert.doesNotMatch(html, /about-view|popoverTarget|toolbar-actions|Collapse all|>Reload<|>Back</);
  assert.match(html, /Configuration information/);
  assert.match(html, /Config root/);
  assert.match(html, /<h1>Settings · General<\/h1>/);
  assert.doesNotMatch(html, /appearance-controls/);
  assert.match(html, /aria-current="page" href="\/settings\/general"/);
  const theme = renderToStaticMarkup(createElement(App, { initialSnapshot: snapshot, initialRoute: '/settings/theme' }));
  assert.match(theme, /<h1>Settings · Theme<\/h1>/);
  assert.match(theme, /Preferences for this browser\. Your OpenCode configuration is unchanged\./);
  for (const text of ['<legend>Appearance</legend>', 'Inspector default', 'appearance-status', 'Follow reads configured', 'Desktop has separate browser storage', 'System is a browser approximation']) assert.ok(theme.includes(text), text);
  assert.doesNotMatch(theme, /Configuration information|Config root/);
  assert.doesNotMatch(html, /class="item-column"|name="item"|Choose a category to begin/);
  const pending = renderToStaticMarkup(createElement(App, { initialRoute: '/settings' }));
  assert.match(pending, /<h1>Settings · General<\/h1>/);
  assert.match(pending, /Reading configuration/);
  const invalid = renderToStaticMarkup(createElement(App, { initialSnapshot: snapshot, initialRoute: '/settings/foo' }));
  assert.match(invalid, /Page not found/);
  assert.doesNotMatch(invalid, /<h1>Settings<\/h1>|appearance-controls|class="item-column"/);
});

test('direct-route initial render selects exactly the URL item, with honest missing/invalid states', async () => {
  const snapshot = await inspect(path.resolve('examples/demo'));
  const render = (initialRoute: string) => renderToStaticMarkup(createElement(App, { initialSnapshot: snapshot, initialRoute }));
  assert.match(render('/agents/build?open=model-settings,prompt&raw=1'), /<h1 tabindex="-1">Build<\/h1>/);
  assert.match(render('/agents/build?open=model-settings,prompt&raw=1'), /<details[^>]*open=""><summary>Model &amp; settings/);
  assert.match(render('/agents/build?open=prompt&raw=1'), /Show Markdown/);
  assert.doesNotMatch(render('/agents'), /class="entry-detail"/);
  assert.match(render('/agents/missing'), /Definition not found/);
  assert.doesNotMatch(render('/agents/missing'), /class="entry-detail"/);
  assert.match(render('/unknown'), /Page not found/);
  const pending = renderToStaticMarkup(createElement(App, { initialRoute: '/agents/build' }));
  assert.match(pending, /Reading configuration/);
  assert.doesNotMatch(pending, /Definition not found|Choose a category to begin/);
});

test('neutral root expands Usage without selecting a page; item disclosures stay closed by default', async () => {
  const snapshot = await inspect(path.resolve('examples/demo'));
  const initial = renderToStaticMarkup(createElement(App, { initialSnapshot: snapshot }));
  assert.match(initial, /Choose a section to begin\./);
  assert.equal((initial.match(/aria-expanded="true"/g) || []).length, 1);
  assert.match(initial, /aria-expanded="true" aria-controls="desktop-Usage"/);
  assert.doesNotMatch(initial, /aria-current="page"|usage-controls/);
  assert.doesNotMatch(initial, /class="item-column"|class="entry-detail"|role="tablist"/);
  assert.equal((initial.match(/<header\b/g) || []).length, 1);
  assert.doesNotMatch(initial, /about-view|popoverTarget|toolbar-actions|Collapse all|>Reload<|>Back</);
  assert.match(initial, /aria-label="OpenCode Inspector home" href="\/"/);
  assert.doesNotMatch(initial, /class="navigation-bar"|class="breadcrumbs"|class="header-line"|class="path-line"/);
  const build = snapshot.entries.find(entry => entry.category === 'Agents' && entry.id === 'build')!;
  const detail = renderToStaticMarkup(createElement(EntryDetail, { entry: build, entries: snapshot.entries, choose: () => {} }));
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
    const markup = renderToStaticMarkup(createElement(ItemColumn, { category: 'Agents', items, choose: () => {}, loading: false }));
    assert.equal(markup.includes('type="search"'), count > 12, `${count} entries`);
  }
});

test('subpage routes roundtrip, aliases agree, and history distinguishes Usage pages', () => {
  for (const pathname of ['/usage/overview', '/usage/agents', '/usage/models', '/usage/skills', '/settings/general', '/settings/theme']) {
    const view = parseLocation(pathname);
    assert.equal(view.invalid, false, pathname);
    assert.equal(routePath(view.route), pathname);
    assert.equal(routeSection(view.route), pathname.startsWith('/usage') ? 'Usage' : 'Settings');
  }
  assert.deepEqual(parseLocation('/usage'), parseLocation('/usage/overview'));
  assert.deepEqual(parseLocation('/settings'), parseLocation('/settings/general'));
  for (const pathname of ['/usage/theme', '/settings/agents', '/usage/agents/', '/settings/theme/extra']) assert.equal(parseLocation(pathname).invalid, true, pathname);
  const browser = fakeBrowser('/usage');
  const router = createBrowserNavigation(browser as unknown as Window);
  router.subscribe(() => {});
  router.go(usageRoute);
  assert.equal(browser.history.length, 1, 'alias and canonical page are the same destination');
  router.go({ ...usageRoute, subpage: 'agents' });
  router.go({ ...usageRoute, subpage: 'models' });
  browser.history.back();
  assert.equal(router.read().route.subpage, 'agents');
  browser.history.back();
  assert.equal(router.read().route.subpage, 'overview');
  browser.history.forward();
  assert.equal(router.read().route.subpage, 'agents');
});

test('sidebar uses exactly two levels, expansion buttons have no destinations, and collapsed parents stay marked', async () => {
  const snapshot = await inspect(path.resolve('examples/demo'));
  const route = parseLocation('/agents/build').route;
  const sidebar = renderToStaticMarkup(createElement(Sidebar, { route, expanded: 'Usage', expand: () => {}, go: () => {}, entries: snapshot.entries, prefix: 'test' }));
  assert.equal((sidebar.match(/<button\b/g) || []).length, 3);
  assert.equal((sidebar.match(/aria-expanded="true"/g) || []).length, 1);
  assert.match(sidebar, /<button[^>]*aria-expanded="false"[^>]*data-active="true"[^>]*><span>Config<\/span>/);
  assert.match(sidebar, /id="test-Config"[^>]*hidden=""/);
  assert.doesNotMatch(sidebar, /<button[^>]*href=|href="\/agents\/build"|role="tab/);
  assert.equal((sidebar.match(/<a\b/g) || []).length, 13, 'four Usage, seven Config, two Settings links');
  assert.match(sidebar, /href="\/usage\/models"/);
  assert.ok(sidebar.indexOf('href="/instructions"') < sidebar.indexOf('href="/agents"'));
  const render = (initialRoute: string) => renderToStaticMarkup(createElement(App, { initialSnapshot: snapshot, initialRoute }));
  for (const [pathname, section] of [['/agents/build', 'Config'], ['/usage/models', 'Usage'], ['/usage/skills', 'Usage'], ['/settings/theme', 'Settings']]) {
    const html = render(pathname);
    assert.match(html, new RegExp(`aria-expanded="true" aria-controls="desktop-${section}"`));
    assert.equal((html.match(/aria-expanded="true"/g) || []).length, 1);
    const header = html.match(/<header\b[^>]*>[\s\S]*?<\/header>/)![0];
    assert.doesNotMatch(header, /href="\/(usage|settings|agents)|role="tab/);
  }
  const detail = render('/agents/build');
  assert.doesNotMatch(detail, /breadcrumbs|aria-label="Breadcrumb"|detail-navigation|Back to|>Back<\/button>/);
  assert.match(detail, /class="item-column"/);
  assert.match(render('/agents'), /class="item-column"/);
  assert.match(render('/agents'), /<h1 tabindex="-1">Agents<\/h1>/);
  assert.doesNotMatch(render('/agents'), /class="entry-detail"/);
  assert.match(render('/agents'), /Choose a definition from agents to view its details\./);
  for (const category of Object.keys(categorySlugs) as (keyof typeof categorySlugs)[]) {
    const entry = snapshot.entries.find(candidate => candidate.category === category)!;
    const html = render(routePath({ category, id: entry.id }));
    assert.match(html, /<main class="detail-pane config-workspace" data-has-entry="true"/);
    const list = html.match(/<section class="item-column"[\s\S]*?<\/section>/)![0];
    assert.ok(list.includes(`aria-label="${category} list"`), category);
    assert.ok(list.includes(`aria-current="page" href="${routePath({ category, id: entry.id })}"`), category);
    assert.match(html, /<div class="config-detail">[\s\S]*class="entry-detail"/);
    assert.doesNotMatch(html, /breadcrumbs|aria-label="Breadcrumb"|detail-navigation|Back to|>Back<\/button>/);
    const picker = html.match(/<label class="mobile-item-picker">[\s\S]*?<\/label>/)![0];
    assert.ok(picker.startsWith(`<label class="mobile-item-picker">${category === 'Agents' ? 'Agent' : 'Definition'}`), category);
    assert.match(picker, /<select name="config-item">/);
    assert.match(picker, /<option value="">Choose (?:an agent|a definition)…<\/option>/);
    assert.equal((picker.match(/<option\b/g) || []).length, snapshot.entries.filter(candidate => candidate.category === category).length + 1, category);
    assert.equal((picker.match(/ selected=""/g) || []).length, 1, category);
    const landing = render(routePath({ category, id: null }));
    assert.match(landing, /class="item-column"/);
    assert.match(landing, /class="config-detail"/);
    assert.doesNotMatch(landing, /data-has-entry|class="entry-detail"|mobile-item-picker|breadcrumbs|detail-navigation|Back to|>Back<\/button>/);
  }
  for (const pathname of ['/usage/overview', '/usage/agents', '/usage/skills', '/settings/general', '/settings/theme']) {
    assert.doesNotMatch(render(pathname), /item-column|config-workspace|config-detail|mobile-item-picker/);
  }
  assert.match(detail, /<option value="build" selected="">Build<\/option>/);
  const css = await readFile(path.resolve('src/style.css'), 'utf8');
  assert.match(css, /\.mobile-item-picker \{ display: none; \}/);
  const mobileStyles = css.slice(css.indexOf('@media (max-width: 700px)'));
  assert.match(mobileStyles, /\.mobile-item-picker \{ display: flex;/);
  assert.match(mobileStyles, /\.mobile-item-picker select \{[^}]*min-height: 40px/);
  assert.doesNotMatch(css, /breadcrumbs|detail-navigation/);
});

test('list history restores the exact query and pixel scroll independently of detail disclosures and branch changes', async () => {
  const browser = fakeBrowser('/agents');
  const router = createBrowserNavigation(browser as unknown as Window);
  router.subscribe(() => {});
  const saved = { query: 'agent-12', scroll: 487 };
  router.saveList(saved);
  assert.equal(browser.history.length, 1);
  router.go({ category: 'Agents', id: 'build' }, saved);
  assert.deepEqual(router.list(), saved, 'the persistent list retains its query and scroll alongside the detail');
  router.disclosure('subagents', true);
  router.raw(true);
  router.go({ category: 'Agents', id: 'quick' }, saved);
  assert.deepEqual(router.list(), saved, 'switching entries retains the same list state');
  router.back();
  assert.equal(router.read().route.id, 'build');
  assert.deepEqual(router.read().open, ['subagents']);
  assert.equal(router.read().raw, true);
  browser.history.back();
  assert.deepEqual(router.list(), saved);
  browser.history.forward();
  router.go({ category: 'Agents', id: null }, saved);
  assert.deepEqual(router.list(), saved, 'the neutral item selection can reopen the remembered category list');
  assert.deepEqual(router.read().open, []);
  assert.equal(router.read().raw, false);
  router.saveList({ query: 'other', scroll: 92 });
  browser.history.back();
  browser.history.back();
  assert.deepEqual(router.list(), saved, 'older list history is not overwritten by a later visit');
  router.go({ category: 'Skills', id: null });
  assert.deepEqual(router.list(), { query: '', scroll: 0 }, 'a new branch clears discarded entry state');
  const snapshot = await inspect(path.resolve('examples/demo'));
  const entry = snapshot.entries.find(entry => entry.category === 'Agents')!;
  const items = Array.from({ length: 13 }, (_, index) => ({ ...entry, id: `agent-${index}`, name: `agent-${index}` }));
  const html = renderToStaticMarkup(createElement(ItemColumn, { category: 'Agents', items, choose: () => {}, loading: false, query: saved.query, selected: items[12] }));
  assert.match(html, /type="search"[^>]*value="agent-12"/);
  assert.match(html, /href="\/agents\/agent-12"/);
  assert.match(html, /aria-current="page" href="\/agents\/agent-12"/);
  assert.doesNotMatch(html, /href="\/agents\/agent-11"/);
});
