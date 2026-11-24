import express from 'express';
import path from 'node:path';
import { globalConfigRoot } from './config-root.js';
import { inspect } from './parser.js';
import { categorySlugs, parseLocation } from '../src/navigation.js';
import { parseUsageRange, resolveUsageDatabase } from './usage.js';
import { UsageIndex } from './usage-index.js';
import type { Server } from 'node:http';

export function createApp({ root = process.env.OPENCODE_CONFIG_ROOT || globalConfigRoot(), production = process.env.NODE_ENV === 'production', clientDirectory = path.resolve('dist/client'), usageDatabase = undefined as string | undefined, usageCacheDirectory = undefined as string | undefined } = {}) {
  const database = usageDatabase === undefined ? resolveUsageDatabase(root) : Promise.resolve(usageDatabase);
  const usage = new UsageIndex(usageCacheDirectory);
  const app = express();
  app.locals.closeUsage = () => usage.close();
  const listen = app.listen.bind(app);
  app.listen = ((...args: any[]) => {
    const server = Reflect.apply(listen, undefined, args) as Server;
    server.once('close', () => { void usage.close(); });
    const close = server.close.bind(server);
    server.close = ((callback?: (error?: Error) => void) => {
      const disposed = usage.close();
      close(error => { void disposed.then(() => callback?.(error)); });
      return server;
    }) as typeof server.close;
    return server;
  }) as typeof app.listen;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
    const hosts = new Set(['127.0.0.1:4317', 'localhost:4317', ...(process.env.NODE_ENV === 'development' ? ['127.0.0.1:5173', 'localhost:5173'] : [])]);
    if (!hosts.has(req.headers.host || '')) return void res.status(403).send('Forbidden host');
    if (req.path.toLowerCase().startsWith('/api')) {
      if (req.headers['sec-fetch-site'] === 'cross-site') return void res.status(403).json({ error: 'Forbidden origin' });
      if (req.headers.origin) { try { const u = new URL(req.headers.origin); if (u.protocol !== 'http:' || !hosts.has(u.host)) throw 0; } catch { return void res.status(403).json({ error: 'Forbidden origin' }); } }
      if (req.method !== 'GET') return void res.status(405).json({ error: 'Read-only API' });
    }
    next();
  });
  app.get('/api/snapshot', async (_req, res) => {
    try { res.json(await inspect(root)); } catch { res.status(500).json({ error: 'Could not read the configured directory. Check the path and local file permissions.' }); }
  });
  app.get('/api/usage', async (req, res) => {
    const { refresh, ...query } = req.query;
    const range = parseUsageRange(query);
    if (!range || (refresh !== undefined && refresh !== '1')) return void res.status(400).json({ error: 'Expected from/to epoch milliseconds, an exclusive end within 32 days (26 hours for hourly granularity), an IANA timezone, and optional granularity=hour|day and refresh=1.' });
    res.json(await usage.read(await database, range, refresh === '1'));
  });
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'Not found' }); });
  if (production) {
    app.use((_req, res, next) => { res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'none'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"); next(); });
    // Only the asset namespace can resolve files. Definition URLs are lookup keys.
    app.use('/assets', express.static(path.join(clientDirectory, 'assets')));
    app.use('/assets', (_req, res) => { res.status(404).type('text').send('Asset not found'); });
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      const view = parseLocation(req.path);
      // The shared codec includes Usage/Settings subpages and their legacy aliases.
      const knownPage = ['settings', 'usage'].includes(req.path.split('/')[1]) || Object.values(categorySlugs).includes(req.path.split('/')[1]);
      if (!view.invalid || knownPage) return res.status(view.invalid ? 404 : 200).sendFile(path.join(clientDirectory, 'index.html'));
      // Browser navigations get an honest not-found view; missing files stay 404.
      if (req.accepts('html') && !path.extname(req.path)) return res.status(404).sendFile(path.join(clientDirectory, 'index.html'));
      next();
    });
  }
  app.use((_req, res) => { res.status(404).type('text').send('Not found'); });
  return app;
}
