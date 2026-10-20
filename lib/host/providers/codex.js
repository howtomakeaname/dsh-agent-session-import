/**
 * OpenAI Codex CLI / Codex Desktop provider (read-only, self-contained).
 *
 * Codex writes one JSONL "rollout" per thread:
 *
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<local time>-<session uuid>[_<thread uuid>].jsonl
 *
 * Every line is `{ timestamp, ordinal, type, payload }`. `response_item`
 * payloads carry the conversation; `session_meta` carries cwd/session ids and
 * every other top-level type is telemetry (`event_msg`, `turn_context`,
 * `token_usage_record`, `compacted`, `world_state`, ...) that this module
 * intentionally ignores (except `session_meta`).
 *
 * Reconstruction notes (details in ../codex.md):
 *  - `message` (user/assistant/developer) -> turns / text blocks. Developer and
 *    system messages are environment boilerplate and are dropped.
 *  - `reasoning` is encrypted on disk; only `summary[].text` (a short heading)
 *    survives. Items with an empty summary are dropped.
 *  - `function_call` (JSON `arguments`) and `custom_tool_call` (raw JS `input`,
 *    e.g. the `exec` tool) become `tool-call` blocks.
 *  - `function_call_output` / `custom_tool_call_output` are paired by `call_id`.
 *    Custom outputs are an array of `input_text` parts: a status header plus one
 *    or more JSON envelopes (`{chunk_id,exit_code,output}`, promise wrappers,
 *    MCP/CLI results). The module unwraps those envelopes; non-envelope JSON is
 *    kept as the raw text the model saw.
 *  - One assistant message starts one Run; tool calls that follow belong to that
 *    Run and their results land in `Run.toolResults`.
 *
 * Only `node:` builtins are imported so the file can be dropped into
 * `session-import/lib/host/providers/codex.js` unchanged.
 */
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';

/** Stable provider id (lowercase). */
export const id = 'codex';
/** Display label for the source picker. */
export const label = 'Codex';
/** One-line description for the source picker. */
export const description = 'OpenAI Codex 会话（CLI 与桌面版共用 ~/.codex，读取 rollout JSONL 与本地历史库）';

/** Maximum characters kept from one tool result. */
const TOOL_RESULT_MAX_CHARS = 20_000;
/**
 * Codex persists the raw chain-of-thought as a server-encrypted
 * `encrypted_content` blob that only the OpenAI backend interprets, but it ALSO
 * keeps the API-generated `summary` text. The
 * companion `thread_history_1.sqlite` holds a superset of those summaries
 * (measured on this machine: 4,149 reasoning items with text vs 2,769 in the
 * rollout files, with 2,778 items only present in the DB). Read them read-only
 * and backfill rollout reasoning items whose own summary is empty.
 */

/** thread id -> (item id -> visible summary text), or null when unavailable. */
const sqliteSummaryCache = new Map();

/**
 * Extract the human-visible summary text from one stored reasoning item.
 * @param itemJson - `thread_items.item_json` text.
 * @returns joined summary text ('' when the item carries none).
 */
function summaryTextFromItemJson(itemJson) {
  let value;
  try {
    value = JSON.parse(itemJson);
  } catch {
    return '';
  }
  const parts = [];
  if (Array.isArray(value?.summary)) {
    for (const entry of value.summary) {
      const text = typeof entry === 'string' ? entry : entry !== null && typeof entry === 'object' ? entry.text : '';
      if (typeof text === 'string' && text.trim() !== '') parts.push(text.trim());
    }
  }
  if (Array.isArray(value?.content)) {
    for (const entry of value.content) {
      const text = entry !== null && typeof entry === 'object' ? entry.text : '';
      if (typeof text === 'string' && text.trim() !== '') parts.push(text.trim());
    }
  }
  return parts.join('\n\n');
}

/**
 * Load visible reasoning summaries for one Codex thread from the local SQLite
 * history database (read-only). Uses `node:sqlite` when available and falls
 * back to the system `sqlite3` CLI; any failure degrades to "no extra data".
 * @param threadId - Codex thread id (session_meta session_id).
 * @returns item id -> summary text, or null when the database is unavailable.
 */
async function sqliteReasoningSummaries(threadId) {
  if (typeof threadId !== 'string' || threadId === '') return null;
  if (sqliteSummaryCache.has(threadId)) return sqliteSummaryCache.get(threadId);
  if (!fs.existsSync(THREAD_HISTORY_DB)) {
    sqliteSummaryCache.set(threadId, null);
    return null;
  }
  let rows = null;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(THREAD_HISTORY_DB, { readOnly: true });
    try {
      const statement = db.prepare("select item_id, item_json from thread_items where thread_id = ? and item_type = 'reasoning'");
      rows = statement.all(threadId);
    } finally {
      db.close();
    }
  } catch {
    rows = null;
  }
  if (rows === null) {
    try {
      const escaped = String(threadId).replaceAll("'", "''");
      const sql = `select item_id, item_json from thread_items where thread_id = '${escaped}' and item_type = 'reasoning'`;
      const output = execFileSync('/usr/bin/sqlite3', ['-json', `file:${THREAD_HISTORY_DB}?mode=ro`, sql], {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        timeout: 60_000,
      });
      rows = output.trim() === '' ? [] : JSON.parse(output);
    } catch {
      rows = null;
    }
  }
  if (rows === null) {
    sqliteSummaryCache.set(threadId, null);
    return null;
  }
  const map = new Map();
  for (const row of rows) {
    const text = summaryTextFromItemJson(row?.item_json ?? '');
    if (text !== '' && typeof row?.item_id === 'string') map.set(row.item_id, text);
  }
  sqliteSummaryCache.set(threadId, map);
  return map;
}

