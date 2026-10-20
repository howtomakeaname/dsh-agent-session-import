/**
 * ZCode provider (staging copy for the session-import plugin).
 *
 * ZCode CLI is an OpenCode-derived coding agent. It keeps every local
 * conversation in one SQLite database:
 *
 *   ~/.zcode/cli/db/db.sqlite
 *     session  - one row per conversation (title, cwd, timestamps, parent id)
 *     message  - one JSON blob per user/assistant message
 *     part     - one JSON blob per content part (text / reasoning / tool / ...)
 *
 * The alternatives on this machine are not conversation stores:
 *   - `~/.zcode/cli/rollout/model-io-*.jsonl` only contains raw model I/O for a
 *     handful of debug/subagent sessions (3 files here), not the full history;
 *   - `~/Library/Application Support/ZCode/session` is the Chromium/Electron
 *     profile (Cookies, Cache, IndexedDB, Local Storage) and has no transcripts.
 *
 * This module is intentionally dependency-free apart from `node:` builtins so
 * it can be dropped into `lib/host/providers/zcode.js` unchanged.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Stable provider id (lowercase, no colon). */
export const id = 'zcode';
/** Display label for the source picker. */
export const label = 'ZCode';
/** One-line description for the source picker. */
export const description = '字节 ZCode CLI 本地会话（~/.zcode/cli/db/db.sqlite）';

/** Maximum characters kept from one tool result. */
const TOOL_RESULT_MAX_CHARS = 20_000;
/** Maximum characters kept from one reasoning block. */
const REASONING_MAX_CHARS = 12_000;
/** Maximum characters kept in a conversation title. */
const TITLE_MAX_CHARS = 160;
/** Per-conversation read budget (the contract suggests 240s). */
const LOAD_BUDGET_MS = 240_000;
/** Marker used in truncated text (kept in sync with providers/shared.js). */
const TRUNCATION_LABEL = 'ZCode importer';

const HOME = os.homedir();
const ZCODE_HOME = (() => {
  const raw = process.env.ZCODE_HOME;
  if (typeof raw === 'string' && raw.trim() !== '' && path.isAbsolute(raw)) return raw;
  return path.join(HOME, '.zcode');
})();
const DB_PATH = path.join(ZCODE_HOME, 'cli', 'db', 'db.sqlite');

/* ------------------------------------------------------------------ */
/* Small helpers (mirrors lib/host/providers/shared.js, inlined so the */
/* module stays import-free apart from node: builtins).               */
/* ------------------------------------------------------------------ */

/**
 * Replace the home prefix with `~` for display.
 * @param value - absolute path.
 * @returns display path.
 */
function displayPath(value) {
  if (value === HOME) return '~';
  if (value.startsWith(`${HOME}${path.sep}`)) return `~${value.slice(HOME.length)}`;
  return value;
}

/** User-facing location shown in the UI. */
const LOCATION = displayPath(DB_PATH);

/**
 * Truncate a string with a visible marker.
 * @param text - source text.
 * @param max - maximum characters kept.
 * @param label - provider label used in the marker.
 * @returns the source text or its truncated form.
 */
