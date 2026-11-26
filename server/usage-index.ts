import { DatabaseSync } from 'node:sqlite';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { readUsageSnapshot, type UsageRange } from './usage.js';
import { readIndexMetadata, usageSourceState, type IndexMetadata, type SourceState } from './usage-index-build.js';
import type { IndexedUsageResponse, UsageIndexState } from '../src/usage-types.js';

export function usageCacheDirectory() {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Caches') : path.join(os.homedir(), '.cache');
  return path.join(base, 'opencode-inspector', 'usage');
}
type Job = { identity: string; cancelled: boolean; task?: Promise<void>; child?: ChildProcess };
const initialFailure = 'Usage indexing failed. Use Refresh to retry.';
const refreshFailure = 'The usage index could not be refreshed; showing the previous indexed snapshot.';
const sourceFailure = 'The recorded usage source could not be checked; showing the previous indexed snapshot.';
const unavailableSource = 'Recorded usage is unavailable. Check the startup database selection and local read permissions.';
const autoCooldown = 5 * 60_000;
const failedCooldown = 5 * 60_000;

/** One configured source and worker per app. Status GETs wake dirty-cache rebuilds;
 * plain range GETs can initialize the index but never start a background refresh.
 */
export class UsageIndex {
  private job?: Job;
  private failure?: 'build' | 'accounting';
  private autoAfter = 0;
  private last?: SourceState;
  private checking?: Promise<SourceState | undefined>;
  private closed = false;
  private generation = 0;
  constructor(private directory = usageCacheDirectory(), private now = () => performance.now()) {}

  private filename(identity: string) { return path.join(this.directory, identity + '.sqlite'); }

  private async snapshot(identity: string, range?: UsageRange) {
    let db: DatabaseSync | undefined;
    let metadata: IndexMetadata | undefined;
    try {
      const filename = this.filename(identity), info = await lstat(filename);
      if (!info.isFile() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) return;
      db = new DatabaseSync(filename, { readOnly: true }); db.exec('PRAGMA query_only=ON; BEGIN');
      metadata = readIndexMetadata(db);
      if (metadata.identity !== identity) return;
      // Header and accounting share one pinned handle, including when another
      // app process atomically replaces the index while this request reads it.
      const result = range ? readUsageSnapshot(db, range, metadata.indexedAt, true) : undefined;
      db.exec('ROLLBACK');
      return { metadata, result };
    } catch { /* Missing, incompatible or incomplete indexes are never served. */ }
    finally { db?.close(); }
    // A valid header with unrepresentable accounting is an error, not a reason
    // for repeated automatic rebuilds of the same source snapshot.
    if (metadata?.identity === identity) return { metadata, result: undefined };
  }

  private start(source: SourceState, automatic = false) {
    if (this.job || this.closed) return;
    if (!automatic) this.failure = undefined;
    const job: Job = { identity: source.identity, cancelled: false };
    this.job = job;
    const finish = (failed: boolean) => {
      if (job.cancelled || this.closed) return;
      this.failure = failed ? 'build' : undefined;
      this.autoAfter = this.now() + (failed ? failedCooldown : autoCooldown);
    };
    job.task = this.build(source, job).then(() => finish(false), () => finish(true)).finally(() => {
      this.generation++;
      this.job = undefined;
    });
  }

