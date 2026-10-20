/**
 * Kimi desktop (Kimi Work / bundled kimi-code runtime) provider.
 *
 * Kimi.app stores every local agent conversation twice:
 *
 *   ~/Library/Application Support/kimi-desktop/daimon-share/daimon/
 *     agents/<agent>/sessions/hosted-logical/conversations.sqlite
 *       sessions      - one row per logical client session
 *       conversations - one row per conversation (title, workspace_path,
 *                       timestamps, kernel_records_path)
 *     runtime/kimi-code/home/sessions/wd_<workspace>/conv-<id>/agents/main/wire.jsonl
 *       append-only event log reconstructed below
 *
 * The SQLite database is metadata only. `wire.jsonl` is the transcript:
 * `turn.prompt` opens a user turn, `turn.steer` injects a mid-run user message,
 * `context.append_loop_event` carries `step.begin` / `content.part` (think or
 * text) / `tool.call` / `tool.result` / `step.end`, and `context.undo` retracts
 * the most recent turn after a cancel/retry.
 *
 * The alternatives on this machine are not conversation stores:
 *   - `~/Library/Application Support/Kimi/` only has telemetry;
 *   - `~/Library/Application Support/kimi-desktop/IndexedDB/` only has a
 *     remote-control `session_id` for the web app (history is server-side);
 *   - `~/.kimi-code/` only has `bin/rg` (no CLI sessions);
 *   - `~/.kimi_openclaw/` has one heartbeat-only OpenClaw session.
 *
 * Only `node:` builtins are imported so this file can be dropped into
 * `session-import/lib/host/providers/kimi.js` unchanged.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { displayHomePath, isAbsoluteFilePath, kimiAppSupportCandidates, sqliteFileUri } from '../platform.js';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';

/** Stable provider id (lowercase, no colon). */
export const id = 'kimi';
/** Display label for the source picker. */
export const label = 'Kimi';
/** One-line description for the source picker. */
export const description = 'Kimi Code CLI 与桌面端 Kimi Code 会话（wire.jsonl，只读）';

/** Maximum characters kept from one tool result. */
const TOOL_RESULT_MAX_CHARS = 20_000;
/** Maximum characters kept from one reasoning block. */
const REASONING_MAX_CHARS = 12_000;
/** Maximum characters kept in a conversation title. */
const TITLE_MAX_CHARS = 160;
/** Per-conversation read budget (the contract suggests 240s). */
const LOAD_BUDGET_MS = 240_000;
/** Marker used in truncated text (kept in sync with providers/shared.js). */
const TRUNCATION_LABEL = 'Kimi importer';

const HOME = os.homedir();
const APP_SUPPORT_ROOTS = kimiAppSupportCandidates();
const DEFAULT_DAIMON = path.join(APP_SUPPORT_ROOTS[0], 'daimon-share', 'daimon');

/** Candidate daimon roots (desktop app, plus an env override for testing). */
const DAIMON_ROOTS = (() => {
  const roots = [];
  const raw = process.env.KIMI_DAIMON_HOME;
  if (typeof raw === 'string' && raw.trim() !== '' && path.isAbsolute(raw)) roots.push(raw);
  for (const root of APP_SUPPORT_ROOTS) {
    roots.push(path.join(root, 'daimon-share', 'daimon'));
    roots.push(path.join(root, 'Kimi', 'daimon-share', 'daimon'));
  }
  return [...new Set(roots)];
})();

/** The canonical database path used in `status().location`. */
const DEFAULT_DB = path.join(DEFAULT_DAIMON, 'agents', 'main', 'sessions', 'hosted-logical', 'conversations.sqlite');

/**
 * Kimi Code CLI data roots. The CLI is open source and stores sessions under
 * `$KIMI_CODE_HOME` (default `~/.kimi-code` on every OS); the desktop app keeps
 * a CLI-shaped runtime home as well, which is included as a second root.
 */
