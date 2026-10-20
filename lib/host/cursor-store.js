/**
 * Read-only access to a local Cursor IDE installation.
 *
 * Two SQLite databases under `~/Library/Application Support/Cursor/User`:
 *  - globalStorage/state.vscdb        huge KV store: composerHeaders + cursorDiskKV
 *  - globalStorage/conversation-search.db  small index of conversation titles
 *
 * The state database can be many gigabytes, so every query here is either a
 * table scan over the tiny `composerHeaders` table or an exact/range key lookup
 * on `cursorDiskKV`. Nothing is copied and nothing is written.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** SQLITE3 binary used for read-only queries (present on every macOS install). */
const SQLITE3 = '/usr/bin/sqlite3';

/** Upper bound for one sqlite3 invocation (milliseconds). */
const QUERY_TIMEOUT_MS = 120_000;

/** Upper bound for one sqlite3 stdout of one invocation (bytes). */
const QUERY_MAX_BUFFER = 512 * 1024 * 1024;

/** Bubbles fetched per paged query; keeps one huge conversation from reading the whole range at once. */
const BUBBLE_PAGE_SIZE = 4000;

/** Refuse composerData documents larger than this before extracting their header list. */
const MAX_COMPOSER_BYTES = 96 * 1024 * 1024;

/** Overall budget for loading one conversation from Cursor (milliseconds). */
const LOAD_BUDGET_MS = 240_000;

/** Cursor's Electron user-data directory. */
function cursorUserDir() {
  return join(homedir(), 'Library', 'Application Support', 'Cursor', 'User');
}

/** Absolute path of the global state database. */
export function stateDbPath() {
  return join(cursorUserDir(), 'globalStorage', 'state.vscdb');
}

/** Absolute path of the conversation search index. */
export function searchDbPath() {
  return join(cursorUserDir(), 'globalStorage', 'conversation-search.db');
}

/** Absolute path of the per-workspace storage directory. */
export function workspaceStoragePath() {
  return join(cursorUserDir(), 'workspaceStorage');
}

/**
 * Whether a local Cursor installation with chat data is visible.
 * @returns true when the global state database exists.
 */
export function cursorDataAvailable() {
  return existsSync(stateDbPath());
}

/**
 * Run one read-only SQLite statement and return its JSON rows.
 * @param dbPath - database file.
 * @param sql - SQL text; `PRAGMA temp_store=memory` is prepended.
 * @returns parsed JSON rows.
 */
function queryJson(dbPath, sql, options = {}) {
  // A file: URI with mode=ro keeps SQLite from touching the WAL or creating
  // journals; this matters because Cursor may be running right now.
  const uri = `file:${dbPath}?mode=ro`;
  const timeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : QUERY_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    execFile(
      SQLITE3,
      ['-json', uri, `PRAGMA temp_store=memory;\n${sql}`],
      { encoding: 'utf8', timeout, maxBuffer: QUERY_MAX_BUFFER },
      (error, stdout, stderr) => {
        if (error !== null) {
          // Never echo stdout: on a timeout it holds a truncated JSON slice of
          // the very values being read, which is useless as an error message.
          const killed = error.killed === true || error.signal !== undefined && error.signal !== null;
          const details = String(stderr ?? '').trim();
          const reason = killed ? `sqlite3 timed out after ${timeout}ms` : `sqlite3 failed: ${error.message}`;
          reject(new Error(details === '' ? reason : `${reason}: ${details.slice(0, 500)}`));
          return;
        }
        const text = stdout.trim();
        if (text === '') {
          resolve([]);
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (parseError) {
          reject(new Error(`sqlite3 returned non-JSON output: ${String(parseError)}`));
        }
      },
    );
  });
}

