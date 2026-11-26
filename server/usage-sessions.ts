import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { redactText } from './redact.js';

export const usageKey = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const unattributed = { id: 'unattributed', name: 'Unattributed' } as const;
const controls = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const pathLike = /[/\\]|%2f|%5c|(?:^|\s)[a-z]:/i;
export const validSessionKey = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value);

/** Titles and names are the only approved free text. Reject path-like values
 * outright, even after redaction; never use a session directory as evidence. */
function label(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 256 || controls.test(value) || pathLike.test(value)) return null;
  const text = redactText(value.trim());
  return text && text.length <= 256 && !controls.test(text) && !pathLike.test(text) ? text : null;
}

type Candidate<T> = { value: T; updated: number };
type ProjectLabel = { id: string; name: string };
type SessionLabels = { project?: Candidate<ProjectLabel | null>; title?: Candidate<string | null> };
type Row = Record<string, any>;

export function projectSessionMetadata(
  source: DatabaseSync, target: DatabaseSync, schema: Map<string, Set<string>>, tables: string[], warn: (text: string, owner?: string) => void,
) {
  const field = (table: string, column: string) => schema.get(table)?.has(column) ? column : `NULL AS ${column}`;
  const projects = new Map<string, { id: string; name: string }>();
  if (schema.get('project')?.has('id')) {
    for (const row of source.prepare(`SELECT id,${field('project', 'name')},${field('project', 'worktree')} FROM project`).iterate() as Iterable<Row>) {
      if (!validSessionKey(row.id) || row.id === 'global') continue;
      const basename = typeof row.worktree === 'string' && /^(?:[/\\]|[a-z]:[/\\])/i.test(row.worktree)
        ? row.worktree.replace(/[/\\]+$/, '').split(/[/\\]/).at(-1) : null;
      projects.set(row.id, { id: usageKey(row.id), name: label(row.name) ?? label(basename) ?? 'Unnamed project' });
    }
  }
  target.exec(`CREATE TABLE inspector_delegation_session(key TEXT PRIMARY KEY, parent TEXT, known INTEGER NOT NULL);
    CREATE TABLE inspector_usage_session_label(key TEXT PRIMARY KEY, project TEXT, name TEXT, title TEXT);`);
  const insertSession = target.prepare(`INSERT INTO inspector_delegation_session VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET known=CASE WHEN parent IS excluded.parent AND known=1 AND excluded.known=1 THEN 1 ELSE 0 END`);
  const labels = new Map<string, SessionLabels>();
  for (const table of tables) {
    const hasProject = schema.get(table)?.has('project_id'), hasTitle = schema.get(table)?.has('title');
    for (const row of source.prepare(`SELECT id,parent_id,${field(table, 'project_id')},${field(table, 'title')},${field(table, 'time_updated')} FROM ${table}`).iterate() as Iterable<Row>) {
      const id = usageKey(row.id), parent = validSessionKey(row.parent_id) ? usageKey(row.parent_id) : null;
      if (!validSessionKey(row.id)) { warn('Some delegation sessions have invalid identities; ancestry is incomplete.', id); continue; }
      // A disagreement in retained ancestry is not resolved by guessing which
      // edge is newer. It must not link an unresolved child to a root.
      insertSession.run(id, parent, row.parent_id === null || parent !== null ? 1 : 0);
      const prior = labels.get(id) ?? {}, updated = Number.isSafeInteger(row.time_updated) ? row.time_updated as number : -Infinity;
      // Worktree.Event.Resolved can change V2 project ownership without touching
      // time_updated. Prefer its supported field on ties, independent of titles.
      if (hasProject && (!prior.project || updated > prior.project.updated || (updated === prior.project.updated && table === 'session_v2'))) {
        prior.project = { value: projects.get(row.project_id) ?? null, updated };
      }
      // Titles retain the original legacy value on migrated ties. Sanitized
      // exports can embed the raw session ID in a title placeholder.
      if (hasTitle && (!prior.title || updated > prior.title.updated)) {
        const title = typeof row.title === 'string' && /\[redacted:session-title:/i.test(row.title) ? null : label(row.title);
        prior.title = { value: title, updated };
      }
      labels.set(id, prior);
    }
  }
  const insertLabel = target.prepare('INSERT INTO inspector_usage_session_label VALUES(?,?,?,?)');
  for (const [id, data] of labels) {
    const project = data.project?.value, title = data.title?.value ?? null;
    if (project || title) insertLabel.run(id, project?.id ?? null, project?.name ?? null, title);
  }
}

type Session = { key: string; parent: string | null; known: number; project: string | null; name: string | null; title: string | null };

export function readSessionMetadata(db: DatabaseSync) {
  const lookup = db.prepare(`SELECT s.key, s.parent, s.known, l.project, l.name, l.title
    FROM inspector_delegation_session s LEFT JOIN inspector_usage_session_label l ON s.key=l.key WHERE s.key=?`);
  const sessions = new Map<string, Session | null>();
  function session(key: string) {
    if (!sessions.has(key)) sessions.set(key, (lookup.get(key) as Session | undefined) ?? null);
    return sessions.get(key);
  }
  const roots = new Map<string, Session | null>();
  function root(key: string): Session | null {
    const visited = new Set<string>();
    let result: Session | null = null;
    while (!visited.has(key)) {
      if (roots.has(key)) { result = roots.get(key) ?? null; break; }
      const row = session(key);
      visited.add(key);
      if (!row?.known) break;
      if (row.parent === null) { result = row; break; }
      key = row.parent;
    }
    for (const id of visited) roots.set(id, result);
    return result;
  }
  const ownership = new Map<string, { id: string; name: string }>();
  function project(key: string) {
    const cached = ownership.get(key);
    if (cached) return cached;
    // A reliably owned child follows its root; unresolved sessions retain any
    // verified assignment of their own but cannot contribute to a root's rank.
    const owner = root(key) ?? session(key);
    const result = owner?.project && owner.name ? { id: owner.project, name: owner.name } : unattributed;
    ownership.set(key, result);
    return result;
  }
  return { root, project };
}