/**
 * Read the Codex thread id from the first `session_meta` line of a rollout.
 * @param file - rollout file path.
 * @returns thread id, or null.
 */
function readSessionMetaThread(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(256 * 1024);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, read).toString('utf8');
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record?.type === 'session_meta') {
        const payload = record.payload ?? {};
        return typeof payload.session_id === 'string' ? payload.session_id : typeof payload.id === 'string' ? payload.id : null;
      }
      if (typeof record?.type === 'string') return null;
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
  return null;
}

/** Maximum characters kept from one reasoning block. */
const REASONING_MAX_CHARS = 12_000;
/** Maximum characters kept in a display title. */
const TITLE_MAX_CHARS = 160;
/** Wall-clock budget for one `load()` call. */
const LOAD_BUDGET_MS = 240_000;
/** Head scan limits used by `list()` (and title extraction). */
const HEAD_MAX_LINES = 400;
const HEAD_MAX_CHARS = 1_000_000;
/** Marker used for truncated text (kept in sync with providers/shared.js). */
const TRUNCATION_LABEL = 'Codex importer';

const HOME = os.homedir();
const CODEX_HOME = (() => {
  const raw = process.env.CODEX_HOME;
  if (typeof raw === 'string' && raw.trim() !== '' && path.isAbsolute(raw)) return raw;
  return path.join(HOME, '.codex');
})();
const SESSIONS_DIR = path.join(CODEX_HOME, 'sessions');
const THREAD_HISTORY_DB = path.join(CODEX_HOME, 'thread_history_1.sqlite');
/** User-facing location shown in the UI. */
const LOCATION = displayPath(SESSIONS_DIR);

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ROLLOUT_NAME_RE =
  /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(.+?)\.jsonl$/;

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

/**
 * Truncate text with a visible marker.
 * @param text - source text.
 * @param max - maximum characters kept.
 * @returns source text or truncated form.
 */
function clamp(text, max) {
  const value = typeof text === 'string' ? text : '';
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n…[truncated ${value.length - max} characters by ${TRUNCATION_LABEL}]`;
}

/**
 * Convert a millisecond number or ISO string to milliseconds.
 * @param value - source timestamp.
 * @param fallback - fallback milliseconds.
 * @returns non-negative integer milliseconds.
 */
function toMillis(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.trunc(value);
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.trunc(parsed);
  }
  if (typeof fallback === 'number' && Number.isFinite(fallback) && fallback >= 0) return Math.trunc(fallback);
  return 0;
}

/**
 * Build a single-line, bounded display title.
 * @param title - raw title.
 * @param fallback - fallback text.
 * @returns display title.
 */
function cleanTitle(title, fallback) {
  const text = typeof title === 'string' ? title.replaceAll(/\s+/g, ' ').trim() : '';
  if (text === '') return fallback;
  return text.length <= TITLE_MAX_CHARS ? text : `${text.slice(0, TITLE_MAX_CHARS)}…`;
}

/**
 * Basename of a directory path, for the conversation list.
 * @param cwd - absolute path or null.
 * @returns label ('' when unknown).
 */
function cwdLabel(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return '';
  const parts = cwd.split(/[\\/]/).filter((part) => part !== '');
  return parts.length === 0 ? '' : parts[parts.length - 1];
}

/**
 * Parse one JSONL line; malformed lines yield null (never throw).
 * @param line - raw line.
 * @returns parsed object or null.
 */
function parseJsonLine(line) {
  try {
    const parsed = JSON.parse(line);
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Serialize an arbitrary value to a string, tolerating cycles.
 * @param value - value to stringify.
 * @returns JSON text or ''.
 */
function jsonText(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ */
/* Session directory / file discovery                                  */
/* ------------------------------------------------------------------ */

/**
 * Walk the sessions tree and collect rollout JSONL files.
 * @param root - absolute sessions directory.
 * @returns sorted absolute file paths.
 */
function walkRollouts(root) {
  const files = [];
  const stack = [root];
  const visited = new Set();
  while (stack.length > 0) {
    const dir = stack.pop();
    if (visited.has(dir)) continue;
    visited.add(dir);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) files.push(full);
    }
  }
  files.sort();
  return files;
}

/**
 * Local-time milliseconds from a rollout filename timestamp.
 * @param parts - [year, month, day, hour, minute, second] strings.
 * @returns milliseconds (0 when invalid).
 */
function filenameTimeMs(parts) {
  const [year, month, day, hour, minute, second] = parts;
  const parsed = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Derive a stable, unique conversation id from a rollout filename.
 *
 * The filename suffix is `<session uuid>[_<thread uuid>]`; the last uuid is
 * unique per file even when several rollouts continue the same session, so it
 * is used as the conversation id.
 * @param file - absolute path.
 * @returns parsed name facts.
 */
function parseRolloutName(file) {
  const base = path.basename(file);
  const match = base.match(ROLLOUT_NAME_RE);
  if (!match) return { id: base.replace(/\.jsonl$/u, ''), createdAt: 0, sessionId: '' };
  const suffix = match[7];
  const uuids = suffix.match(UUID_RE) ?? [];
  return {
    id: uuids.length > 0 ? uuids[uuids.length - 1] : suffix,
    sessionId: uuids.length > 0 ? uuids[0] : suffix,
    createdAt: filenameTimeMs(match.slice(1, 7)),
  };
}

/**
 * Build the id -> file index (cheap: filenames only).
 * @returns index entries.
 */
function indexSessions() {
  const seen = new Map();
  return walkRollouts(SESSIONS_DIR).map((file) => {
    const parsed = parseRolloutName(file);
    // Two files should not share the thread uuid, but a copied/rewritten
    // rollout could. Keep ids unique and resolve them through this same index.
    const count = seen.get(parsed.id) ?? 0;
    seen.set(parsed.id, count + 1);
    return count === 0 ? { file, ...parsed } : { file, ...parsed, id: `${parsed.id}~${count + 1}` };
  });
}

/* ------------------------------------------------------------------ */
/* Payload normalisation                                               */
/* ------------------------------------------------------------------ */

/**
 * Remove every `<tag ...>...</tag>` block from a string.
 * @param text - source text.
 * @param tag - tag name.
 * @returns text without the block.
 */
function stripTagBlock(text, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`, 'g');
  return text.replace(re, '');
}