/** Parse one JSON text, returning undefined instead of throwing. */
function parseJson(text) {
  if (typeof text !== 'string' || text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Quote one SQL string literal. */
function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * Conversation metadata row: composerHeaders.value plus the search index title.
 * @typedef {object} ComposerSummary
 * @property {string} id - Cursor composer id.
 * @property {string} title - display title.
 * @property {string|null} cwd - original project directory, when resolvable.
 * @property {string} cwdLabel - basename of the project directory.
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {boolean} isArchived
 * @property {number|null} messageCount
 * @property {string|null} workspaceUri - raw workspace URI scheme, for diagnostics.
 */

/**
 * Resolve an absolute local project directory from a Cursor workspace header.
 * @param value - composerHeaders.value parsed JSON.
 * @returns absolute path, or null for remote/dev-container/empty windows.
 */
function resolveCwd(value) {
  const uri = value?.workspaceIdentifier?.uri ?? value?.agentLocation?.environment?.uri ?? null;
  const fsPath = typeof uri?.fsPath === 'string' ? uri.fsPath : undefined;
  const external = typeof uri?.external === 'string' ? uri.external : undefined;
  const scheme = typeof uri?.scheme === 'string' ? uri.scheme : undefined;
  if (scheme !== undefined && scheme !== 'file') return null;
  if (typeof fsPath === 'string' && fsPath.startsWith('/')) return fsPath;
  if (typeof external === 'string' && external.startsWith('file://')) {
    try {
      return decodeURIComponent(external.slice('file://'.length));
    } catch {
      return null;
    }
  }
  const tracked = value?.trackedGitRepos?.[0]?.repoPath;
  if (typeof tracked === 'string' && tracked.startsWith('/')) return tracked;
  return null;
}

/**
 * Turn one raw `composerHeaders` row into a summary.
 * @param row - SQLite row with composerId/workspaceId/createdAt/lastUpdatedAt/isArchived/value.
 * @param searchTitles - composer id → title from the search index.
 * @returns summary.
 */
function summaryFromRow(row, searchTitles) {
  const headerValue = parseJson(row.value) ?? {};
  const id = row.composerId;
  const cwd = resolveCwd(headerValue);
  const searchTitle = searchTitles.get(id);
  const rawTitle = [headerValue.name, searchTitle].find((text) => typeof text === 'string' && text.trim() !== '');
  const title = rawTitle !== undefined ? rawTitle.trim() : `Cursor 对话 ${id.slice(0, 8)}`;
  const createdAt = Number.isFinite(headerValue.createdAt) ? headerValue.createdAt : Number(row.createdAt) || 0;
  const updatedAt = Number.isFinite(headerValue.lastUpdatedAt) ? headerValue.lastUpdatedAt : Number(row.lastUpdatedAt) || createdAt;
  return {
    id,
    title,
    cwd,
    cwdLabel: cwd === null ? '' : (cwd.split('/').filter((part) => part !== '').pop() ?? ''),
    createdAt,
    updatedAt,
    isArchived: Number(row.isArchived) === 1,
    messageCount: null,
    workspaceUri: headerValue.workspaceIdentifier?.uri?.scheme ?? headerValue.agentLocation?.environment?.uri?.scheme ?? null,
  };
}

/**
 * Fetch composer titles from the small conversation-search database.
 * @returns composer id → title.
 */
async function loadSearchTitles() {
  const titles = new Map();
  if (!existsSync(searchDbPath())) return titles;
  try {
    const rows = await queryJson(searchDbPath(), "select id, title from conversations where source = 'local'");
    for (const row of rows) {
      if (typeof row.id === 'string' && typeof row.title === 'string' && row.title.trim() !== '') titles.set(row.id, row.title);
    }
  } catch {
    // The search index is optional: titles fall back to composerHeaders.name.
  }
  return titles;
}

/**
 * Fill `messageCount` on summaries from each conversation's compact header list.
 *
 * The count is computed inside SQLite so the (sometimes multi-megabyte)
 * composerData values never cross into Node. JSON functions are guarded by a
 * size gate because a few legacy conversations embed whole conversation maps;
 * those simply keep `null` and import reports the real count instead.
 * @param summaries - summaries to enrich in place.
 * @param budgetMs - wall-clock budget; remaining counts stay `null`.
 */
async function fillMessageCounts(summaries, budgetMs = 8000) {
  if (summaries.length === 0) return;
  const deadline = Date.now() + budgetMs;
  const ids = summaries.map((summary) => summary.id);
  for (let offset = 0; offset < ids.length; offset += 40) {
    if (Date.now() > deadline) return;
    const chunk = ids.slice(offset, offset + 40);
    const keys = chunk.map((id) => quote(`composerData:${id}`)).join(',');
    let rows;
    try {
      rows = await queryJson(
        stateDbPath(),
        `select key, case when length(value) <= 2000000 and json_valid(value) then json_array_length(value, '$.fullConversationHeadersOnly') else null end as n from cursorDiskKV where key in (${keys})`,
      );
    } catch {
      continue;
    }
    const counts = new Map();
    for (const row of rows) {
      const id = String(row.key).slice('composerData:'.length);
      if (typeof row.n === 'number') counts.set(id, row.n);
    }
    for (const summary of summaries) {
      if (counts.has(summary.id)) summary.messageCount = counts.get(summary.id);
    }
  }
}

/**
 * List Cursor conversations, newest first.
 * @param options - `withMessageCounts` fetches per-conversation bubble counts.
 * @returns conversation summaries (non-subagent).
 */
export async function listComposerSummaries(options = {}) {
  if (!cursorDataAvailable()) throw new Error('Cursor state.vscdb not found');
  const [rows, searchTitles] = await Promise.all([
    queryJson(
      stateDbPath(),
      'select composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, value from composerHeaders where isSubagent = 0 order by recency desc',
    ),
    loadSearchTitles(),
  ]);
  const summaries = [];
  for (const row of rows) {
    if (Number(row.isSubagent) === 1) continue;
    summaries.push(summaryFromRow(row, searchTitles));
  }
  if (options.withMessageCounts !== false) await fillMessageCounts(summaries);
  return summaries;
}

/**
 * Read `fullConversationHeadersOnly` out of a composerData JSON value by byte
 * offset, without asking SQLite's JSON functions to re-serialize the array.
 * @param composerId - Cursor composer id.
 * @param pos - 1-based `instr()` position of the `"fullConversationHeadersOnly"` key, or 0.
 * @returns parsed header entries (empty when the key/array is absent).
 */
async function readHeaderList(composerId, pos) {
  if (!Number.isFinite(pos) || pos <= 0) return [];
  const key = quote(`composerData:${composerId}`);
  // Step over the JSON key and the colon to the opening bracket.
  let cursor = pos + '"fullConversationHeadersOnly"'.length;
  let scanned = '';
  let guard = 0;
  while (guard < 8) {
    guard += 1;
    const chunkRows = await queryJson(
      stateDbPath(),
      `select substr(value, ${cursor}, 8388608) as chunk from cursorDiskKV where key = ${key}`,
      { timeoutMs: 60_000 },
    );
    if (chunkRows.length === 0 || typeof chunkRows[0].chunk !== 'string' || chunkRows[0].chunk === '') return [];
    scanned += chunkRows[0].chunk;
    const start = scanned.indexOf('[');
    if (start < 0) return [];
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < scanned.length; index++) {
      const ch = scanned[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '[') depth += 1;
      else if (ch === ']') {
        depth -= 1;
        if (depth === 0) {
          const parsed = parseJson(scanned.slice(start, index + 1));
          return Array.isArray(parsed) ? parsed : [];
        }
      }
    }
    // Incomplete array: continue after the bytes already scanned.
    cursor += scanned.length;
  }
  return [];
}

/**
 * Load one conversation's ordered bubbles.
 * @param composerId - Cursor composer id.
 * @returns `{ header, data, bubbles }` where bubbles are `{ bubbleId, value }` in key order.
 */
export async function loadComposer(composerId) {
  if (typeof composerId !== 'string' || composerId === '') throw new Error('composerId must be a non-empty string');
  if (!/^[A-Za-z0-9._-]+$/.test(composerId)) throw new Error('composerId contains unsupported characters');
  const startedAt = Date.now();
  const assertBudget = () => {
    if (Date.now() - startedAt > LOAD_BUDGET_MS) throw new Error(`导入超时：读取该 Cursor 对话超过 ${Math.round(LOAD_BUDGET_MS / 1000)} 秒，已放弃（对话可能过大）`);
  };

  // Read the compact header list and the document size instead of the whole
  // composerData value: on legacy conversations that value can embed the whole
  // conversation map and reach hundreds of megabytes.
  // Bubble records alone are enough to rebuild the transcript: each carries its
  // own type/timestamps and (for assistant bubbles) capability/tool data. Avoid
  // reading the composerData document at all — on a conversation with thousands
  // of header entries SQLite's JSON functions spend minutes re-serializing it,
  // while the paginated bubble reads below stay in the tens of milliseconds.
  const data = { fullConversationHeadersOnly: [] };

  const headerRows = await queryJson(
    stateDbPath(),
    `select composerId, isArchived, createdAt, value from composerHeaders where composerId = ${quote(composerId)}`,
  );
  const header = headerRows.length === 0 ? {} : (parseJson(headerRows[0].value) ?? {});
  if (headerRows.length > 0 && (typeof header.createdAt !== 'number' || !Number.isFinite(header.createdAt))) {
    header.createdAt = Number(headerRows[0].createdAt) || 0;
  }
  if (headerRows.length === 0) header.createdAt = 0;
  header.isArchived = headerRows.length === 0 ? false : Number(headerRows[0].isArchived) === 1;

  // Page through the bubble range by primary key. A single unpaged query on a
  // legacy conversation was measured at >120 s; 400-row keyset pages keep each
  // sqlite3 invocation bounded and observable.
  const prefix = `bubbleId:${composerId}:`;
  const upper = `bubbleId:${composerId};`;
  const bubbles = [];
  let lastKey = null;
  let totalBytes = 0;
  for (;;) {
    assertBudget();
    const where = lastKey === null
      ? `key >= ${quote(prefix)} and key < ${quote(upper)}`
      : `key > ${quote(lastKey)} and key < ${quote(upper)}`;
    const bubbleRows = await queryJson(
      stateDbPath(),
      `select key, value from cursorDiskKV where ${where} order by key limit ${BUBBLE_PAGE_SIZE}`,
      { timeoutMs: 120_000 },
    );
    if (bubbleRows.length === 0) break;
    for (const row of bubbleRows) {
      const key = String(row.key);
      lastKey = key;
      const rawValue = typeof row.value === 'string' ? row.value : '';
      totalBytes += rawValue.length;
      const bubbleId = key.slice(prefix.length);
      const value = parseJson(rawValue);
      if (value !== undefined) bubbles.push({ bubbleId, value });
    }
    if (bubbleRows.length < BUBBLE_PAGE_SIZE) break;
  }
  if (totalBytes > MAX_COMPOSER_BYTES) {
    throw new Error(`对话消息数据过大（${Math.round(totalBytes / 1024 / 1024)} MB），暂不支持导入`);
  }
  return { composerId, header, data, bubbles };
}