  private async build(source: SourceState, job: Job) {
    let temporary: string | undefined;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const directory = await lstat(this.directory);
      if (!directory.isDirectory() || (process.getuid && directory.uid !== process.getuid())) throw new Error('Invalid cache directory');
      await chmod(this.directory, 0o700);
      if (job.cancelled) throw new Error('Cancelled');
      temporary = path.join(this.directory, `${source.identity}.${randomUUID()}.building`);
      const file = await open(temporary, 'wx', 0o600); await file.close();
      if (job.cancelled) throw new Error('Cancelled');
      const development = import.meta.url.endsWith('.ts');
      const worker = fileURLToPath(new URL(development ? './usage-worker.ts' : './usage-worker.js', import.meta.url));
      const child = fork(worker, [source.filename, temporary, source.identity], {
        execArgv: development ? ['--import', 'tsx'] : [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      job.child = child;
      await new Promise<void>((resolve, reject) => {
        let complete = false, timedOut = false;
        const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 10 * 60_000);
        timeout.unref();
        child.on('message', message => { if (message && typeof message === 'object' && 'complete' in message) complete = message.complete === true; });
        child.once('error', error => { clearTimeout(timeout); reject(error); });
        child.once('exit', code => { clearTimeout(timeout); code === 0 && complete && !timedOut ? resolve() : reject(new Error('Indexing failed')); });
      });
      if (job.cancelled) throw new Error('Cancelled');
      // The child has exited and closed both SQLite handles before publication.
      const db = new DatabaseSync(temporary, { readOnly: true });
      try { db.exec('PRAGMA query_only=ON'); if (readIndexMetadata(db).identity !== source.identity) throw new Error('Invalid index'); }
      finally { db.close(); }
      await chmod(temporary, 0o600);
      if (job.cancelled) throw new Error('Cancelled');
      await rename(temporary, this.filename(source.identity));
    } finally {
      if (temporary) await Promise.all(['', '-journal', '-wal', '-shm'].map(suffix => rm(temporary + suffix, { force: true })));
    }
  }

  private async stopJob() {
    const job = this.job;
    if (!job) return;
    job.cancelled = true; job.child?.kill();
    await job.task;
  }

  async close() { this.closed = true; await this.stopJob(); }

  private async checkSource(filename: string) {
    let source: SourceState;
    try { source = await usageSourceState(filename); }
    catch { return; } // Old snapshots remain readable when the source is temporarily unavailable.
    if (this.closed) return;
    if (this.last?.identity !== source.identity) {
      this.last = source;
      this.failure = undefined;
      this.autoAfter = 0;
      await this.stopJob();
    }
    return source;
  }

  private async inspect(filename: string | undefined, range?: UsageRange, refresh = false, observe = false, rebuild = false) {
    const unavailable: UsageIndexState = { state: 'failed', indexedAt: null, sourceChanged: null, message: unavailableSource };
    while (!this.closed && filename && path.isAbsolute(filename)) {
      // Coalesce source discovery and identity transitions before either request
      // can read a cache or start a worker for the replacement.
      const source = await (this.checking ??= this.checkSource(filename).finally(() => { this.checking = undefined; }));
      const identity = source?.identity ?? this.last?.identity;
      if (!identity) break;
      const observedJob = this.job;
      let cached, generation;
      do {
        generation = this.generation;
        cached = await this.snapshot(identity, range);
        // Publication can race the filesystem lookup, even for a missing cache.
      } while (!this.closed && generation !== this.generation && this.last?.identity === identity);
      if (this.closed) break;
      if (this.last?.identity !== identity) continue;

      const metadata = cached?.metadata;
      const sourceChanged = !source ? null : metadata ? metadata.changedDuringBuild || source.fingerprint !== metadata.fingerprint : true;
      if (rebuild && source && !this.job && observedJob?.identity !== identity) {
        this.start(source);
      } else if (refresh && !this.job && observedJob?.identity !== identity) {
        if (source) this.start(source); else this.failure = 'build';
      } else if (!observe && !metadata && !this.job && !this.failure && source) {
        this.start(source);
      } else if (!observe && !range && source && sourceChanged && metadata && !this.job && this.failure !== 'accounting' && this.now() >= this.autoAfter) {
        this.start(source, true);
      }
      const result = cached?.result;
      const badAccounting = range && metadata && (!result || result.status === 'unavailable');
      if (badAccounting) this.failure = 'accounting';
      const job = this.job?.identity === identity;
      const message = !metadata ? (job ? undefined : observe && source && !this.failure ? undefined : initialFailure)
        : badAccounting ? initialFailure
        : this.failure ? refreshFailure
        : !source ? sourceFailure : undefined;
      const index: UsageIndexState = {
        state: !metadata ? (job ? 'indexing' : observe && source && !this.failure ? 'ready' : 'failed')
          : badAccounting ? 'failed' : job ? 'refreshing' : message ? 'failed' : 'ready',
        indexedAt: metadata?.indexedAt ?? null,
        sourceChanged: !metadata && job && source ? false : sourceChanged,
        ...(message ? { message } : {}),
      };
      return { index, result };
    }
    return { index: unavailable };
  }

  async status(filename: string | undefined): Promise<UsageIndexState> {
    return (await this.inspect(filename)).index;
  }

  async observe(filename: string | undefined): Promise<UsageIndexState> {
    return (await this.inspect(filename, undefined, false, true)).index;
  }

  async rebuild(filename: string | undefined): Promise<UsageIndexState> {
    return (await this.inspect(filename, undefined, false, false, true)).index;
  }

  async read(filename: string | undefined, range: UsageRange, refresh = false): Promise<IndexedUsageResponse> {
    const { index, result } = await this.inspect(filename, range, refresh);
    if (index.state === 'indexing') {
      return { status: 'indexing', updatedAt: new Date().toISOString(), range, index: { ...index, state: 'indexing', indexedAt: null } };
    }
    const { message, ...state } = index;
    if (!result || result.status === 'unavailable') {
      return { status: 'unavailable', updatedAt: new Date().toISOString(), message: message ?? initialFailure, index: index.indexedAt === null ? state : index };
    }
    return { ...result, ...(message ? { status: 'partial' as const, warnings: [...result.warnings, message] } : {}), index };
  }
}
