import express from 'express';
import path from 'node:path';
import os from 'node:os';
import { inspect } from './parser.js';
import { categorySlugs, parseLocation } from '../src/navigation.js';

export function createApp({ root = process.env.OPENCODE_CONFIG_ROOT || path.join(os.homedir(), '.config/opencode'), production = process.env.NODE_ENV === 'production', clientDirectory = path.resolve('dist/client') } = {}) {
  const app = express();
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
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'Not found' }); });
  if (production) {
    app.use((_req, res, next) => { res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'none'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"); next(); });
    // Only the asset namespace can resolve files. Definition URLs are lookup keys.
    app.use('/assets', express.static(path.join(clientDirectory, 'assets')));
    app.use('/assets', (_req, res) => { res.status(404).type('text').send('Asset not found'); });
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      const view = parseLocation(req.path);
      const knownPage = req.path.split('/')[1] === 'settings' || Object.values(categorySlugs).includes(req.path.split('/')[1]);
      if (!view.invalid || knownPage) return res.status(view.invalid ? 404 : 200).sendFile(path.join(clientDirectory, 'index.html'));
      // Browser navigations get an honest not-found view; missing files stay 404.
      if (req.accepts('html') && !path.extname(req.path)) return res.status(404).sendFile(path.join(clientDirectory, 'index.html'));
      next();
    });
  }
  app.use((_req, res) => { res.status(404).type('text').send('Not found'); });
  return app;
}