function clamp(text, max, label = TRUNCATION_LABEL) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} characters by ${label}]`;
}

/**
 * Convert a timestamp (millisecond number or ISO string) to milliseconds.
 * @param value - source timestamp.
 * @param fallback - fallback milliseconds.
 * @returns non-negative integer milliseconds.
 */
function toMillis(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.trunc(value);
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.trunc(parsed);
  }
  if (typeof fallback === 'number' && Number.isFinite(fallback) && fallback >= 0) return Math.trunc(fallback);
  return 0;
}

/**
 * Build one display title: single line, bounded, with a fallback.
 * @param title - raw title.
 * @param fallback - text used when the raw title is blank.
 * @returns display title.
 */
function cleanTitle(title, fallback) {
  const text = typeof title === 'string' ? title.replaceAll(/\s+/g, ' ').trim() : '';
  if (text === '') return fallback;
  return text.length <= TITLE_MAX_CHARS ? text : `${text.slice(0, TITLE_MAX_CHARS)}…`;
}

/**
 * Basename of an absolute directory path, for the conversation list.
 * @param cwd - absolute path or null.
 * @returns display label ('' when unknown).
 */
function cwdLabel(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return '';
  const parts = cwd.split(/[\\/]/).filter((part) => part !== '');
  return parts.length === 0 ? '' : parts[parts.length - 1];
}

/**
 * Resolve a usable absolute cwd or null.
 * @param value - candidate path.
 * @returns absolute path or null.
 */
function absoluteOrNull(value) {
  return typeof value === 'string' && value.trim() !== '' && path.isAbsolute(value) ? value : null;
}

/**
 * Whether a value is a plain (non-array) object.
 * @param value - candidate.
 * @returns true for plain objects.
 */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Best-effort text conversion for tool output/error values.
 * @param value - string, object or primitive.
 * @returns display text.
 */
function textOf(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Serialize tool input into the JSON string the DSH writer expects.
 * @param value - decoded `state.input`.
 * @returns JSON string (never empty).
 */
function jsonArguments(value) {
  if (value === undefined) return '{}';
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === 'string' ? encoded : '{}';
  } catch {
    return '{}';
  }
}

/**
 * Parse one SQLite JSON blob, tolerating corruption.
 * @param text - JSON text.
 * @returns parsed value or null.
 */
function parseJson(text) {
  if (typeof text !== 'string' || text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Human-readable line for one attachment part. The neutral model only allows
 * text, so attachments are preserved as a bounded placeholder instead of being
 * dropped silently.
 * @param part - decoded `file` part.
 * @returns one text line.
 */
function attachmentLine(part) {
  const sourcePath = typeof part.source?.path === 'string' ? part.source.path : '';
  const filename =
    typeof part.filename === 'string' && part.filename !== ''
      ? part.filename
      : sourcePath !== ''
        ? path.basename(sourcePath)
        : '';
  const mime = typeof part.mime === 'string' ? part.mime : '';
  const details = [];
  if (mime !== '') details.push(mime);
  if (sourcePath !== '' && sourcePath !== filename) details.push(sourcePath);
  const suffix = details.length === 0 ? '' : `（${details.join('，')}）`;
  return `[附件] ${filename === '' ? '未命名' : filename}${suffix}`;
}

/* ------------------------------------------------------------------ */
/* Database access                                                     */
/* ------------------------------------------------------------------ */

/**
 * Open the read-only conversation database.
 * @returns an open DatabaseSync handle.
 */
function openDatabase() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
  } catch {
    // Older SQLite builds may not accept this pragma on a read-only handle.
  }
  return db;
}

/**
 * Display title for one session. Subagent transcripts are marked like the
 * Codex provider does, because 168 of the 188 sessions on this machine are
 * `subagent_child` rows.
 * @param rawTitle - `session.title`.
 * @param taskType - `session.task_type`.
 * @param fallback - fallback title.
 * @returns bounded display title.
 */
function sessionTitle(rawTitle, taskType, fallback) {
  const base = cleanTitle(rawTitle, fallback);
  return taskType === 'subagent_child' ? cleanTitle(`子代理 ${base}`, base) : base;
}

/** Count user/assistant messages that form the importable transcript. */
const COUNT_SQL = `
  select m.session_id,
         sum(case
               when json_extract(m.data, '$.semantics.kind') = 'user_prompt' then 1
               when json_extract(m.data, '$.role') = 'assistant'
                    and coalesce(json_extract(m.data, '$.semantics.kind'), 'assistant_response') = 'assistant_response'
                    and coalesce(json_extract(m.data, '$.finish'), '') not like '%discarded%'
                    and exists (
                      select 1 from part p
                       where p.message_id = m.id
                         and (
                           json_extract(p.data, '$.type') = 'tool'
                           or (
                             json_extract(p.data, '$.type') in ('text', 'reasoning')
                             and trim(coalesce(json_extract(p.data, '$.text'), '')) != ''
                           )
                         )
                    ) then 1
               else 0
             end) as visible
    from message m
   group by m.session_id
`;

/** One row per conversation, newest first. */
const SESSION_SQL = `
  select id, title, directory, time_created, time_updated, time_archived, task_type
    from session
   order by time_updated desc, id