const CLI_ROOTS = (() => {
  const roots = [];
  const configured = process.env.KIMI_CODE_HOME;
  if (typeof configured === 'string' && configured.trim() !== '' && path.isAbsolute(configured)) roots.push(configured);
  roots.push(path.join(HOME, '.kimi-code'));
  for (const root of DAIMON_ROOTS) roots.push(path.join(root, 'runtime', 'kimi-code', 'home'));
  return [...new Set(roots.filter((root) => fs.existsSync(root)))];
})();

/**
 * Discover Kimi Code CLI sessions (`sessions/<wdKey>/<sessionId>/agents/main/wire.jsonl`).
 * @returns session id -> `{ id, wire, state, workDir }`.
 */
function discoverCliSessions() {
  const sessions = new Map();
  for (const root of CLI_ROOTS) {
    const sessionsDir = path.join(root, 'sessions');
    if (!fs.existsSync(sessionsDir)) continue;
    const workDirs = new Map();
    try {
      for (const line of fs.readFileSync(path.join(root, 'session_index.jsonl'), 'utf8').split('\n')) {
        if (line.trim() === '') continue;
        try {
          const entry = JSON.parse(line);
          if (typeof entry?.sessionId === 'string') workDirs.set(entry.sessionId, entry.workDir ?? null);
        } catch {
          // Ignore malformed index lines; directory scanning still finds sessions.
        }
      }
    } catch {
      // No session index; fall back to directory scanning.
    }
    let buckets = [];
    try {
      buckets = fs.readdirSync(sessionsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      continue;
    }
    for (const bucket of buckets) {
      const bucketDir = path.join(sessionsDir, bucket.name);
      let sessionDirs = [];
      try {
        sessionDirs = fs.readdirSync(bucketDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
      } catch {
        continue;
      }
      for (const session of sessionDirs) {
        const sessionId = session.name;
        if (sessionId.startsWith('ctitle-') || sessions.has(sessionId)) continue;
        const sessionDir = path.join(bucketDir, sessionId);
        const wire = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
        if (!fs.existsSync(wire)) continue;
        let state = {};
        try {
          state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8'));
        } catch {
          // Metadata is optional; the wire log and directory name suffice.
        }
        sessions.set(sessionId, {
          id: sessionId,
          wire,
          state,
          workDir: workDirs.get(sessionId) ?? (typeof state?.workDir === 'string' ? state.workDir : null),
        });
      }
    }
  }
  return sessions;
}

/**
 * Build one list summary from a CLI session directory.
 * @param entry - discovered CLI session.
 * @returns summary.
 */
function cliSummary(entry) {
  const created = toMillis(Date.parse(entry.state?.createdAt), 0);
  const updated = toMillis(Date.parse(entry.state?.updatedAt), 0);
  let mtime = 0;
  try {
    mtime = Math.trunc(fs.statSync(entry.wire).mtimeMs);
  } catch {
    mtime = 0;
  }
  const cwd = isAbsoluteFilePath(entry.workDir) ? entry.workDir : null;
  const title = cleanTitle(cleanUserText(entry.state?.title ?? ''), '');
  return {
    id: entry.id,
    title: title === '' ? `Kimi 会话 ${entry.id.slice(0, 8)}` : title,
    cwd,
    cwdLabel: cwdLabel(cwd),
    createdAt: created,
    updatedAt: Math.max(created, updated, mtime),
    messageCount: null,
    isArchived: false,
  };
}

/** Replace the home prefix with `~` for display. */
function displayPath(filePath) {
  return displayHomePath(filePath, HOME);
}

/**
 * Truncate a string with a visible marker.
 * @param text - source text.
 * @param max - maximum characters kept.
 * @returns the source text or its truncated form.
 */
function clamp(text, max) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} characters by ${TRUNCATION_LABEL}]`;
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
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
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

/** Basename of an absolute directory path, for the conversation list. */
function cwdLabel(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return '';
  const parts = cwd.split(/[\\/]/).filter((part) => part !== '');
  return parts.length === 0 ? '' : parts[parts.length - 1];
}

/** Titles the client writes before it has generated a real one. */
const GENERIC_TITLES = new Set(['new conversation', 'untitled', '新对话', '新会话', '']);

/**
 * Whether a stored title is a placeholder rather than a generated name.
 * @param title - stored title.
 * @returns true when a fallback should be used.
 */
function isGenericTitle(title) {
  return GENERIC_TITLES.has(typeof title === 'string' ? title.trim().toLowerCase() : '');
}

/**
 * Remove client-injected wrappers from a user prompt.
 *
 * Kimi prepends a `<system><active-viewer-context>...</system>` block and a
 * `<meta ... />` tag to many prompts, and serializes compose attachments as
 * `<attachment>{json}</attachment>`. A slash-command turn is stored as
 * `User activated the skill "..."` plus the whole SKILL.md body. None of that
 * is user prose; keep a short attachment/skill marker instead.
 * @param raw - raw prompt text.
 * @returns cleaned user text ('' when nothing human-readable remains).
 */
function cleanUserText(raw) {
  let text = typeof raw === 'string' ? raw : '';
  const attachments = [];
  text = text.replaceAll(/<attachment>([\s\S]*?)<\/attachment>/g, (_match, json) => {
    try {
      const attachment = JSON.parse(json);
      const name = typeof attachment?.name === 'string' && attachment.name !== ''
        ? attachment.name
        : path.basename(typeof attachment?.path === 'string' ? attachment.path : '');
      if (name !== '') attachments.push(name);
    } catch {
      // Malformed attachment JSON: drop the wrapper, not the prompt.
    }
    return '';
  });
  text = text.replaceAll(/<system>[\s\S]*?<\/system>/g, '');
  text = text.replaceAll(/<meta\b[^>]*\/>/g, '');
  text = text.replaceAll(/<kimi-skill-loaded\b[\s\S]*?<\/kimi-skill-loaded>/g, '');
  const skill = text.match(/^\s*User activated the skill "([^"]+)"\.[\s\S]*$/);
  if (skill !== null) text = `[技能激活] ${skill[1]}`;
  text = text.replaceAll(/\n{3,}/g, '\n\n').trim();
  if (attachments.length > 0) text = `${text}\n[附件: ${attachments.join(', ')}]`.trim();
  return text;
}

/**
 * Collapse a `turn.prompt` / `turn.steer` input array into text.
 * @param input - array of `{type,text}` parts.
 * @returns prompt text.
 */
function inputText(input) {
  if (!Array.isArray(input)) return '';
  const parts = [];
  for (const part of input) {
    if (part === null || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
    else if (part.type === 'image' || part.type === 'image_url') parts.push('[图片]');
  }
  return parts.join('\n');
}

/**
 * Normalize tool arguments to one JSON string.
 * @param args - tool arguments object (occasionally a JSON string).
 * @returns JSON text.
 */
function argumentsText(args) {
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (trimmed === '') return '{}';
    try {
      return JSON.stringify(JSON.parse(trimmed));
    } catch {
      return JSON.stringify({ text: args });
    }
  }
  if (args === null || args === undefined) return '{}';
  try {
    return JSON.stringify(args);
  } catch {
    return JSON.stringify({ text: String(args) });
  }
}

/**
 * Turn a structured tool result into display text.
 * Kimi returns strings, arrays of content parts (`text`, `image_url`,
 * `video_url`) or plain JSON objects. Blob references are not resolvable
 * outside the app, so images/videos become a short marker.
 * @param output - result payload.
 * @returns display text.
 */
function outputText(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    const lines = [];
    for (const part of output) {
      if (typeof part === 'string') {
        lines.push(part);
      } else if (part !== null && typeof part === 'object') {
        if (part.type === 'text' && typeof part.text === 'string') lines.push(part.text);
        else if (part.type === 'image_url') lines.push('[图片]');
        else if (part.type === 'video_url') lines.push('[视频]');
        else {
          try {
            lines.push(JSON.stringify(part));
          } catch {
            lines.push(String(part));
          }
        }
      }
    }
    return lines.join('\n');
  }
  if (output === null || output === undefined) return '';
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

/* ── SQLite access (node:sqlite, with a system sqlite3 fallback) ─────────── */

/** Cached `node:sqlite` module, `undefined` until probed, `null` when absent. */
let sqliteModule;
/** Cached `sqlite3` executable path, `undefined` until probed, `null` when absent. */
let sqliteCli;

/**
 * Discover `conversations.sqlite` files for every local Kimi agent.
 * @returns existing database paths.
 */
function discoverDatabases() {
  const found = [];
  const add = (filePath) => {
    if (typeof filePath === 'string' && fs.existsSync(filePath) && !found.includes(filePath)) found.push(filePath);
  };
  if (process.env.KIMI_CONVERSATIONS_DB) add(process.env.KIMI_CONVERSATIONS_DB);
  for (const root of DAIMON_ROOTS) {
    add(path.join(root, 'agents', 'main', 'sessions', 'hosted-logical', 'conversations.sqlite'));
    const agents = path.join(root, 'agents');
    try {
      for (const name of fs.readdirSync(agents)) {
        add(path.join(agents, name, 'sessions', 'hosted-logical', 'conversations.sqlite'));
      }
    } catch {
      // No agents directory under this root.
    }
  }
  return found;
}

/**
 * Locate the `sqlite3` CLI once, for environments without `node:sqlite`.
 * @returns executable path or null.
 */
function sqliteExecutable() {
  if (sqliteCli !== undefined) return sqliteCli;
  for (const candidate of [process.env.SQLITE3, 'sqlite3']) {
    if (typeof candidate !== 'string' || candidate === '') continue;
    try {
      execFileSync(candidate, ['-version'], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'], timeout: 5_000 });
      sqliteCli = candidate;
      return sqliteCli;
    } catch {
      // Try the next candidate.
    }
  }
  sqliteCli = null;
  return sqliteCli;
}

/**
 * Run one read-only query and return rows as plain objects.
 * @param dbPath - SQLite file.
 * @param sql - SELECT statement.
 * @param params - bound values for node:sqlite; literals are escaped for the CLI.
 * @returns row objects.
 */
async function queryRows(dbPath, sql, params = []) {
  if (sqliteModule === undefined) {
    try {
      sqliteModule = await import('node:sqlite');
    } catch {
      sqliteModule = null;
    }
  }
  if (sqliteModule !== null && typeof sqliteModule.DatabaseSync === 'function') {
    const db = new sqliteModule.DatabaseSync(dbPath, { readOnly: true });
    try {
      return db.prepare(sql).all(...params).map((row) => ({ ...row }));
    } finally {
      db.close();
    }
  }
  const executable = sqliteExecutable();
  if (executable === null) throw new Error('SQLite 读取不可用（缺少 node:sqlite 与 sqlite3 CLI）');
  let literalSql = sql;
  for (const value of params) {
    const literal = `'${String(value).replaceAll("'", "''")}'`;
    literalSql = literalSql.replace('?', literal);
  }
  const output = execFileSync(executable, ['-json', sqliteFileUri(dbPath), literalSql], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
  });
  const text = output.trim();
  return text === '' ? [] : JSON.parse(text);
}

