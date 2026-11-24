import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const mode = process.argv[2];
const args = process.argv.slice(3);
if (args.length && (args[0] !== '--config' || args.length !== 2)) {
  console.error('Usage: npm run dev -- --config <directory>'); process.exit(1);
}
const env = { ...process.env, ...(args[1] ? { OPENCODE_CONFIG_ROOT: resolve(args[1]) } : {}), NODE_ENV: mode === 'dev' ? 'development' : 'production' };
const children = [];
const run = (cmd, argv) => { const p = spawn(cmd, argv, { env, stdio: 'inherit' }); children.push(p); p.on('error', () => stop(1)); p.on('exit', code => { if (code) stop(code); }); };
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  const exited = Promise.all(children.map(p => new Promise(resolve => {
    if (p.exitCode !== null || p.signalCode !== null || !p.pid) return resolve();
    p.once('exit', resolve);
    p.kill('SIGTERM');
  })));
  // Give the API time to close its usage worker and clean unpublished files.
  // Retain a bounded escape for an unresponsive API or development server.
  const timeout = setTimeout(() => {
    for (const p of children) if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
    process.exit(code || 1);
  }, 5000);
  await exited;
  clearTimeout(timeout);
  process.exit(code);
}
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
if (mode === 'dev') { run(process.execPath, ['--import', 'tsx', 'server/index.ts']); run(process.execPath, ['node_modules/vite/bin/vite.js']); }
else run(process.execPath, ['dist/server/index.js']);