`;

/**
 * Importable user/assistant messages, in transcript order. Hidden synthetic
 * user rows (todo reminders, system notifications, compaction summaries) and
 * discarded retry responses are excluded; `timeline_event` rows are UI
 * separators and are excluded too.
 */
const MESSAGE_SQL = `
  select id, data
    from message
   where session_id = ?
     and (
       json_extract(data, '$.semantics.kind') = 'user_prompt'
       or (
         json_extract(data, '$.role') = 'assistant'
         and coalesce(json_extract(data, '$.semantics.kind'), 'assistant_response') = 'assistant_response'
         and coalesce(json_extract(data, '$.finish'), '') not like '%discarded%'
       )
     )
   order by sequence, time_created, id
`;

/** Content parts worth importing, ordered inside their message. */
const PART_SQL = `
  select p.message_id, p.data
    from part p
    join message m on m.id = p.message_id
   where p.session_id = ?
     and json_extract(p.data, '$.type') in ('text', 'reasoning', 'tool', 'file')
   order by m.sequence, p.sequence, p.time_created, p.id
`;

/**
 * Read and decode all importable content parts of one conversation.
 * @param db - open database handle.
 * @param conversationId - session id.
 * @returns map of message id -> decoded parts.
 */
function loadParts(db, conversationId) {
  const byMessage = new Map();
  const statement = db.prepare(PART_SQL);
  for (const row of statement.iterate(conversationId)) {
    const data = parseJson(row.data);
    if (!isObject(data)) continue;
    const messageId = String(row.message_id);
    const bucket = byMessage.get(messageId);
    if (bucket === undefined) byMessage.set(messageId, [data]);
    else bucket.push(data);
  }
  return byMessage;
}

/**
 * Build the neutral `user` payload for one prompt message.
 * @param parts - decoded parts in order.
 * @returns content block list (empty when the prompt has no text/attachments).
 */
function userContent(parts) {
  const content = [];
  for (const part of parts) {
    if (part.type === 'text') {
      const text = typeof part.text === 'string' ? part.text : '';
      if (text.trim() !== '') content.push({ type: 'text', text });
    } else if (part.type === 'file') {
      content.push({ type: 'text', text: attachmentLine(part) });
    }
  }
  return content;
}

/**
 * Convert one assistant message plus its parts into one neutral run.
 * @param message - decoded message row.
 * @param parts - decoded parts in order.
 * @param runAt - fallback timestamp.
 * @param seenCallIds - session-wide tool-call id set (mutated).
 * @param nextSyntheticId - factory for missing call ids.
 * @returns run, or null when the message has no visible content.
 */
function buildRun(message, parts, runAt, seenCallIds, nextSyntheticId) {
  const at = toMillis(message.time?.created, toMillis(message.time?.completed, runAt));
  const run = { at, blocks: [], toolResults: [] };
  for (const part of parts) {
    if (part.type === 'text') {
      const text = typeof part.text === 'string' ? part.text : '';
      if (text.trim() !== '') run.blocks.push({ type: 'text', text });
      continue;
    }
    if (part.type === 'reasoning') {
      const text = typeof part.text === 'string' ? part.text : '';
      if (text.trim() !== '') run.blocks.push({ type: 'reasoning', text });
      continue;
    }
    if (part.type !== 'tool') continue;

    const state = isObject(part.state) ? part.state : {};
    const status = typeof state.status === 'string' ? state.status : '';
    const name = typeof part.tool === 'string' && part.tool !== '' ? part.tool : 'unknown';
    const sourceId = typeof part.callID === 'string' ? part.callID.trim() : '';
    const baseId = sourceId === '' ? nextSyntheticId() : sourceId;
    let callId = baseId;
    let suffix = 1;
    while (seenCallIds.has(callId)) {
      suffix += 1;
      callId = `${baseId}_${suffix}`;
    }
    seenCallIds.add(callId);

    const args = jsonArguments(state.input);
    const callAt = toMillis(state.time?.start, at);
    const resultAt = Math.max(callAt, toMillis(state.time?.end, callAt));

    let output = '';
    let isError = false;
    if (status === 'completed') {
      output = textOf(state.output);
    } else if (status === 'error') {
      output = textOf(state.error);
      isError = true;
      if (output === '') output = '[结果未记录]';
    } else {
      // `running` (interrupted while the DB was read) has no recorded output.
      output = '[结果未记录]';
      isError = true;
    }

    run.blocks.push({ type: 'tool-call', id: callId, name, arguments: args });
    run.toolResults.push({
      callId,
      name,
      arguments: args,
      output,
      isError,
      at: resultAt,
    });
  }
  return run.blocks.length === 0 ? null : run;
}

/**
 * Enforce the writer invariants on already-built turns: exactly one result per
 * tool-call block (same id/name/arguments), a synthetic call for orphan
 * results, and the documented clamps.
 * @param turns - mutable turn list.
 * @param seenCallIds - session-wide tool-call id set (mutated for orphans).
 */
function finalizeTurns(turns, seenCallIds) {
  for (const turn of turns) {
    for (const run of turn.runs) {
      const byId = new Map();
      for (const result of run.toolResults) {
        if (!byId.has(result.callId)) byId.set(result.callId, result);
      }
      const blocks = [];
      const results = [];
      for (const block of run.blocks) {
        if (block.type !== 'tool-call') {
          if (block.type === 'reasoning') block.text = clamp(block.text, REASONING_MAX_CHARS);
          blocks.push(block);
          continue;
        }
        let result = byId.get(block.id);
        if (result === undefined) {
          result = {
            callId: block.id,
            name: block.name,
            arguments: block.arguments,
            output: '[结果未记录]',
            isError: true,
            at: run.at,
          };
        } else {
          byId.delete(block.id);
        }
        result.callId = block.id;
        result.name = block.name;
        result.arguments = block.arguments;
        result.output = clamp(typeof result.output === 'string' ? result.output : textOf(result.output), TOOL_RESULT_MAX_CHARS);
        result.isError = result.isError === true;
        result.at = toMillis(result.at, run.at);
        blocks.push(block);
        results.push(result);
      }
      for (const orphan of byId.values()) {
        let callId = typeof orphan.callId === 'string' && orphan.callId !== '' ? orphan.callId : `call_orphan_${results.length + 1}`;
        let suffix = 1;
        while (seenCallIds.has(callId)) {
          suffix += 1;
          callId = `${orphan.callId}_${suffix}`;
        }
        seenCallIds.add(callId);
        orphan.callId = callId;
        orphan.output = clamp(typeof orphan.output === 'string' ? orphan.output : textOf(orphan.output), TOOL_RESULT_MAX_CHARS);
        orphan.isError = orphan.isError === true;
        orphan.at = toMillis(orphan.at, run.at);
        blocks.push({ type: 'tool-call', id: callId, name: orphan.name, arguments: orphan.arguments });
        results.push(orphan);
      }
      run.blocks = blocks;
      run.toolResults = results;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Report whether the local ZCode conversation database is readable.
 * @returns availability facts.
 */
export async function status() {
  try {
    const stat = fs.statSync(DB_PATH);
    if (!stat.isFile()) return { available: false, location: LOCATION, error: `${LOCATION} 不是文件` };
    fs.accessSync(DB_PATH, fs.constants.R_OK);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { available: false, location: LOCATION, error: `找不到可读的 ZCode 会话数据库 ${LOCATION}（${reason}）` };
  }

  let db;
  try {
    db = openDatabase();
    const row = db.prepare('select count(*) as sessions from session').get();
    const sessions = Number(row?.sessions ?? 0);
    if (sessions === 0) {
      return { available: false, location: LOCATION, error: `${LOCATION} 中没有会话` };
    }
    return { available: true, location: LOCATION, error: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { available: false, location: LOCATION, error: `无法读取 ${LOCATION}：${reason}` };
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

/**
 * List importable ZCode conversations, newest first.
 *
 * All rows in `session` are returned: 20 top-level (`interactive`) sessions and
 * 168 `subagent_child` sessions on this machine. Subagent transcripts are kept
 * as their own conversations, mirroring the Claude Code provider.
 * @returns conversation summaries.
 */
export async function list() {
  if (!fs.existsSync(DB_PATH)) return [];

  let db;
  try {
    db = openDatabase();
  } catch {
    return [];
  }

  try {
    const counts = new Map();
    for (const row of db.prepare(COUNT_SQL).iterate()) {
      counts.set(String(row.session_id), Number(row.visible) || 0);
    }

    const summaries = [];
    for (const row of db.prepare(SESSION_SQL).iterate()) {
      const conversationId = String(row.id);
      const cwd = absoluteOrNull(row.directory);
      const createdAt = toMillis(row.time_created);
      const updatedAt = toMillis(row.time_updated, createdAt);
      summaries.push({
        id: conversationId,
        title: sessionTitle(row.title, row.task_type, `ZCode 会话 ${conversationId.slice(0, 13)}`),
        cwd,
        cwdLabel: cwdLabel(cwd),
        createdAt,
        updatedAt: Math.max(createdAt, updatedAt),
        messageCount: counts.get(conversationId) ?? 0,
        isArchived: row.time_archived !== null && row.time_archived !== undefined,
      });
    }
    return summaries;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`读取 ZCode 会话列表失败（${LOCATION}）：${reason}`);
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Load and normalize one ZCode conversation.
 * @param conversationId - id returned by `list()`.
 * @returns normalized conversation.
 */
export async function load(conversationId) {
  const key = typeof conversationId === 'string' ? conversationId.trim() : '';
  if (key === '') throw new Error('ZCode 会话 id 不能为空');

  let db;
  try {
    db = openDatabase();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`无法打开 ZCode 数据库 ${LOCATION}：${reason}`);
  }

  try {
    const session = db
      .prepare('select id, title, directory, time_created, time_updated, task_type from session where id = ?')
      .get(key);
    if (session === undefined) throw new Error(`未找到 ZCode 会话：${key}`);

    const partsByMessage = loadParts(db, key);
    const turns = [];
    let currentTurn = null;
    let syntheticSeq = 0;
    let seenMessages = 0;
    const seenCallIds = new Set();
    const nextSyntheticId = () => {
      syntheticSeq += 1;
      return `call_missing_${syntheticSeq}`;
    };
    const startedAt = Date.now();

    for (const row of db.prepare(MESSAGE_SQL).iterate(key)) {
      seenMessages += 1;
      if ((seenMessages & 255) === 0 && Date.now() - startedAt > LOAD_BUDGET_MS) break;
      const message = parseJson(row.data);
      if (!isObject(message)) continue;
      const parts = partsByMessage.get(String(row.id)) ?? [];
      const fallbackAt = currentTurn === null ? 0 : currentTurn.at;

      if (message.semantics?.kind === 'user_prompt') {
        if (currentTurn !== null) turns.push(currentTurn);
        const content = userContent(parts);
        currentTurn = {
          at: toMillis(message.time?.created, fallbackAt),
          user: content.length === 0 ? null : { content },
          runs: [],
        };
        continue;
      }

      const run = buildRun(message, parts, fallbackAt, seenCallIds, nextSyntheticId);
      if (run === null) continue;
      if (currentTurn === null) {
        currentTurn = { at: run.at, user: null, runs: [] };
      }
      currentTurn.runs.push(run);
    }
    if (currentTurn !== null) turns.push(currentTurn);

    finalizeTurns(turns, seenCallIds);
    const cleanedTurns = turns.filter((turn) => turn.user !== null || turn.runs.length > 0);

    const firstUserText = (() => {
      for (const turn of cleanedTurns) {
        const text = turn.user?.content?.find((block) => block.type === 'text' && block.text.trim() !== '')?.text;
        if (typeof text === 'string' && text.trim() !== '') return text;
      }
      return '';
    })();
    const fallbackTitle = cleanTitle(firstUserText, `ZCode 会话 ${key.slice(0, 13)}`);
    const title = sessionTitle(session.title, session.task_type, fallbackTitle);

    const createdAt = toMillis(session.time_created);
    const lastAt = cleanedTurns.length === 0 ? createdAt : cleanedTurns[cleanedTurns.length - 1].at;
    const updatedAt = Math.max(createdAt, toMillis(session.time_updated, createdAt), lastAt);
    const messageCount = cleanedTurns.reduce(
      (count, turn) => count + (turn.user === null ? 0 : 1) + turn.runs.length,
      0,
    );
    const cwd = absoluteOrNull(session.directory);

    return {
      source: id,
      id: key,
      title,
      createdAt,
      updatedAt,
      cwd,
      messageCount,
      turns: cleanedTurns,
    };
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}
