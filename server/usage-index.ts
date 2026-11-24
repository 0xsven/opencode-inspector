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

/** One configured source per app. No timer, watcher, automatic refresh or DTO cache.
 * A request checks file metadata; only initial indexing and explicit Refresh fork
 * a child. Failed jobs are latched until Refresh, preventing polling retry loops.
 */
export class UsageIndex {
  private job?: Job;
  private failure?: string;
  private last?: SourceState;
  private closed = false;
  private generation = 0;
  constructor(private directory = usageCacheDirectory()) {}

  private filename(identity: string) { return path.join(this.directory, identity + '.sqlite'); }

  private async snapshot(identity: string, range: UsageRange) {
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
      const result = readUsageSnapshot(db, range, metadata.indexedAt, true);
      db.exec('ROLLBACK');
      return { metadata, result };
    } catch { /* Missing, incompatible or incomplete indexes are never served. */ }
    finally { db?.close(); }
    // A valid header with unrepresentable accounting is an error, not a reason
    // for repeated automatic rebuilds of the same source snapshot.
    if (metadata?.identity === identity) return { metadata, result: undefined };
  }

  private start(source: SourceState) {
    if (this.job || this.closed) return;
    this.failure = undefined;
    const job: Job = { identity: source.identity, cancelled: false };
    this.generation++;
    this.job = job;
    job.task = this.build(source, job).catch(() => {
      if (!job.cancelled && !this.closed) this.failure = source.identity;
    }).finally(() => { if (this.job === job) this.job = undefined; });
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

  async read(filename: string | undefined, range: UsageRange, refresh = false): Promise<IndexedUsageResponse> {
    const unavailable = (index: UsageIndexState, message = initialFailure): IndexedUsageResponse => ({ status: 'unavailable', updatedAt: new Date().toISOString(), message, index });
    if (this.closed || !filename || !path.isAbsolute(filename)) return unavailable({ state: 'failed', indexedAt: null, sourceChanged: null }, 'Recorded usage is unavailable. Check the startup database selection and local read permissions.');
    let source: SourceState | undefined;
    try { source = await usageSourceState(filename); } catch { /* Old snapshots remain readable when the source is temporarily unavailable. */ }
    if (source && this.last?.identity !== source.identity) {
      await this.stopJob(); this.failure = undefined; this.last = source;
    }
    const identity = source?.identity ?? this.last?.identity;
    if (!identity) return unavailable({ state: 'failed', indexedAt: null, sourceChanged: null }, 'Recorded usage is unavailable. Check the startup database selection and local read permissions.');
    const generation = this.generation, observedJob = this.job;
    let cached = await this.snapshot(identity, range);
    // A missing-file lookup can finish after publication. Do not accidentally
    // launch a second initial build because that filesystem result was stale.
    if (!cached && (generation !== this.generation || (observedJob && !this.job))) cached = await this.snapshot(identity, range);
    const metadata = cached?.metadata;
    if (refresh && !this.job) {
      if (source) this.start(source); else this.failure = identity;
    } else if (!metadata && !this.job && this.failure !== identity && source) this.start(source);
    if (!metadata) {
      if (this.job) return { status: 'indexing', updatedAt: new Date().toISOString(), range, index: { state: 'indexing', indexedAt: null, sourceChanged: source ? false : null } };
      return unavailable({ state: 'failed', indexedAt: null, sourceChanged: source ? true : null });
    }
    const message = this.failure === identity ? refreshFailure : !source ? sourceFailure : undefined;
    const index: UsageIndexState = {
      state: this.job ? 'refreshing' : message ? 'failed' : 'ready', indexedAt: metadata.indexedAt,
      sourceChanged: source ? metadata.changedDuringBuild || source.fingerprint !== metadata.fingerprint : null,
      ...(message ? { message } : {}),
    };
    const result = cached?.result;
    if (!result || result.status === 'unavailable') {
      this.failure = identity;
      return unavailable({ ...index, state: 'failed', message: initialFailure });
    }
    return { ...result, updatedAt: metadata.indexedAt, ...(message ? { status: 'partial' as const, warnings: [...result.warnings, message] } : {}), index };
  }
}
