import type { Category } from './types';

export type UsagePage = 'overview' | 'agents' | 'models' | 'skills';
export type SettingsPage = 'general' | 'theme';
export type NavigationSection = 'Usage' | 'Config' | 'Settings';
export interface Route { category: Category | null; id: string | null; page?: 'settings' | 'usage'; subpage?: UsagePage | SettingsPage }
export const categorySlugs: Record<Category, string> = {
  Agents: 'agents', Skills: 'skills', Commands: 'commands', Models: 'models',
  'MCP Servers': 'mcp-servers', Plugins: 'plugins', Instructions: 'instructions',
};
export const sectionKeys = ['about', 'model-settings', 'subagents', 'task-rules', 'prompt', 'instructions', 'permissions', 'agent-rules', 'context-limits', 'sources', 'provenance', 'raw-configuration'] as const;
export interface LocationView { route: Route; invalid: boolean; open: string[]; raw: boolean }
export const home: Route = { category: null, id: null };
export const settingsRoute: Route = { category: null, id: null, page: 'settings', subpage: 'general' };
export const usageRoute: Route = { category: null, id: null, page: 'usage', subpage: 'overview' };
export function routeSection(route: Route): NavigationSection | null {
  return route.page === 'usage' ? 'Usage' : route.page === 'settings' ? 'Settings' : route.category ? 'Config' : null;
}
export interface ListState { query: string; scroll: number }
const emptyList: ListState = { query: '', scroll: 0 };

export function routePath(route: Route): string {
  if (route.page === 'settings' || route.page === 'usage') return `/${route.page}/${route.subpage || (route.page === 'usage' ? 'overview' : 'general')}`;
  // Browsers normalize even percent-encoded dot-only path segments. Reserve a
  // tilde escape for those IDs (and escape literal leading tildes as well).
  const escaped = route.id === '.' || route.id === '..' || route.id?.startsWith('~') ? `~${route.id}` : route.id;
  const id = escaped !== null ? encodeURIComponent(escaped) : null;
  return route.category ? `/${categorySlugs[route.category]}${id !== null ? `/${id}` : ''}` : '/';
}

// Decode only once. IDs are snapshot lookup keys, never filesystem paths.
export function parseLocation(pathname: string, search = ''): LocationView {
  let route = home;
  let invalid = false;
  if (pathname === '/settings' || pathname === '/settings/general') route = settingsRoute;
  else if (pathname === '/settings/theme') route = { ...settingsRoute, subpage: 'theme' };
  else if (pathname === '/usage' || pathname === '/usage/overview') route = usageRoute;
  else if (pathname === '/usage/agents' || pathname === '/usage/models' || pathname === '/usage/skills') route = { ...usageRoute, subpage: pathname.split('/')[2] as UsagePage };
  else if (pathname !== '/') {
    const match = /^\/([^/]+)(?:\/(.+))?$/.exec(pathname);
    const category = Object.keys(categorySlugs).find(key => categorySlugs[key as Category] === match?.[1]) as Category | undefined;
    if (!match || !category) invalid = true;
    else {
      try {
        const decoded = match[2] === undefined ? null : decodeURIComponent(match[2]);
        route = { category, id: decoded?.startsWith('~') ? decoded.slice(1) : decoded };
      }
      catch { invalid = true; }
    }
  }
  const params = new URLSearchParams(search);
  const open = [...new Set((params.get('open') || '').split(',').filter(key => (sectionKeys as readonly string[]).includes(key)))];
  return { route, invalid, open, raw: params.get('raw') === '1' };
}

const markerKey = 'opencodeInspectorNavigation';
type Browser = Pick<Window, 'location' | 'history' | 'addEventListener' | 'removeEventListener'>;
export function createBrowserNavigation(browser: Browser) {
  const listeners = new Set<() => void>();
  // Scroll events update memory, not replaceState on every frame. Depth is
  // unique within the live stack; a new branch replaces its discarded depths.
  const lists = new Map<number, ListState>();
  const read = () => parseLocation(browser.location.pathname, browser.location.search);
  const depth = () => {
    const value = browser.history.state?.[markerKey];
    return value?.version === 1 && Number.isSafeInteger(value.depth) && value.depth >= 0 ? value.depth : 0;
  };
  const state = (value: number) => ({ ...browser.history.state, [markerKey]: { version: 1, depth: value } });
  const notify = () => listeners.forEach(listener => listener());
  const list = (): ListState => lists.get(depth()) || browser.history.state?.opencodeInspectorList || emptyList;
  return {
    read,
    list,
    saveList: (value: ListState) => { lists.set(depth(), value); },
    canBack: () => depth() > 0 || browser.location.pathname !== '/',
    subscribe(listener: () => void) {
      if (!listeners.size) {
        browser.history.replaceState(state(depth()), '', browser.location.href);
        browser.addEventListener('popstate', notify);
      }
      listeners.add(listener);
      return () => { listeners.delete(listener); if (!listeners.size) browser.removeEventListener('popstate', notify); };
    },
    go(route: Route, nextList: ListState = emptyList) {
      const current = read();
      if (!current.invalid && routePath(route) === routePath(current.route)) return;
      browser.history.replaceState({ ...browser.history.state, opencodeInspectorList: list() }, '', browser.location.href);
      lists.set(depth() + 1, nextList);
      browser.history.pushState({ ...state(depth() + 1), opencodeInspectorList: nextList }, '', routePath(route));
      notify();
    },
    back() {
      if (depth() > 0) browser.history.back();
      else {
        const current = read();
        const fallback = !current.invalid && current.route.id !== null ? { ...current.route, id: null } : home;
        lists.set(0, emptyList);
        browser.history.replaceState(state(0), '', routePath(fallback));
        notify();
      }
    },
    disclosure(key: string, expanded: boolean) {
      if (!(sectionKeys as readonly string[]).includes(key)) return;
      const current = read();
      if (current.open.includes(key) === expanded) return;
      const open = expanded ? [...current.open, key] : current.open.filter(value => value !== key);
      const url = new URL(browser.location.href);
      if (open.length) url.searchParams.set('open', open.join(',')); else url.searchParams.delete('open');
      browser.history.replaceState(state(depth()), '', url.pathname + url.search);
      notify();
    },
    raw(enabled: boolean) {
      const url = new URL(browser.location.href);
      if (enabled) url.searchParams.set('raw', '1'); else url.searchParams.delete('raw');
      browser.history.replaceState(state(depth()), '', url.pathname + url.search);
      notify();
    },
  };
}