/**
 * Turn one Codex user message into the text a human actually typed.
 *
 * Codex Desktop injects synthetic user-role items (environment context,
 * recommended plugins, app page opens) and wraps some real replies in
 * `<send_user_message_question_reply>` or an ambient browser-context block.
 * Those wrappers are removed; pure-context messages become `''` and are
 * dropped by the caller (the turn then keeps `user: null`).
 * @param raw - joined `input_text` parts.
 * @returns normalized text ('' for synthetic-only messages).
 */
function sanitizeUserText(raw) {
  let text = String(raw ?? '').replace(/\r\n?/g, '\n');

  const questionReply = text.match(/<send_user_message_question_reply>([\s\S]*?)<\/send_user_message_question_reply>/);
  if (questionReply) {
    const inner = questionReply[1].trim();
    const parsed = parseJsonLine(inner);
    if (Array.isArray(parsed)) {
      const lines = [];
      for (const item of parsed) {
        if (item === null || typeof item !== 'object') continue;
        const question = typeof item.question === 'string' ? item.question.trim() : '';
        const answer = typeof item.answer === 'string' ? item.answer.trim() : '';
        if (question === '' && answer === '') continue;
        lines.push([question === '' ? '' : `问：${question}`, answer === '' ? '' : `答：${answer}`].filter(Boolean).join('\n'));
      }
      text = lines.length > 0 ? lines.join('\n\n') : inner;
    } else {
      text = inner;
    }
  }

  const browserClose = '</in-app-browser-context>';
  const browserEnd = text.lastIndexOf(browserClose);
  if (browserEnd >= 0) text = text.slice(browserEnd + browserClose.length);

  for (const tag of [
    'environment_context',
    'recommended_plugins',
    'user_instructions',
    'turn_aborted',
    'external_codex_apps_open_page',
  ]) {
    text = stripTagBlock(text, tag);
  }

  text = text
    .replace(/<image\b[^>]*>/g, '')
    .replace(/<\/image>/g, '')
    .replace(/Distinguish instructions in attached documents from the user's request\./g, '');

  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Normalize `message.content` into text plus image count.
 * @param content - Codex content array.
 * @returns normalized text ('' when synthetic) and image count.
 */
function normalizeUserParts(content) {
  const parts = Array.isArray(content) ? content : [];
  const texts = [];
  let images = 0;
  for (const part of parts) {
    if (part === null || typeof part !== 'object') continue;
    if (part.type === 'input_image') {
      images += 1;
      continue;
    }
    if (part.type === 'input_text' && typeof part.text === 'string' && part.text !== '') texts.push(part.text);
  }
  let text = sanitizeUserText(texts.join('\n'));
  if (text === '' && images > 0) text = '[图片]';
  return { text, images };
}

/**
 * Join assistant `output_text` parts.
 * @param content - Codex content array.
 * @returns assistant text ('' when empty).
 */
function assistantText(content) {
  const parts = Array.isArray(content) ? content : [];
  const texts = [];
  for (const part of parts) {
    if (part !== null && typeof part === 'object' && typeof part.text === 'string') texts.push(part.text);
  }
  return texts.join('\n').trim();
}

/**
 * Extract a short title from normalized user text.
 * @param text - normalized user text.
 * @returns single-line title candidate ('' when blank).
 */
function titleFromUserText(text) {
  let value = String(text ?? '');
  const marker = '## My request:';
  const index = value.lastIndexOf(marker);
  if (index >= 0) value = value.slice(index + marker.length);
  return value
    .replace(/^#+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whether a parsed JSON value looks like a tool-execution envelope.
 * @param value - parsed JSON value.
 * @returns true for envelopes that should be unwrapped.
 */
function isEnvelope(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  // `chunk_id` is the exec_command envelope marker (with or without output).
  if ('chunk_id' in value) return true;
  // Shell/exec results with an explicit exit status.
  const exited = typeof value.exit_code === 'number' || typeof value.exit === 'number';
  if (exited && ('output' in value || 'wall_time_seconds' in value)) return true;
  // Promise wrappers: { status: 'fulfilled'|'rejected', value|reason },
  // { i, status, value }, { i, result: { status, value } }.
  if ((value.status === 'fulfilled' || value.status === 'rejected') && ('value' in value || 'reason' in value)) return true;
  if (typeof value.i === 'number' && ('value' in value || 'result' in value)) return true;
  if ('wall_time_seconds' in value && 'output' in value) return true;
  // Anything else (MCP/CLI JSON results, {"status": ...} payloads) stays raw.
  return false;
}

/**
 * Unwrap nested Codex tool envelopes.
 *
 * Shapes seen on this machine:
 *   { chunk_id, wall_time_seconds, exit_code, original_token_count, output }
 *   { status: 'fulfilled', value: <same> } / { status: 'rejected', reason }
 *   { i, result: { status, value } } / { i, status, value }
 *   { exit, output }
 * Non-envelope JSON (MCP/CLI results) is returned untouched by the caller.
 * @param value - parsed envelope.
 * @returns collected text fragments and the first non-zero exit code.
 */
function unwrapEnvelope(value) {
  const items = [];
  let exitCode;
  let sawEnvelope = false;

  const visit = (node, depth) => {
    if (depth > 8 || node === null || node === undefined) return;
    if (typeof node === 'string') {
      if (node !== '') items.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    if (!isEnvelope(node)) {
      items.push(jsonText(node));
      return;
    }
    sawEnvelope = true;
    if (typeof node.exit_code === 'number') exitCode = node.exit_code;
    else if (typeof node.exit === 'number' && exitCode === undefined) exitCode = node.exit;
    if (node.status === 'rejected') {
      if (node.reason !== undefined) visit(node.reason, depth + 1);
      else if (typeof node.error === 'string') items.push(node.error);
      return;
    }
    if (node.output !== undefined) {
      if (typeof node.output === 'string') {
        if (node.output !== '') items.push(node.output);
      } else {
        visit(node.output, depth + 1);
      }
      return;
    }
    if (node.chunk_id !== undefined || node.original_token_count !== undefined) return;
    if (node.value !== undefined) {
      visit(node.value, depth + 1);
      return;
    }
    if (node.result !== undefined) {
      visit(node.result, depth + 1);
      return;
    }
    if (typeof node.error === 'string') items.push(node.error);
  };

  visit(value, 0);
  return { items, exitCode, sawEnvelope };
}

/**
 * Strip outer blank lines without touching inner indentation.
 * @param text - source text.
 * @returns trimmed text.
 */
function stripOuterNewlines(text) {
  return text.replace(/^\n+/, '').replace(/\n+$/, '');
}

/**
 * Decode one `custom_tool_call_output` payload (the `exec` tool).
 *
 * The payload is an array of content parts: a `Script completed|running|failed`
 * status header, one or more JSON envelopes, optional images and (for scripts
 * that call several nested tools) plain text. Intermediate `Script running`
 * headers are ignored when a completed output exists.
 * @param payload - response_item payload.
 * @returns decoded output, error flag and partial flag.
 */
function decodeCustomOutput(payload) {
  const raw = payload.output;
  const elements = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? [{ type: 'input_text', text: raw }]
      : raw !== null && typeof raw === 'object'
        ? [raw]
        : [];

  const texts = [];
  const running = [];
  let images = 0;
  let sawCompleted = false;
  let sawFailed = false;

  for (const element of elements) {
    if (element === null || element === undefined) continue;
    if (typeof element === 'string') {
      if (element !== '') texts.push(element);
      continue;
    }
    if (typeof element !== 'object') continue;
    if (element.type === 'input_image') {
      images += 1;
      continue;
    }
    let text = typeof element.text === 'string' ? element.text : '';
    if (text === '') continue;

    const head = text.trimStart();
    const outputMarker = 'Output:\n';
    const afterHeader = () => {
      const index = head.indexOf(outputMarker);
      return index < 0 ? '' : stripOuterNewlines(head.slice(index + outputMarker.length));
    };
    if (head.startsWith('Script running')) {
      running.push(head.split('\n')[0]);
      continue;
    }
    if (head.startsWith('Script failed')) {
      sawFailed = true;
      const body = afterHeader();
      if (body === '') continue;
      text = body;
    } else if (head.startsWith('Script error:')) {
      sawFailed = true;
      const body = stripOuterNewlines(head.slice('Script error:'.length));
      if (body === '') continue;
      text = body;
    } else if (head.startsWith('Script completed')) {
      sawCompleted = true;
      const body = afterHeader();
      if (body === '') continue;
      text = body;
    }
    if (head.startsWith('Warning: truncated output')) {
      text = head.replace(/^Warning: truncated output[^\n]*\n(?:Total output lines: \d+\n)?\n?/u, '');
      if (text === '') continue;
    }

    const trimmed = text.trim();
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed !== '') {
      const parsed = parseJsonLine(trimmed);
      if (parsed !== null && isEnvelope(parsed)) {
        const unwrapped = unwrapEnvelope(parsed);
        for (const item of unwrapped.items) texts.push(item);
        if (typeof unwrapped.exitCode === 'number' && unwrapped.exitCode !== 0) sawFailed = true;
        continue;
      }
    }
    texts.push(text);
  }

  let output = stripOuterNewlines(texts.join('\n'));
  if (output === '' && images > 0) output = '[图片]';
  const partial = !sawCompleted && !sawFailed && output === '' && running.length > 0;
  if (partial) output = running.join('\n');
  return { output, isError: sawFailed, partial };
}

/**
 * Decode one `function_call_output` payload (MCP / collaboration tools).
 * @param payload - response_item payload.
 * @returns decoded output and error flag.
 */
function decodeFunctionOutput(payload) {
  const raw = payload.output;
  if (typeof raw === 'string') {
    return { output: raw, isError: /^failed to parse function/iu.test(raw.trimStart()) };
  }
  if (Array.isArray(raw)) {
    const parts = [];
    let images = 0;
    for (const element of raw) {
      if (element === null || element === undefined) continue;
      if (typeof element === 'string') {
        parts.push(element);
        continue;
      }
      if (typeof element !== 'object') continue;
      if (element.type === 'input_image') {
        images += 1;
        continue;
      }
      if (typeof element.text === 'string' && element.text !== '') parts.push(element.text);
    }
    let output = stripOuterNewlines(parts.join('\n').replace(/^Wall time: [\d.]+ seconds\nOutput:\n?/u, ''));
    if (output === '' && images > 0) output = '[图片]';
    return { output, isError: false };
  }
  if (raw !== null && typeof raw === 'object') return { output: jsonText(raw), isError: false };
  return { output: '', isError: false };
}

/* ------------------------------------------------------------------ */
/* Head scan (list + title)                                            */
/* ------------------------------------------------------------------ */

/**
 * Read only the head of a rollout: session_meta and the first human message.
 * Stops as soon as a real user message is found or the head budget is spent.
 * @param file - absolute rollout path.
 * @returns `{ meta, firstUserText, lines }`.
 */
async function scanHead(file) {
  const info = { meta: null, firstUserText: '', lines: 0 };
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let chars = 0;
  try {
    for await (const line of rl) {
      info.lines += 1;
      chars += line.length + 1;
      if (line.trim() !== '') {
        const record = parseJsonLine(line);
        if (record !== null) {
          const payload = record.payload ?? {};
          if (record.type === 'session_meta') {
            if (info.meta === null) info.meta = payload;
          } else if (record.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
            const { text } = normalizeUserParts(payload.content);
            if (text !== '') {
              info.firstUserText = text;
              break;
            }
          }
        }
      }
      if (info.lines >= HEAD_MAX_LINES || chars >= HEAD_MAX_CHARS) break;
    }
  } catch {
    // A partially written rollout still yields whatever was read.
  } finally {
    try {
      rl.close();
    } catch {
      // ignore
    }
    try {
      stream.destroy();
    } catch {
      // ignore
    }
  }
  return info;
}

/**
 * Title for a subagent rollout, from its `agent_path`.
 * @param meta - session_meta payload.
 * @returns title candidate.
 */
function agentTitle(meta) {
  if (meta === null || typeof meta !== 'object') return '';
  const agentPath = typeof meta.agent_path === 'string' ? meta.agent_path.replace(/^\/root\/?/u, '') : '';
  const nickname = typeof meta.agent_nickname === 'string' ? meta.agent_nickname : '';
  const base = agentPath !== '' ? agentPath : nickname;
  if (base === '') return '';
  return `子代理 ${base}`;
}

/**
 * Build the display title from the head facts.
 * @param meta - session_meta payload.
 * @param firstUserText - first real user message.
 * @param conversationId - stable conversation id.
 * @returns display title.
 */
function titleOf(meta, firstUserText, conversationId) {
  const fallback = `Codex 会话 ${conversationId.slice(0, 8)}`;
  if (meta !== null && typeof meta === 'object' && typeof meta.agent_path === 'string' && meta.agent_path !== '') {
    return cleanTitle(agentTitle(meta), fallback);
  }
  const fromUser = titleFromUserText(firstUserText);
  return cleanTitle(fromUser, fallback);
}

/**
 * Normalize a cwd value to an absolute path (or null).
 * @param value - raw cwd.
 * @returns absolute path or null.
 */
function normalizeCwd(value) {
  if (typeof value !== 'string' || value === '') return null;
  const withoutFile = value.startsWith('file://') ? decodeURIComponent(value.slice('file://'.length)) : value;
  if (!withoutFile.startsWith('/')) return null;
  return path.normalize(withoutFile);
}

/* ------------------------------------------------------------------ */
/* status / list                                                       */
/* ------------------------------------------------------------------ */

/**
 * Report whether local Codex session data is readable.
 * @returns availability facts.
 */
export async function status() {
  let stat;
  try {
    stat = fs.statSync(SESSIONS_DIR);
  } catch {
    return { available: false, location: LOCATION, error: `找不到 Codex 会话目录 ${LOCATION}` };
  }
  if (!stat.isDirectory()) {
    return { available: false, location: LOCATION, error: `${LOCATION} 不是目录` };
  }
  const files = walkRollouts(SESSIONS_DIR);
  if (files.length === 0) {
    return { available: false, location: LOCATION, error: `${LOCATION} 下没有 rollout-*.jsonl 会话文件` };
  }
  try {
    fs.accessSync(files[0], fs.constants.R_OK);
  } catch {
    return { available: false, location: LOCATION, error: `会话文件不可读：${displayPath(files[0])}` };
  }
  return { available: true, location: LOCATION, error: null };
}

/**
 * List Codex rollouts, newest first.
 *
 * Only the file head is read (session_meta + first human message), so this
 * stays fast on a multi-gigabyte sessions directory. `messageCount` is null
 * because counting it would require a full scan of every rollout.
 * @returns conversation summaries.
 */
export async function list() {
  const entries = indexSessions();
  const rows = [];
  for (const entry of entries) {
    let stat;
    try {
      stat = fs.statSync(entry.file);
    } catch {
      continue;
    }
    const head = await scanHead(entry.file);
    const meta = head.meta ?? {};
    const cwd = normalizeCwd(meta.cwd);
    const metaTime = toMillis(meta.timestamp, 0);
    const createdAt = metaTime > 0 ? metaTime : entry.createdAt > 0 ? entry.createdAt : Math.trunc(stat.mtimeMs || 0);
    const updatedAt = Math.max(Math.trunc(stat.mtimeMs || 0), createdAt);
    rows.push({
      id: entry.id,
      title: titleOf(head.meta, head.firstUserText, entry.id),
      cwd,
      cwdLabel: cwdLabel(cwd) === '' ? '未知项目' : cwdLabel(cwd),
      createdAt,
      updatedAt,
      messageCount: null,
      isArchived: false,
    });
  }
  rows.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
  return rows;
}

/* ------------------------------------------------------------------ */
/* load                                                                */
/* ------------------------------------------------------------------ */

/**
 * Create the mutable normalization state for one conversation.
 * @param conversationId - stable id.
 * @returns builder with `handle`, `finish` and counters attached.
 */
function createBuilder(conversationId, options = {}) {
  const turns = [];
  const seenIds = new Set();
  const buckets = new Map();
  const callRecords = [];
  let currentTurn = null;
  let currentRun = null;
  let pendingReasoning = [];
  let meta = null;
  let firstUserText = '';
  let firstTs = 0;
  let lastTs = 0;
  let userCount = 0;
  let assistantCount = 0;
  let reasoningCount = 0;
  let toolCallCount = 0;
  let resultCount = 0;
  let badLines = 0;
  let lineCount = 0;
  let orphanCount = 0;
  let budgetHit = false;

  /** Ensure a turn exists for the next run (user stays null when synthetic). */
  const ensureTurn = (at) => {
    if (currentTurn === null) {
      currentTurn = { at, user: null, runs: [] };
      turns.push(currentTurn);
    }
    return currentTurn;
  };

  /** Ensure a run exists for the next block. */
  const ensureRun = (at) => {
    ensureTurn(at);
    if (currentRun === null) {
      currentRun = { at, blocks: [], toolResults: [] };
      currentTurn.runs.push(currentRun);
    }
    return currentRun;
  };

  /**
   * Append reasoning blocks, collapsing consecutive duplicates.
   *
   * Codex often emits several reasoning items whose visible `summary` heading
   * is unchanged (the full thought is encrypted). Keeping every copy would
   * repeat the same heading many times in one run, so only consecutive
   * duplicates are merged.
   */
  const pushReasoning = (run, blocks) => {
    for (const block of blocks) {
      const last = run.blocks.length > 0 ? run.blocks[run.blocks.length - 1] : null;
      if (last !== null && last.type === 'reasoning' && last.text === block.text) continue;
      run.blocks.push(block);
      reasoningCount += 1;
    }
  };

  /** Flush buffered reasoning into the current (or a fresh) run. */
  const flushReasoning = (at) => {
    if (pendingReasoning.length === 0) return;
    const run = ensureRun(at);
    pushReasoning(run, pendingReasoning);
    pendingReasoning = [];
  };

  /** Register a tool call: unique block id + pairing bucket. */
  const registerCall = (sourceCallId, name, args, at, run) => {
    const source = typeof sourceCallId === 'string' && sourceCallId !== '' ? sourceCallId : `call_missing_${callRecords.length + 1}`;
    const base = source.replace(/[^\w.:-]/g, '_') || `call_${callRecords.length + 1}`;
    let blockId = base;
    let suffix = 1;
    while (seenIds.has(blockId)) {
      suffix += 1;
      blockId = `${base}~${suffix}`;
    }
    seenIds.add(blockId);
    run.blocks.push({ type: 'tool-call', id: blockId, name, arguments: args });
    const record = { source, blockId, name, args, run, result: null, partial: '', at };
    const bucket = buckets.get(source);
    if (bucket === undefined) buckets.set(source, [record]);
    else bucket.push(record);
    callRecords.push(record);
    toolCallCount += 1;
    return record;
  };

  /** Attach (or merge) a decoded output on its call record. */
  const attachOutput = (record, decoded, at) => {
    if (decoded.output === '' && decoded.partial === false && record.result === null) {
      // A recorded but empty result (e.g. send_message returns "") is still a
      // real result; keep it instead of inventing a placeholder.
      record.result = { callId: record.blockId, name: record.name, arguments: record.args, output: '', isError: decoded.isError, at };
      record.run.toolResults.push(record.result);
      resultCount += 1;
      return;
    }
    if (decoded.partial) {
      if (record.result === null && decoded.output !== '') record.partial = decoded.output;
      return;
    }
    if (record.result === null) {
      record.result = {
        callId: record.blockId,
        name: record.name,
        arguments: record.args,
        output: decoded.output,
        isError: decoded.isError,
        at,
      };
      record.run.toolResults.push(record.result);
      resultCount += 1;
      return;
    }
    if (decoded.output !== '' && !record.result.output.includes(decoded.output)) {
      record.result.output = record.result.output === '' ? decoded.output : `${record.result.output}\n${decoded.output}`;
    }
    record.result.isError = record.result.isError || decoded.isError;
  };

  /** Handle one `response_item` payload. */
  const handleItem = (payload, at) => {
    const type = payload.type;
    if (type === 'message') {
      if (payload.role === 'user') {
        const { text } = normalizeUserParts(payload.content);
        if (text === '') return;
        flushReasoning(at);
        currentTurn = { at, user: { content: [{ type: 'text', text }] }, runs: [] };
        turns.push(currentTurn);
        currentRun = null;
        userCount += 1;
        if (firstUserText === '') firstUserText = text;
        return;
      }
      if (payload.role === 'assistant') {
        const text = assistantText(payload.content);
        if (text === '') return;
        const run = { at, blocks: [], toolResults: [] };
        pushReasoning(run, pendingReasoning);
        pendingReasoning = [];
        run.blocks.push({ type: 'text', text });
        ensureTurn(at).runs.push(run);
        currentRun = run;
        assistantCount += 1;
      }
      // developer / system messages are environment boilerplate: dropped.
      return;
    }

    if (type === 'reasoning') {
      const parts = [];
      if (Array.isArray(payload.summary)) {
        for (const item of payload.summary) {
          const text = typeof item === 'string' ? item : item !== null && typeof item === 'object' ? item.text : '';
          if (typeof text === 'string' && text.trim() !== '') parts.push(text.trim());
        }
      }
      if (Array.isArray(payload.content)) {
        for (const item of payload.content) {
          const text = item !== null && typeof item === 'object' ? item.text : '';
          if (typeof text === 'string' && text.trim() !== '') parts.push(text.trim());
        }
      }
      if (parts.length === 0) {
        // The rollout summary is empty: the raw chain is not stored as plaintext, but
        // the local thread-history DB may still carry the visible summary.
        const backfill = options.sqliteReasoning instanceof Map ? options.sqliteReasoning.get(payload.id) : undefined;
        if (typeof backfill !== 'string' || backfill === '') return;
        parts.push(backfill);
      }
      pendingReasoning.push({ type: 'reasoning', text: clamp(parts.join('\n\n'), REASONING_MAX_CHARS) });
      return;
    }

    if (type === 'function_call' || type === 'custom_tool_call') {
      const isCustom = type === 'custom_tool_call';
      const name = typeof payload.name === 'string' && payload.name !== '' ? payload.name : isCustom ? 'exec' : 'function';
      let args;
      if (isCustom) args = typeof payload.input === 'string' ? payload.input : jsonText(payload.input);
      else if (typeof payload.arguments === 'string') args = payload.arguments;
      else args = jsonText(payload.arguments);
      flushReasoning(at);
      registerCall(payload.call_id, name, args, at, ensureRun(at));
      return;
    }

    if (type === 'function_call_output') {
      const decoded = decodeFunctionOutput(payload);
      deliver(payload.call_id, decoded, at, 'unknown');
      return;
    }

    if (type === 'custom_tool_call_output') {
      const decoded = decodeCustomOutput(payload);
      deliver(payload.call_id, decoded, at, 'exec');
      return;
    }

    // Older/other runtimes: tolerate `<something>_call` / `<something>_output`.
    if (typeof type === 'string' && type.endsWith('_call') && typeof payload.call_id === 'string') {
      const name = typeof payload.name === 'string' && payload.name !== '' ? payload.name : type.replace(/_call$/u, '');
      const args = jsonText(payload.action ?? payload.arguments ?? payload.input ?? payload);
      flushReasoning(at);
      registerCall(payload.call_id, name, args, at, ensureRun(at));
      return;
    }
    if (typeof type === 'string' && type.endsWith('_output') && typeof payload.call_id === 'string') {
      const output = typeof payload.output === 'string' ? payload.output : jsonText(payload.output ?? payload);
      deliver(payload.call_id, { output, isError: false, partial: false }, at, 'unknown');
    }
  };

  /** Route one decoded output to its call (or synthesize a missing call). */
  const deliver = (sourceCallId, decoded, at, fallbackName) => {
    const bucket = typeof sourceCallId === 'string' ? buckets.get(sourceCallId) : undefined;
    let record = undefined;
    if (bucket !== undefined) {
      record = bucket.find((candidate) => candidate.result === null);
      if (record === undefined) record = bucket[bucket.length - 1];
    }
    if (record === undefined) {
      flushReasoning(at);
      orphanCount += 1;
      const name = fallbackName;
      record = registerCall(sourceCallId, name, '', at, ensureRun(at));
    }
    attachOutput(record, decoded, at);
  };

  /**
   * Feed one parsed JSONL record.
   * @param record - parsed line.
   */
  const handle = (record) => {
    lineCount += 1;
    const at = toMillis(record.timestamp, lastTs);
    if (at > 0) {
      if (firstTs === 0) firstTs = at;
      lastTs = Math.max(lastTs, at);
    }
    if (record.type === 'session_meta') {
      if (meta === null) meta = record.payload ?? {};
      return;
    }
    if (record.type !== 'response_item') return;
    const payload = record.payload;
    if (payload === null || typeof payload !== 'object') return;
    try {
      handleItem(payload, at);
    } catch {
      badLines += 1;
    }
  };

  /**
   * Finalize turns, placeholder results and clamping.
   * @returns the normalized conversation.
   */
  const finish = () => {
    if (pendingReasoning.length > 0) {
      const at = lastTs || firstTs;
      const run = ensureRun(at);
      pushReasoning(run, pendingReasoning);
      pendingReasoning = [];
    }

    for (const record of callRecords) {
      if (record.result !== null) continue;
      const output = record.partial !== '' ? record.partial : '[结果未记录]';
      record.result = {
        callId: record.blockId,
        name: record.name,
        arguments: record.args,
        output,
        isError: record.partial === '',
        at: record.at,
      };
      record.run.toolResults.push(record.result);
      resultCount += 1;
    }

    for (const turn of turns) {
      for (const run of turn.runs) {
        const order = new Map();
        for (let index = 0; index < run.blocks.length; index += 1) {
          const block = run.blocks[index];
          if (block.type === 'tool-call') order.set(block.id, index);
        }
        run.toolResults.sort((left, right) => (order.get(left.callId) ?? 0) - (order.get(right.callId) ?? 0));
        for (const result of run.toolResults) result.output = clamp(result.output, TOOL_RESULT_MAX_CHARS);
      }
    }

    const cwd = normalizeCwd(meta?.cwd);
    const createdAt = toMillis(meta?.timestamp, 0) || firstTs || 0;
    const updatedAt = Math.max(lastTs || 0, createdAt);
    const conversation = {
      source: id,
      id: conversationId,
      title: titleOf(meta, firstUserText, conversationId),
      createdAt,
      updatedAt,
      cwd,
      messageCount: userCount + assistantCount,
      turns,
    };
    return {
      conversation,
      stats: {
        lines: lineCount,
        badLines,
        turns: turns.length,
        userMessages: userCount,
        assistantMessages: assistantCount,
        reasoningBlocks: reasoningCount,
        toolCalls: toolCallCount,
        toolResults: resultCount,
        orphanCalls: orphanCount,
        budgetHit,
      },
    };
  };

  return {
    handle,
    finish,
    markBudgetHit: () => {
      budgetHit = true;
    },
  };
}

/**
 * Load and normalize one Codex rollout.
 * @param conversationId - id returned by `list()` (last uuid of the filename).
 * @returns normalized conversation.
 */
export async function load(conversationId) {
  const key = typeof conversationId === 'string' ? conversationId : '';
  const entry = indexSessions().find((candidate) => candidate.id === key);
  if (entry === undefined) throw new Error(`未找到 Codex 会话：${key}`);
  // The SQLite history keys threads by the rollout's own thread id (the last
  // uuid of the filename, i.e. `entry.id`), which for paginated continuations
  // differs from the base thread in `session_meta.session_id`.
  const sqliteReasoning = await sqliteReasoningSummaries(key);
  const builder = createBuilder(key, { sqliteReasoning });
  const startedAt = Date.now();
  const stream = fs.createReadStream(entry.file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let readError = null;
  try {
    let seen = 0;
    for await (const line of rl) {
      seen += 1;
      if (line.trim() !== '') {
        const record = parseJsonLine(line);
        if (record !== null) builder.handle(record);
      }
      if ((seen & 255) === 0 && Date.now() - startedAt > LOAD_BUDGET_MS) {
        builder.markBudgetHit();
        break;
      }
    }
  } catch (error) {
    // A truncated last line or a disappearing file still yields the prefix.
    readError = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      rl.close();
    } catch {
      // ignore
    }
    try {
      stream.destroy();
    } catch {
      // ignore
    }
  }
  const { conversation } = builder.finish();
  if (readError !== null && conversation.turns.length === 0) {
    throw new Error(`读取 Codex 会话失败：${key}（${readError}）`);
  }
  return conversation;
}
