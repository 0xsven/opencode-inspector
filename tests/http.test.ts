import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';

test('production deep links serve the shell, API and missing assets keep their contracts', async () => {
  const clientDirectory = await mkdtemp(path.join(os.tmpdir(), 'inspector-http-'));
  await mkdir(path.join(clientDirectory, 'assets'));
  await writeFile(path.join(clientDirectory, 'index.html'), '<!doctype html><title>Inspector shell</title>');
  const server = createApp({ production: true, clientDirectory, root: path.resolve('examples/demo') }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address() as { port: number };
  const get = (url: string, headers = {}, method = 'GET') => new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: address.port, path: url, method, headers: { host: '127.0.0.1:4317', ...headers } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, type: String(res.headers['content-type']), body }));
    }); req.on('error', reject); req.end();
  });
  try {
    for (const url of ['/', '/settings', '/agents', '/agents/build?open=prompt', '/models/openai%2Fgpt-6.1-sol', '/plugins/.%2Fplugins%2Ffoo.ts', '/skills/a%20b%25%3F%23', '/commands/x', '/mcp-servers/x', '/instructions/x']) {
      const response = await get(url);
      assert.equal(response.status, 200, url); assert.match(response.body, /Inspector shell/);
    }
    const unknown = await get('/unknown', { accept: 'text/html' });
    assert.equal(unknown.status, 404); assert.match(unknown.body, /Inspector shell/);
    for (const url of ['/agents/%', '/agents/%E0%A4%A', '/agents/', '/settings/extra', '/settings/', '/settings/%']) {
      const response = await get(url); assert.equal(response.status, 404); assert.match(response.body, /Inspector shell/);
    }
    const pathLikeId = await get('/instructions/%2Fetc%2Fpasswd');
    assert.equal(pathLikeId.status, 200); assert.match(pathLikeId.body, /Inspector shell/);
    for (const url of ['/assets/missing.js', '/missing.css']) {
      const response = await get(url); assert.equal(response.status, 404); assert.doesNotMatch(response.type, /html/);
    }
    const api = await get('/api/missing');
    assert.equal(api.status, 404); assert.match(api.type, /json/);
    assert.equal((await get('/agents/build', { host: 'evil.test' })).status, 403);
    for (const url of ['/api/snapshot', '/API/snapshot', '/Api/SnApShOt']) {
      assert.equal((await get(url, {}, 'POST')).status, 405, url);
      assert.equal((await get(url, {}, 'HEAD')).status, 405, url);
      assert.equal((await get(url, { origin: 'http://evil.test' })).status, 403, url);
      assert.equal((await get(url, { 'sec-fetch-site': 'cross-site' })).status, 403, url);
      assert.equal((await get(url)).status, 200, url);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(clientDirectory, { recursive: true, force: true });
  }
});
