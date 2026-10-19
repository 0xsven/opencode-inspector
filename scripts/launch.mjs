import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const mode = process.argv[2];
const args = process.argv.slice(3);
if (args.length && (args[0] !== '--config' || args.length !== 2)) {
  console.error('Usage: npm run dev -- --config <directory>'); process.exit(1);
}
const env = { ...process.env, ...(args[1] ? { OPENCODE_CONFIG_ROOT: resolve(args[1]) } : {}), NODE_ENV: mode === 'dev' ? 'development' : 'production' };
const children = [];
const run = (cmd, argv) => { const p = spawn(cmd, argv, { env, stdio: 'inherit' }); children.push(p); p.on('exit', code => { if (code) stop(code); }); };
let stopping = false;
function stop(code = 0) { if (stopping) return; stopping = true; for (const p of children) p.kill('SIGTERM'); setTimeout(() => process.exit(code), 150); }
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
if (mode === 'dev') { run(process.execPath, ['--import', 'tsx', 'server/index.ts']); run(process.execPath, ['node_modules/vite/bin/vite.js']); }
else run(process.execPath, ['dist/server/index.js']);