/**
 * Read every conversation row across all local databases.
 * @returns conversation rows (newest first).
 */
async function allRows() {
  const dbs = discoverDatabases();
  if (dbs.length === 0) return [];
  const rows = [];
  const seen = new Set();
  for (const dbPath of dbs) {
    let part;
    try {
      part = await queryRows(
        dbPath,
        'select conversation_id, title, first_user_text, workspace_path, created_at_ms, updated_at_ms, kernel_records_path from conversations',
      );
    } catch {
      continue;
    }
    for (const row of part) {
      const key = typeof row.conversation_id === 'string' ? row.conversation_id : '';
      if (key === '' || seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
  }
  return rows;
}

/**
 * Read one conversation row by id.
 * @param conversationId - conversation UUID.
 * @returns row or null.
 */
async function rowById(conversationId) {
  if (typeof conversationId !== 'string' || conversationId === '') return null;
  for (const dbPath of discoverDatabases()) {
    let rows;
    try {
      rows = await queryRows(
        dbPath,
        'select conversation_id, title, first_user_text, workspace_path, created_at_ms, updated_at_ms, kernel_records_path from conversations where conversation_id = ? limit 1',
        [conversationId],
      );
    } catch {
      continue;
    }
    if (rows.length > 0) return rows[0];
  }
  return null;
}

/* ── wire.jsonl parsing ────────────────────────────────────────────────── */

/**
 * Build one transcript from a wire event log.
 * @param wirePath - absolute `wire.jsonl` path.
 * @param row - SQLite conversation row.
 * @param deadline - `Date.now()` deadline for the read budget.
 * @returns parsed facts (turns, last event time, parse error count).
 */
async function parseWire(wirePath, row, deadline) {
  /** @type {Array<{at:number,user:null|{content:Array<{type:'text',text:string}>},runs:Array<any>,_canceled?:boolean}>} */
  const turns = [];
  /** Raw call id -> queue of calls waiting for a result. */
  const pending = new Map();
  /** Raw call id -> every call ever seen (for duplicate/out-of-order results). */
  const allCalls = new Map();
  /** Conversation-wide ids, so a duplicate source id gets a suffix. */
  const usedIds = new Set();
  let currentTurn = null;
  let currentRun = null;
  let lastEventTime = 0;
  let eventCount = 0;
  let parseErrors = 0;
  let syntheticId = 0;

  /**
   * Give one raw id a conversation-unique value.
   * @param raw - source id.
   * @returns unique id.
   */
  const uniqueId = (raw) => {
    const base = typeof raw === 'string' && raw !== '' ? raw : `call_${++syntheticId}`;
    let candidate = base;
    let suffix = 1;
    while (usedIds.has(candidate)) {
      suffix += 1;
      candidate = `${base}~${suffix}`;
    }
    usedIds.add(candidate);
    return candidate;
  };

  /**
   * Open a synthetic turn when a loop event has no preceding prompt.
   * @param at - event time.
   * @returns the current turn.
   */
  const ensureTurn = (at) => {
    if (currentTurn === null) {
      currentTurn = { at, user: null, runs: [] };
      turns.push(currentTurn);
    }
    return currentTurn;
  };

  /**
   * Start one model round (one assistant message).
   * @param at - step time.
   * @returns the new run.
   */
  const startRun = (at) => {
    const turn = ensureTurn(at);
    const run = { at, blocks: [], _calls: [], _results: new Map() };
    turn.runs.push(run);
    currentRun = run;
    return run;
  };

  /** Get the current run, creating one for stray parts/results. */
  const ensureRun = (at) => currentRun ?? startRun(at);

  /**
   * Append one tool-call block and enqueue it for result pairing.
   * @param run - owning run.
   * @param rawId - source call id.
   * @param name - tool name.
   * @param args - tool arguments.
   * @returns the call descriptor.
   */
  const addCall = (run, rawId, name, args) => {
    const block = {
      type: 'tool-call',
      id: uniqueId(rawId),
      name: typeof name === 'string' && name !== '' ? name : 'tool',
      arguments: argumentsText(args),
    };
    run.blocks.push(block);
    const call = { block, run };
    run._calls.push(call);
    const raw = typeof rawId === 'string' && rawId !== '' ? rawId : block.id;
    const queue = pending.get(raw) ?? [];
    queue.push(call);
    pending.set(raw, queue);
    const seen = allCalls.get(raw) ?? [];
    seen.push(call);
    allCalls.set(raw, seen);
    return call;
  };

  /**
   * Attach one tool result to the call that advertised it.
   * @param at - result time.
   * @param rawId - source call id.
   * @param result - result payload (`{output,isError}` and friends).
   * @param event - full loop event (for fallback name/args).
   */
  const addResult = (at, rawId, result, event) => {
    const raw = typeof rawId === 'string' ? rawId : '';
    const queue = pending.get(raw) ?? [];
    let call = queue.length > 0 ? queue.shift() : null;
    if (call === null) {
      // A duplicate result for a call that already has one: keep exactly one.
      const old = (allCalls.get(raw) ?? []).find((entry) => !entry.run._results.has(entry.block.id));
      if (old !== undefined) call = old;
    }
    if (call === null) {
      // Result without a recorded call (interrupted/imported branch): synthesize
      // the call block so the writer's one-call/one-result invariant still holds.
      const run = ensureRun(at);
      call = addCall(run, raw, event?.name ?? event?.toolName ?? 'tool', event?.args ?? {});
      pending.get(raw)?.shift();
    }
    if (call.run._results.has(call.block.id)) return;
    const payload = result !== null && typeof result === 'object' ? result : { output: result };
    const output = clamp(outputText(payload.output ?? ''), TOOL_RESULT_MAX_CHARS);
    call.run._results.set(call.block.id, {
      callId: call.block.id,
      name: call.block.name,
      arguments: call.block.arguments,
      output,
      isError: payload.isError === true || event?.isError === true,
      at,
    });
  };

  const reader = readline.createInterface({
    input: fs.createReadStream(wirePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let sinceCheck = 0;
  for await (const line of reader) {
    if (line === '') continue;
    eventCount += 1;
    sinceCheck += 1;
    if (sinceCheck >= 4096) {
      sinceCheck = 0;
      if (Date.now() > deadline) {
        parseErrors += 1;
        break;
      }
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      parseErrors += 1;
      continue;
    }
    if (record === null || typeof record !== 'object') continue;
    const at = toMillis(record.time, lastEventTime);
    if (at > lastEventTime) lastEventTime = at;
    const type = record.type;

    if (type === 'turn.prompt' || type === 'turn.steer') {
      const text = cleanUserText(inputText(record.input));
      const turn = {
        at,
        user: text.trim() === '' ? null : { content: [{ type: 'text', text }] },
        runs: [],
      };
      turns.push(turn);
      currentTurn = turn;
      currentRun = null;
      continue;
    }
    if (type === 'context.undo') {
      const count = Number.isInteger(record.count) && record.count > 0 ? record.count : 1;
      if (count >= turns.length) turns.length = 0;
      else turns.splice(turns.length - count, count);
      currentTurn = null;
      currentRun = null;
      continue;
    }
    if (type === 'turn.cancel') {
      if (currentTurn !== null) currentTurn._canceled = true;
      currentRun = null;
      continue;
    }
    if (type !== 'context.append_loop_event') continue;

    const event = record.event;
    if (event === null || typeof event !== 'object') continue;
    const eventType = event.type;

    if (eventType === 'step.begin') {
      startRun(at);
      continue;
    }
    if (eventType === 'content.part') {
      const part = event.part;
      if (part === null || typeof part !== 'object') continue;
      const run = ensureRun(at);
      if (part.type === 'think') {
        const text = clamp(typeof part.think === 'string' ? part.think : typeof part.text === 'string' ? part.text : '', REASONING_MAX_CHARS);
        if (text.trim() !== '') run.blocks.push({ type: 'reasoning', text });
      } else if (part.type === 'text') {
        const text = typeof part.text === 'string' ? part.text : '';
        if (text.trim() !== '') run.blocks.push({ type: 'text', text });
      } else if (part.type === 'image_url' || part.type === 'image') {
        run.blocks.push({ type: 'text', text: '[图片]' });
      }
      continue;
    }
    if (eventType === 'tool.call') {
      const run = ensureRun(at);
      addCall(run, event.toolCallId ?? event.uuid, event.name, event.args ?? event.input ?? {});
      continue;
    }
    if (eventType === 'tool.result') {
      addResult(at, event.toolCallId ?? event.parentUuid, event.result, event);
      continue;
    }
    if (eventType === 'step.end') {
      currentRun = null;
    }
  }

  return { turns, lastEventTime, eventCount, parseErrors };
}

/**
 * Finalize parsed turns: drop empty rounds, add missing results, enforce the
 * one-call/one-result invariant, and order results exactly like the calls.
 * @param turns - parsed turns.
 * @returns normalized turns.
 */
function finalizeTurns(turns) {
  const output = [];
  for (const turn of turns) {
    const runs = [];
    for (const run of turn.runs) {
      const blocks = [];
      for (const block of run.blocks) {
        if (block === null || typeof block !== 'object') continue;
        if (block.type === 'tool-call') {
          if (typeof block.id === 'string' && block.id !== '') blocks.push(block);
        } else if ((block.type === 'text' || block.type === 'reasoning') && typeof block.text === 'string' && block.text.trim() !== '') {
          blocks.push(block);
        }
      }
      if (blocks.length === 0 && run._calls.length === 0) continue;

      const toolResults = [];
      const callIds = new Set();
      for (const call of run._calls) {
        callIds.add(call.block.id);
        const stored = run._results.get(call.block.id);
        if (stored !== undefined) {
          toolResults.push(stored);
        } else {
          toolResults.push({
            callId: call.block.id,
            name: call.block.name,
            arguments: call.block.arguments,
            output: '[结果未记录]',
            isError: true,
            at: run.at,
          });
        }
      }
      // Defensive: a result whose call block was filtered out (should not
      // happen) still gets a matching call, never an orphan result.
      for (const [callId, result] of run._results) {
        if (callIds.has(callId)) continue;
        blocks.push({ type: 'tool-call', id: result.callId, name: result.name, arguments: result.arguments });
        toolResults.push(result);
      }
      runs.push({ at: run.at, blocks, toolResults });
    }
    const user = turn.user !== null && turn.user.content.length > 0 ? turn.user : null;
    if (runs.length === 0 && user === null) continue;
    output.push({ at: turn.at, user, runs });
  }
  return output;
}

/**
 * Find the first user-visible text in a transcript.
 * @param turns - normalized turns.
 * @returns text or ''.
 */
function firstUserText(turns) {
  for (const turn of turns) {
    if (turn.user === null) continue;
    for (const part of turn.user.content) {
      if (typeof part.text === 'string' && part.text.trim() !== '') return part.text;
    }
  }
  return '';
}

/* ── Provider contract ─────────────────────────────────────────────────── */

/**
 * Report whether local Kimi conversation data is readable.
 * @returns availability facts.
 */
export async function status() {
  const databases = discoverDatabases();
  const cliSessions = discoverCliSessions();
  const cliRoot = CLI_ROOTS.length > 0 ? path.join(CLI_ROOTS[0], 'sessions') : path.join(HOME, '.kimi-code', 'sessions');
  if (databases.length === 0 && cliSessions.size === 0) {
    return {
      available: false,
      location: displayPath(cliRoot),
      error: '找不到 Kimi 会话数据（conversations.sqlite 或 ~/.kimi-code/sessions）',
    };
  }
  try {
    const rows = databases.length > 0 ? await allRows() : [];
    const available = rows.length > 0 || cliSessions.size > 0;
    return {
      available,
      location: displayPath(databases[0] ?? cliRoot),
      error: available ? null : 'Kimi 会话数据存在，但没有可导入的会话',
    };
  } catch (error) {
    return {
      available: cliSessions.size > 0,
      location: displayPath(databases[0] ?? cliRoot),
      error: cliSessions.size > 0 ? null : String(error?.message ?? error),
    };
  }
}

/**
 * List importable Kimi conversations, newest first.
 * `messageCount` is null here (the exact count needs the 55 MB wire corpus);
 * `load()` computes it.
 * @returns conversation summaries.
 */
export async function list() {
  const rows = await allRows();
  const summaries = [];
  const knownIds = new Set();
  for (const row of rows) {
    const conversationId = typeof row.conversation_id === 'string' ? row.conversation_id : '';
    if (conversationId === '') continue;
    const wirePath = typeof row.kernel_records_path === 'string' ? row.kernel_records_path : '';
    if (wirePath === '' || !fs.existsSync(wirePath)) continue;
    let mtime = 0;
    try {
      mtime = Math.trunc(fs.statSync(wirePath).mtimeMs);
    } catch {
      mtime = 0;
    }
    const created = toMillis(row.created_at_ms, 0);
    const updated = Math.max(toMillis(row.updated_at_ms, 0), mtime);
    const cwd = typeof row.workspace_path === 'string' && path.isAbsolute(row.workspace_path) ? row.workspace_path : null;
    const title = isGenericTitle(row.title)
      ? cleanTitle(cleanUserText(row.first_user_text), '')
      : cleanTitle(row.title, '');
    knownIds.add(conversationId);
    summaries.push({
      id: conversationId,
      title: title === '' ? `Kimi 会话 ${conversationId.slice(0, 8)}` : title,
      cwd,
      cwdLabel: cwdLabel(cwd),
      createdAt: created,
      updatedAt: Math.max(created, updated),
      messageCount: null,
      isArchived: false,
    });
  }
  for (const entry of discoverCliSessions().values()) {
    if (knownIds.has(entry.id)) continue;
    summaries.push(cliSummary(entry));
  }
  summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  return summaries;
}

/**
 * Load and normalize one Kimi conversation.
 * @param conversationId - conversation UUID.
 * @returns neutral conversation.
 */
export async function load(conversationId) {
  let row = await rowById(conversationId);
  if (row === null) {
    const entry = discoverCliSessions().get(conversationId);
    if (entry === undefined) throw new Error(`Kimi 会话不存在: ${conversationId}`);
    row = {
      conversation_id: entry.id,
      title: cleanUserText(typeof entry.state?.title === 'string' ? entry.state.title : ''),
      first_user_text: '',
      workspace_path: isAbsoluteFilePath(entry.workDir) ? entry.workDir : null,
      created_at_ms: toMillis(Date.parse(entry.state?.createdAt), 0),
      updated_at_ms: toMillis(Date.parse(entry.state?.updatedAt), 0),
      kernel_records_path: entry.wire,
    };
  }
  const wirePath = typeof row.kernel_records_path === 'string' ? row.kernel_records_path : '';
  if (wirePath === '' || !fs.existsSync(wirePath)) throw new Error(`Kimi 会话记录文件不存在: ${wirePath}`);

  const started = Date.now();
  const parsed = await parseWire(wirePath, row, started + LOAD_BUDGET_MS);
  const turns = finalizeTurns(parsed.turns);
  if (turns.length === 0) throw new Error(`Kimi 会话没有可导入的消息: ${conversationId}`);

  const firstAt = turns[0]?.at ?? 0;
  const rowCreated = toMillis(row.created_at_ms, 0);
  const createdAt = rowCreated > 0 && firstAt > 0 ? Math.min(rowCreated, firstAt) : rowCreated || firstAt;
  let mtime = 0;
  try {
    mtime = Math.trunc(fs.statSync(wirePath).mtimeMs);
  } catch {
    mtime = 0;
  }
  const lastTurnAt = turns[turns.length - 1]?.at ?? 0;
  const updatedAt = Math.max(createdAt, toMillis(row.updated_at_ms, 0), parsed.lastEventTime, lastTurnAt, mtime);

  const cwd = typeof row.workspace_path === 'string' && path.isAbsolute(row.workspace_path) ? row.workspace_path : null;
  const fallbackTitle = cleanTitle(cleanUserText(row.first_user_text), '') || cleanTitle(firstUserText(turns), '');
  const title = isGenericTitle(row.title)
    ? cleanTitle(fallbackTitle, `Kimi 会话 ${conversationId.slice(0, 8)}`)
    : cleanTitle(row.title, fallbackTitle || `Kimi 会话 ${conversationId.slice(0, 8)}`);

  let messageCount = 0;
  for (const turn of turns) {
    if (turn.user !== null) messageCount += 1;
    messageCount += turn.runs.length;
  }

  return {
    source: id,
    id: conversationId,
    title,
    createdAt,
    updatedAt,
    cwd,
    messageCount,
    turns,
  };
}
