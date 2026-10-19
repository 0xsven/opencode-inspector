import type { Category } from './types';

export interface Route { category: Category | null; id: string | null; page?: 'settings' }
export const categorySlugs: Record<Category, string> = {
  Agents: 'agents', Skills: 'skills', Commands: 'commands', Models: 'models',
  'MCP Servers': 'mcp-servers', Plugins: 'plugins', Instructions: 'instructions',
};
export const sectionKeys = ['about', 'model-settings', 'subagents', 'task-rules', 'prompt', 'instructions', 'permissions', 'agent-rules', 'context-limits', 'sources', 'provenance', 'raw-configuration'] as const;
export interface LocationView { route: Route; invalid: boolean; open: string[]; raw: boolean }
export const home: Route = { category: null, id: null };
export const settingsRoute: Route = { category: null, id: null, page: 'settings' };

export function routePath(route: Route): string {
  if (route.page === 'settings') return '/settings';
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
  if (pathname === '/settings') route = settingsRoute;
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
  const read = () => parseLocation(browser.location.pathname, browser.location.search);
  const depth = () => {
    const value = browser.history.state?.[markerKey];
    return value?.version === 1 && Number.isSafeInteger(value.depth) && value.depth >= 0 ? value.depth : 0;
  };
  const state = (value: number) => ({ ...browser.history.state, [markerKey]: { version: 1, depth: value } });
  const notify = () => listeners.forEach(listener => listener());
  return {
    read,
    canBack: () => depth() > 0 || browser.location.pathname !== '/',
    subscribe(listener: () => void) {
      if (!listeners.size) {
        browser.history.replaceState(state(depth()), '', browser.location.href);
        browser.addEventListener('popstate', notify);
      }
      listeners.add(listener);
      return () => { listeners.delete(listener); if (!listeners.size) browser.removeEventListener('popstate', notify); };
    },
    go(route: Route) {
      const current = read();
      if (!current.invalid && route.page === current.route.page && route.category === current.route.category && route.id === current.route.id) return;
      browser.history.pushState(state(depth() + 1), '', routePath(route));
      notify();
    },
    back() {
      if (depth() > 0) browser.history.back();
      else {
        const current = read();
        const fallback = !current.invalid && current.route.id !== null ? { ...current.route, id: null } : home;
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
