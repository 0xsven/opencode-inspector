import { after } from 'node:test';
import { createComponent, type Component } from 'solid-js';
import { renderToString } from 'solid-js/web';
import { createServer } from 'vite';
import solid from 'vite-plugin-solid';

// Compile the UI through Solid's SSR transform for markup assertions. The
// application still serves a client-rendered shell in production.
const vite = createServer({
  configFile: false,
  plugins: [solid({ ssr: true, hot: false })],
  appType: 'custom',
  server: { middlewareMode: true, ws: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
});
after(async () => { await (await vite).close(); });

export async function loadComponents<T>(path: string): Promise<T> {
  return (await vite).ssrLoadModule(path) as Promise<T>;
}

export function renderComponent<P extends Record<string, unknown>>(component: Component<P>, props: P) {
  return renderToString(() => createComponent(component, props)).replace(/ data-hk="[^"]*"|<!--!?\$?\/?-->/g, '');
}
