import { buildUsageIndex } from './usage-index-build.js';

const [source, destination, identity] = process.argv.slice(2);
const orphaned = () => process.exit(1);
process.once('disconnect', orphaned);
try {
  await buildUsageIndex(source, destination, identity);
  process.send?.({ complete: true });
  process.removeListener('disconnect', orphaned);
  process.disconnect?.();
} catch {
  // Never send SQLite errors, paths, names or source content over IPC/logs.
  process.send?.({ complete: false });
  process.removeListener('disconnect', orphaned);
  process.disconnect?.();
  process.exitCode = 1;
}
