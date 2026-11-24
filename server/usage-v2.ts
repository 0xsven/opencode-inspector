import type { DatabaseSync } from 'node:sqlite';

type Row = Record<string, any>;
const safe = (column: string) => `CASE WHEN json_valid(${column}) THEN ${column} ELSE '{}' END`;
export const splitPartColumns = ['message_id', 'session_id', 'ordinal', 'type', 'data'];
const overlap = (legacy: boolean) => legacy ? 'LEFT JOIN message o ON o.id=m.id AND o.session_id=m.session_id' : '';
const selected = (legacy: boolean) => `m.time_created>=s.time_created ${legacy ? 'AND (o.id IS NULL OR m.time_updated>o.time_updated)' : ''}`;

/** InboxDelivered retains prepared skills on the user message. Never select the
 * attachment's prepared text, mention offsets, prompt or pending inbox payload.
 */
export function attachmentMetadata(data: string, type: string) {
  const label = (key: 'id' | 'name') => `CASE WHEN a.type='object' THEN
    CASE WHEN json_type(a.value, '$.${key}')='text' THEN json_extract(a.value, '$.${key}') END END`;
  return `CASE WHEN ${type}='user' AND json_type(${data}, '$.skills')='array' THEN
    (SELECT json_group_array(json_object('id', ${label('id')}, 'name', ${label('name')}))
     FROM json_each(${data}, '$.skills') a) END`;
}

export function* distinctAttachments(metadata: string): Generator<{ id: string | null; name: unknown }> {
  const seen = new Set<string | null>();
  for (const attachment of JSON.parse(metadata)) {
    const id = attachment.id || null;
    if (seen.has(id)) continue;
    seen.add(id);
    // Retain a single missing-ID marker for the coverage warning, never its label.
    yield { id, name: id ? attachment.name : null };
  }
}

export function winningAttachmentOwners(db: DatabaseSync, legacy: boolean) {
  const m = safe('m.data');
  return db.prepare(`SELECT m.id,${attachmentMetadata(m, 'm.type')} attachments
    FROM session_v2 s CROSS JOIN session_message m ON s.id=m.session_id ${overlap(legacy)}
    WHERE m.type='user' AND ${selected(legacy)} AND json_array_length(${m}, '$.skills')>0`).iterate();
}

/** The private index has already resolved all competitors. Never scan older
 * messages or skill rows just to find completions in a requested period. */
export const v2SkillRangeSQL = `SELECT session_id,name,status,completed FROM inspector_v2_skill
  WHERE completed>=?1 AND completed<?2 AND owner_created<?2`;

/** History.withParts orders an assistant's split rows by ordinal, followed by
 * inline content in array order. Keep that first-wins order even for old builds
 * that appended inline content to a split owner. Only tool accounting fields
 * leave SQLite; neither physical location needs full part hydration.
 */
export function* v2ToolMetadata(db: DatabaseSync, legacy: boolean, split: boolean): Generator<Row> {
  const owner = `m.type='assistant' AND ${selected(legacy)}`;
  const m = safe('m.data');
  // Other tools reserve their valid call ID but expose no tool name, arguments
  // or result. Project only the labels/times belonging to a known tool family.
  const fields = (c: string) => `m.id message_id,m.session_id,m.time_created owner_created,
    CASE WHEN json_type(${c}, '$.id')='text' THEN json_extract(${c}, '$.id') END call,
    CASE json_extract(${c}, '$.name') WHEN 'skill' THEN 'skill' WHEN 'subagent' THEN 'subagent' WHEN 'task' THEN 'task' END tool,
    CASE json_extract(${c}, '$.name')
      WHEN 'skill' THEN json_extract(${c}, '$.state.status', '$.state.input.name', '$.state.input.id', '$.state.metadata.name', '$.time.completed')
      WHEN 'subagent' THEN json_extract(${c}, '$.state.status', '$.state.input.agent', '$.state.metadata.sessionID', '$.state.input.sessionID', '$.time.created')
      WHEN 'task' THEN json_extract(${c}, '$.state.status', '$.state.input.subagent_type', '$.state.metadata.sessionId', '$.state.input.task_id', '$.time.created')
    END metadata,
    CASE WHEN json_extract(${c}, '$.name') IN ('subagent','task') THEN json_quote(json_extract(${m}, '$.agent')) END caller`;
  const part = safe('p.data');
  const parts = split ? `SELECT ${fields(part)},0 storage,p.ordinal record
      FROM session_part p CROSS JOIN session_message m ON m.id=p.message_id AND m.session_id=p.session_id
      CROSS JOIN session_v2 s ON s.id=m.session_id ${overlap(legacy)}
      WHERE p.type='tool' AND CASE WHEN ${owner} THEN json_extract(${part}, '$.type')='tool' ELSE 0 END
      UNION ALL` : '';
  const rows = db.prepare(`WITH owners AS MATERIALIZED (
    SELECT m.id FROM session_v2 s CROSS JOIN session_message m ON s.id=m.session_id ${overlap(legacy)}
    WHERE ${owner}
  ) ${parts} SELECT ${fields('c.value')},1 storage,c.key record
    FROM owners o CROSS JOIN session_message m ON m.id=o.id CROSS JOIN json_each(${m}, '$.content') c
    WHERE json_type(${m}, '$.content')='array'
    AND CASE WHEN c.type='object' THEN json_extract(c.value, '$.type')='tool' ELSE 0 END
    ORDER BY message_id,session_id,storage,record`).iterate() as Iterable<Row>;
  // The SQL merges the two ordered sources by owner. Retain identities for
  // just the current message, including unrelated and nonterminal winners.
  let message: unknown, session: unknown;
  const seen = new Set<string>();
  for (const row of rows) {
    if (message !== row.message_id || session !== row.session_id) {
      seen.clear(); message = row.message_id; session = row.session_id;
    }
    // IDs are opaque equality keys, not display names. JSON objects or absent
    // IDs do not establish that two records represent the same call.
    row.duplicate = !!row.call && seen.has(row.call);
    if (row.call) seen.add(row.call);
    if (row.tool) yield row;
  }
}
