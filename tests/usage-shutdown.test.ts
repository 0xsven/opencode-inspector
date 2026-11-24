import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, writeFile, readdir, stat, rm, symlink } from 'node:fs/promises';
import { build } from 'esbuild';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';

async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 1000; i++) { if (await check()) return; await delay(10); }
  throw new Error('Process lifecycle timed out');
}

test('SIGINT and SIGTERM through the API entry and launcher await active worker and temporary-file cleanup', { timeout: 45000 }, async () => {
  const root = path.resolve('.'), directory = await mkdtemp(path.join(os.tmpdir(), 'inspector-shutdown-'));
  const source = path.join(directory, 'source.db'), db = new DatabaseSync(source);
  try {
    db.exec(`CREATE TABLE session(id TEXT PRIMARY KEY, parent_id TEXT, time_created INTEGER);
      CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      INSERT INTO session VALUES('root', NULL, 0);
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<80000)
      INSERT INTO message SELECT 'message-'||x, 'root', 1000, 1000,
        '{"role":"assistant","agent":"build","tokens":{"input":1,"output":2,"reasoning":3,"cache":{"read":4,"write":5}}}' FROM n;`);
  } finally { db.close(); }
  const before = await stat(source);
  // Only substitute an ephemeral port and observe the real worker PID. Run the
  // actual production bundles and launcher with their existing dependencies.
  const preload = path.join(directory, 'observe.mjs');
  await writeFile(preload, `import { Server } from 'node:http';
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const listen = Server.prototype.listen;
    Server.prototype.listen = function(...args) {
      args[0] = 0;
      this.once('listening', () => console.log('TEST_PORT=' + this.address().port));
      return Reflect.apply(listen, this, args);
    };
    const fork = cp.fork;
    cp.fork = (...args) => { const child = fork(...args); console.log('TEST_WORKER=' + child.pid); return child; };
    syncBuiltinESMExports();`);
  await symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
  await build({ entryPoints: [path.join(root, 'server/index.ts'), path.join(root, 'server/usage-worker.ts')], bundle: true, platform: 'node', format: 'esm', packages: 'external', outdir: path.join(directory, 'dist/server') });
  try {
    for (const launcher of [false, true]) for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const cache = path.join(directory, `${launcher}-${signal}`);
      const child = spawn(process.execPath, launcher ? [path.join(root, 'scripts/launch.mjs'), 'start'] : [path.join(directory, 'dist/server/index.js')], {
        cwd: directory,
        env: { ...process.env, NODE_ENV: 'production', OPENCODE_INSPECTOR_DB: source, OPENCODE_CONFIG_ROOT: path.join(root, 'examples/demo'), XDG_CACHE_HOME: cache, NODE_OPTIONS: `--import ${pathToFileURL(preload).href}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '', errors = '', worker = 0;
      child.stdout.on('data', chunk => { output += chunk; worker = Number(/TEST_WORKER=(\d+)/.exec(output)?.[1] || 0); });
      child.stderr.on('data', chunk => { errors += chunk; });
      try {
        await until(() => /TEST_PORT=\d+/.test(output) || child.exitCode !== null);
        assert.equal(child.exitCode, null, errors);
        const port = Number(/TEST_PORT=(\d+)/.exec(output)![1]);
        const dto = await new Promise<any>((resolve, reject) => {
          const req = request({ hostname: '127.0.0.1', port, path: '/api/usage?from=0&to=86400000&timezone=UTC', headers: { host: '127.0.0.1:4317' } }, res => {
            let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve(JSON.parse(body)));
          }); req.on('error', reject); req.end();
        });
        assert.equal(dto.status, 'indexing');
        const usage = path.join(cache, 'opencode-inspector/usage');
        // Wait until projection has spilled actual metadata, then interrupt it
        // while its synchronous work and source read snapshot are active.
        await until(async () => {
          const files = await readdir(usage).catch(() => []);
          for (const file of files.filter(file => file.endsWith('.building'))) {
            if (worker && (await stat(path.join(usage, file))).size > 8192) return true;
          }
          return false;
        }).catch(async error => { throw new Error(`${error.message}: ${launcher}/${signal}, worker=${worker}, output=${output}, errors=${errors}, files=${await readdir(usage)}`); });
        child.kill(signal);
        await until(() => child.exitCode !== null || child.signalCode !== null);
        assert.equal(child.exitCode, 0, `${launcher}/${signal}: ${errors}`);
        assert.throws(() => process.kill(worker, 0), { code: 'ESRCH' });
        assert.deepEqual(await readdir(usage), []);
        assert.equal((await stat(source)).mtimeMs, before.mtimeMs);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        if (worker) { try { process.kill(worker, 'SIGKILL'); } catch { /* Already reaped. */ } }
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
