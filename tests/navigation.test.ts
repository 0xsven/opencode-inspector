import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { App, EntryDetail, ItemColumn } from '../src/App.js';
import { categorySlugs, createBrowserNavigation, home, parseLocation, routePath, settingsRoute } from '../src/navigation.js';
import { inspect } from '../server/parser.js';
import path from 'node:path';

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

test('Settings owns Appearance and configuration information without header controls or overlays', async () => {
  const snapshot = await inspect(path.resolve('examples/demo'));
  const html = renderToStaticMarkup(createElement(App, { initialSnapshot: snapshot, initialRoute: '/settings' }));
  assert.doesNotMatch(html, /about-view|popoverTarget|toolbar-actions|Collapse all|>Reload<|>Back</);
  assert.match(html, /Configuration information/);
  assert.match(html, /Config root/);
  assert.match(html, /<h1>Settings<\/h1>/);
  assert.match(html, /Preferences for this browser\. Your OpenCode configuration is unchanged\./);
  for (const text of ['<legend>Appearance</legend>', 'Inspector default', 'appearance-status', 'Follow reads configured', 'Desktop has separate browser storage', 'System is a browser approximation']) assert.ok(html.includes(text), text);
  assert.match(html, /class="list-row settings-link" aria-current="page" href="\/settings"/);
  assert.match(html, /<option value="settings" selected="">Settings<\/option>/);
  assert.doesNotMatch(html, /class="item-column"|name="item"|Choose a category to begin/);
  const pending = renderToStaticMarkup(createElement(App, { initialRoute: '/settings' }));
  assert.match(pending, /<h1>Settings<\/h1>/);
  assert.match(pending, /Reading configured theme and available palettes/);
  const invalid = renderToStaticMarkup(createElement(App, { initialSnapshot: snapshot, initialRoute: '/settings/foo' }));
  assert.match(invalid, /Page not found/);
  assert.doesNotMatch(invalid, /<h1>Settings<\/h1>|appearance-controls|class="item-column"/);
});

test('direct-route initial render selects exactly the URL item, with honest missing/invalid states', async () => {
  const snapshot = await inspect(path.resolve('examples/demo'));
  const render = (initialRoute: string) => renderToStaticMarkup(createElement(App, { initialSnapshot: snapshot, initialRoute }));
  assert.match(render('/agents/build?open=model-settings,prompt&raw=1'), /<h1>Build<\/h1>/);
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

test('initial markup selects nothing and item disclosures are closed by default', async () => {
  const snapshot = await inspect(path.resolve('examples/demo'));
  const initial = renderToStaticMarkup(createElement(App, { initialSnapshot: snapshot }));
  assert.match(initial, /Choose a category to begin\./);
  assert.doesNotMatch(initial, /aria-expanded="true"|aria-pressed="true"/);
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
