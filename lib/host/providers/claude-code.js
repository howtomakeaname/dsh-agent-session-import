/**
 * Anthropic Claude Code CLI provider (read-only, self-contained).
 *
 * Claude Code writes one append-only JSONL transcript per session:
 *
 *   ~/.claude/projects/<project-encoded-cwd>/<sessionId>.jsonl
 *   ~/.claude/projects/<project-encoded-cwd>/<sessionId>/subagents/agent-<id>.jsonl
 *
 * Every line is one JSON object. Message rows (`type: "user"` / `"assistant"`)
 * carry a `uuid` and a `parentUuid`; the file is therefore a collection of
 * trees. Metadata rows (`ai-title`, `last-prompt`, `mode`, `cost-state`, ...)
 * are not part of the tree. Assistant output is split across rows that share
 * `message.id`; the rows are ordered by `apiBlockIndex`.
 *
 * Reconstruction policy (details in ../claude-code.md):
 *  - one transcript can contain several roots (compaction / resume re-roots
 *    the tree). Each root gets its leaf-to-root main chain; chains are joined
 *    in file order. This is still linear and never follows a branch.
 *  - inside one chain, `isSidechain` rows are skipped. A file where every
 *    message is a sidechain is a subagent transcript and is imported in
 *    tree order (there is no main/sidechain distinction inside it).
 *  - assistant rows with the same `message.id` are one model message. Tool
 *    results are paired by `tool_use.id` <-> `tool_result.tool_use_id`, even
 *    when the transcript interleaved them between the split assistant rows.
 *  - every call gets a conversation-unique id, a placeholder result when the
 *    source lost it, and every result without a call gets a synthetic call.
 *
 * Only `node:` builtins are imported so the file can be dropped into
 * `session-import/lib/host/providers/claude-code.js` unchanged.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

/** Stable provider id (lowercase). */
export const id = 'claude-code';
/** Display label for the source picker. */
export const label = 'Claude Code';
/** One-line description for the source picker. */
export const description = 'Anthropic Claude Code CLI 会话';

/** Maximum characters kept from one tool result. */
const TOOL_RESULT_MAX_CHARS = 20_000;
/** Maximum characters kept from one reasoning block. */
const REASONING_MAX_CHARS = 12_000;
/** Maximum characters kept in a display title. */
const TITLE_MAX_CHARS = 160;
/** Wall-clock budget for one `load()` call. */
const LOAD_BUDGET_MS = 240_000;

/** Files up to this size are fully scanned by `list()` (message count is exact). */
const LIST_FULL_SCAN_MAX_BYTES = 2 * 1024 * 1024;
/** Head/tail window used by `list()` for larger files. */
const LIST_CHUNK_BYTES = 1024 * 1024;
/** Marker label, kept in sync with providers/shared.js. */
const TRUNCATION_LABEL = 'Claude Code importer';

const HOME = os.homedir();
const CLAUDE_HOME = (() => {
  const raw = process.env.CLAUDE_CONFIG_DIR;
  if (typeof raw === 'string' && raw.trim() !== '' && path.isAbsolute(raw)) return raw;
  return path.join(HOME, '.claude');
})();
const PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects');
/** User-facing location shown in the UI. */
const LOCATION = displayPath(PROJECTS_DIR);

/** User text that is CLI boilerplate rather than a human prompt. */
const SYNTHETIC_USER_PREFIX =
  /^<(?:task-notification|local-command|system-reminder|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook|task-reminder)\b/u;

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
  const parts = cwd.split(/[\\/]/u).filter((part) => part !== '');
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
 * Test whether a value is a plain object.
 * @param value - candidate.
 * @returns true for `{...}`.
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Serialize a tool input to the `arguments` string stored in the model.
 * @param value - parsed `tool_use.input`.
 * @returns JSON text (never empty).
 */
function serializeArguments(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '{}';
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' && text !== '' ? text : '{}';
  } catch {
    return '{}';
  }
}

/* ------------------------------------------------------------------ */
/* Text extraction                                                     */
/* ------------------------------------------------------------------ */

/**
 * Flatten a tool-result `content` value into plain text.
 *
 * Image parts are represented by `[image]`; their base64 payload is never
 * copied into the conversation.
 * @param value - string, array of blocks, or block object.
 * @returns plain text.
 */
function contentToText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = [];
    for (const item of value) {
      if (typeof item === 'string') {
        parts.push(item);
        continue;
      }
      if (!isRecord(item)) continue;
      if (item.type === 'image') parts.push('[image]');
      else if (item.type === 'document') parts.push('[document]');
      else if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
      else if (typeof item.text === 'string') parts.push(item.text);
      else if (item.type === 'thinking' && typeof item.thinking === 'string') parts.push(item.thinking);
      else if (typeof item.type === 'string') parts.push(`[${item.type}]`);
    }
    return parts.join('\n');
  }
  if (isRecord(value)) {
    if (value.type === 'image') return '[image]';
    if (value.type === 'document') return '[document]';
    if (typeof value.text === 'string') return value.text;
    if (value.content !== undefined) return contentToText(value.content);
    if (typeof value.stdout === 'string' || typeof value.stderr === 'string') {
      return [value.stdout, value.stderr].filter((part) => typeof part === 'string' && part !== '').join('\n');
    }
  }
  return '';
}

/**
 * Structured fallback used when a `tool_result` block has no inline content.
 *
 * Bash results carry `{stdout, stderr, interrupted}`; Read/Edit results carry
 * file metadata. JSON fallback is bounded by the caller's clamp.
 * @param value - top-level `toolUseResult`.
 * @returns plain text.
 */
function toolUseResultText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return contentToText(value);
  if (!isRecord(value)) return '';
  if (value.type === 'image' || value.file !== undefined) return '[image]';
  if (value.type === 'text' && typeof value.text === 'string') return value.text;
  if (value.content !== undefined) return contentToText(value.content);
  if (typeof value.stdout === 'string' || typeof value.stderr === 'string') {
    const text = [value.stdout, value.stderr]
      .filter((part) => typeof part === 'string' && part !== '')
      .join('\n');
    return value.interrupted === true ? `[interrupted]\n${text}` : text;
  }
  try {
    const text = JSON.stringify(value);
    return text === '{}' ? '' : text;
  } catch {
    return '';
  }
}

/**
 * Convert one raw user text into a prompt, dropping CLI-generated wrappers.
 * @param row - source user row.
 * @param raw - string or joined text blocks.
 * @returns prompt text, or null when the row is not a human prompt.
 */
function promptTextOf(row, raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text === '') return null;
  if (row.isMeta === true || row.isCompactSummary === true || row.isVisibleInTranscriptOnly === true) return null;
  if (/^<command-(?:message|name)>/u.test(text)) {
    const name = /<command-name>([\s\S]*?)<\/command-name>/u.exec(text)?.[1]?.trim() ?? '';
    const args = /<command-args>([\s\S]*?)<\/command-args>/u.exec(text)?.[1]?.trim() ?? '';
    if (name === '') return null;
    return args === '' ? name : `${name} ${args}`;
  }
  if (SYNTHETIC_USER_PREFIX.test(text)) return null;
  if (text.startsWith('[Request interrupted by user')) return null;
  if (text.startsWith('Caveat: The messages below were generated')) return null;
  return text;
}

/**
 * Display-oriented title from a first prompt (first two lines, collapsed).
 * @param text - prompt text.
 * @returns title candidate.
 */
function titleFromPrompt(text) {
  if (typeof text !== 'string') return '';
  return text.replaceAll(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ */
/* Directory / file discovery                                          */
/* ------------------------------------------------------------------ */

/**
 * Recursively collect `*.jsonl` transcripts under the projects directory.
 *
 * Claude Code keeps subagent transcripts under
 * `<project>/<sessionId>/subagents/agent-*.jsonl`; those are included as
 * importable conversations (the module treats an all-sidechain file as a
 * subagent transcript). The first directory below `projects/` is the encoded
 * project cwd.
 * @param root - absolute projects directory.
 * @returns `{file, id, projectDir}` entries.
 */
function walkTranscripts(root) {
  const out = [];
  const stack = [{ dir: root, depth: 0, projectDir: null }];
  const visited = new Set();
  while (stack.length > 0) {
    const { dir, depth, projectDir } = stack.pop();
    if (visited.has(dir) || depth > 6) continue;
    visited.add(dir);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push({
          dir: full,
          depth: depth + 1,
          projectDir: projectDir ?? (depth === 0 ? full : null),
        });
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const base = entry.name.slice(0, -'.jsonl'.length);
      if (base === '') continue;
      out.push({ file: full, id: base, projectDir: projectDir ?? path.dirname(full) });
    }
  }
  out.sort((left, right) => left.file.localeCompare(right.file));
  return out;
}

/**
 * Build the id -> transcript index, keeping the newest file for duplicate ids.
 * @returns index entries with `file`, `id`, `projectDir`, `size`, `mtimeMs`.
 */
function sessionIndex() {
  const byId = new Map();
  for (const entry of walkTranscripts(PROJECTS_DIR)) {
    let stat;
    try {
      stat = fs.statSync(entry.file);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size === 0) continue;
    const row = {
      file: entry.file,
      id: entry.id,
      projectDir: entry.projectDir,
      size: stat.size,
      mtimeMs: Math.trunc(stat.mtimeMs || 0),
      birthtimeMs: Math.trunc(stat.birthtimeMs || 0),
    };
    const previous = byId.get(row.id);
    if (previous === undefined || previous.mtimeMs < row.mtimeMs) byId.set(row.id, row);
  }
  return [...byId.values()];
}

/**
 * Decode the project directory name (`/` is written as `-`) as a cwd fallback.
 *
 * The encoding is lossy for real hyphens, so this is only used when no JSONL
 * row carries a `cwd`.
 * @param projectDir - absolute `<projects>/<encoded-name>` path.
 * @returns decoded absolute path or null.
 */
function decodeProjectDir(projectDir) {
  if (typeof projectDir !== 'string') return null;
  const base = path.basename(projectDir);
  if (!base.startsWith('-')) return null;
  return `/${base.slice(1).split('-').join('/')}`;
}

/* ------------------------------------------------------------------ */
/* list() fast scan                                                    */
/* ------------------------------------------------------------------ */

/**
 * Fresh accumulator for one list scan.
 * @param countMessages - whether to count messages (full-file scans only).
 * @returns mutable state.
 */
function newScanState(countMessages) {
  return {
    countMessages,
    sawJson: false,
    sawMessage: false,
    firstTs: 0,
    lastTs: 0,
    cwd: null,
    lastTitle: '',
    firstPrompt: '',
    promptCount: 0,
    messageIds: new Set(),
  };
}

/**
 * Consume a chunk of complete JSONL lines into a scan state.
 * @param text - decoded chunk.
 * @param state - accumulator.
 */
function scanLines(text, state) {
  for (const rawLine of text.split('\n')) {
    if (rawLine === '') continue;
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === '') continue;
    const row = parseJsonLine(line);
    if (row === null) continue;
    state.sawJson = true;

    const at = toMillis(row.timestamp);
    if (at > 0) {
      if (state.firstTs === 0 || at < state.firstTs) state.firstTs = at;
      if (at > state.lastTs) state.lastTs = at;
    }

    if (typeof row.cwd === 'string' && row.cwd !== '' && state.cwd === null) state.cwd = row.cwd;

    if (row.type === 'ai-title') {
      const title = typeof row.aiTitle === 'string' ? row.aiTitle.trim() : '';
      if (title !== '') state.lastTitle = title;
      continue;
    }

    if (row.type === 'assistant') {
      state.sawMessage = true;
      if (state.countMessages && typeof row.message?.id === 'string' && row.message.id !== '') {
        state.messageIds.add(row.message.id);
      }
      continue;
    }

    if (row.type !== 'user') continue;
    state.sawMessage = true;
    let prompt = null;
    const content = row.message?.content;
    if (typeof content === 'string') {
      prompt = promptTextOf(row, content);
    } else if (Array.isArray(content)) {
      const parts = [];
      for (const block of content) {
        if (!isRecord(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
        else if (block.type === 'image') parts.push('[image]');
      }
      if (parts.length > 0) prompt = promptTextOf(row, parts.join('\n'));
    }
    if (prompt !== null) {
      if (state.firstPrompt === '') state.firstPrompt = prompt;
      if (state.countMessages) state.promptCount += 1;
    }
  }
}

/**
 * Read a byte range from a file.
 * @param file - absolute path.
 * @param start - byte offset.
 * @param length - maximum bytes.
 * @returns buffer (possibly shorter at EOF).
 */
async function readRange(file, start, length) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Read the first complete lines of a file.
 * @param file - absolute path.
 * @param size - file size.
 * @returns decoded text of complete lines.
 */
async function readHead(file, size) {
  const buffer = await readRange(file, 0, Math.min(size, LIST_CHUNK_BYTES));
  let text = buffer.toString('utf8');
  if (size > LIST_CHUNK_BYTES) {
    const newline = text.lastIndexOf('\n');
    text = newline >= 0 ? text.slice(0, newline + 1) : '';
  }
  return text;
}

/**
 * Read the last complete lines of a file.
 * @param file - absolute path.
 * @param size - file size.
 * @returns decoded text of complete lines.
 */
async function readTail(file, size) {
  const start = Math.max(0, size - LIST_CHUNK_BYTES);
  const buffer = await readRange(file, start, size - start);
  let text = buffer.toString('utf8');
  if (start > 0) {
    const newline = text.indexOf('\n');
    text = newline >= 0 ? text.slice(newline + 1) : '';
  }
  return text;
}

/**
 * Summarize one transcript for the source picker.
 *
 * Files up to 2 MiB are fully scanned (exact messageCount); larger files only
 * read a 1 MiB head and tail, so messageCount is null there.
 * @param entry - index entry.
 * @returns summary or null when the file has no JSONL rows.
 */
async function summarize(entry) {
  const state = newScanState(entry.size <= LIST_FULL_SCAN_MAX_BYTES);
  let full = false;
  if (entry.size <= LIST_FULL_SCAN_MAX_BYTES) {
    const text = await fs.promises.readFile(entry.file, 'utf8');
    scanLines(text, state);
    full = true;
  } else {
    scanLines(await readHead(entry.file, entry.size), state);
    scanLines(await readTail(entry.file, entry.size), state);
  }
  if (!state.sawJson || (!state.sawMessage && state.messageIds.size === 0)) return null;

  const cwd = state.cwd ?? decodeProjectDir(entry.projectDir);
  const createdAt = state.firstTs > 0 ? state.firstTs : Math.max(entry.birthtimeMs, entry.mtimeMs);
  const updatedAt = Math.max(entry.mtimeMs, state.lastTs, createdAt);
  const firstPrompt = titleFromPrompt(state.firstPrompt);
  const fallback = `Claude Code 会话 ${entry.id.slice(0, 8)}`;
  const title = cleanTitle(state.lastTitle !== '' ? state.lastTitle : firstPrompt, fallback);
  const messageCount = full && state.countMessages ? state.promptCount + state.messageIds.size : null;

  return {
    id: entry.id,
    title,
    cwd: cwd !== null && cwd !== '' ? cwd : null,
    cwdLabel: cwdLabel(cwd) === '' ? '未知项目' : cwdLabel(cwd),
    createdAt: createdAt > 0 ? createdAt : 0,
    updatedAt,
    messageCount,
    isArchived: false,
  };
}

/* ------------------------------------------------------------------ */
/* load(): streaming normalization                                     */
/* ------------------------------------------------------------------ */

/**
 * Parse one `tool_result` block into a neutral result record.
 * @param block - `tool_result` content block.
 * @param row - owning transcript row (for `toolUseResult`).
 * @param at - row timestamp in ms.
 * @returns result record or null when the call id is missing.
 */
function makeToolResult(block, row, at) {
  const callId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
  if (callId === '') return null;
  let output = contentToText(block.content);
  if (output === '') output = toolUseResultText(row.toolUseResult);
  output = clamp(output, TOOL_RESULT_MAX_CHARS);
  const isError = block.is_error === true || output.startsWith('<tool_use_error>');
  return { callId, output, isError, at };
}

/**
 * Build a normalized transcript node for one row.
 * @param row - parsed JSONL row.
 * @param index - line index (dedupe keeps the last occurrence).
 * @returns node with structural fields and normalized content.
 */
function buildNode(row, index) {
  const node = {
    i: index,
    uuid: row.uuid,
    parent: typeof row.parentUuid === 'string' && row.parentUuid !== '' ? row.parentUuid : null,
    sidechain: row.isSidechain === true,
    type: row.type,
    at: toMillis(row.timestamp),
    mid: null,
    api: null,
    prompt: null,
    blocks: [],
    results: [],
  };

  if (row.type === 'assistant') {
    const message = isRecord(row.message) ? row.message : {};
    node.mid = typeof message.id === 'string' && message.id !== '' ? message.id : `row:${row.uuid}`;
    node.api = typeof row.apiBlockIndex === 'number' && Number.isFinite(row.apiBlockIndex)
      ? row.apiBlockIndex
      : null;
    const content = message.content;
    if (typeof content === 'string') {
      if (content.trim() !== '') node.blocks.push({ type: 'text', text: content });
    } else if (Array.isArray(content)) {
      for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
        const block = content[blockIndex];
        if (!isRecord(block)) continue;
        if (block.type === 'text') {
          if (typeof block.text === 'string' && block.text.trim() !== '') {
            node.blocks.push({ type: 'text', text: block.text });
          }
          continue;
        }
        if (block.type === 'thinking') {
          if (typeof block.thinking === 'string' && block.thinking.trim() !== '') {
            node.blocks.push({ type: 'reasoning', text: clamp(block.thinking, REASONING_MAX_CHARS) });
          }
          continue;
        }
        if (block.type === 'tool_use' || block.type === 'server_tool_use') {
          const origId = typeof block.id === 'string' && block.id !== ''
            ? block.id
            : `call-${row.uuid}-${blockIndex}`;
          let input = block.input;
          if (
            isRecord(input)
            && Object.keys(input).length === 0
            && isRecord(row.wireToolInputs?.[origId])
            && Object.keys(row.wireToolInputs[origId]).length > 0
          ) {
            input = row.wireToolInputs[origId];
          }
          node.blocks.push({
            type: 'tool-call',
            origId,
            name: typeof block.name === 'string' && block.name !== '' ? block.name : 'tool',
            arguments: serializeArguments(input),
            at: node.at,
          });
          continue;
        }
        if (block.type === 'tool_result') {
          // A few proxied transcripts put tool results in assistant rows.
          const result = makeToolResult(block, row, node.at);
          if (result !== null) node.results.push(result);
        }
      }
    }
    return node;
  }

  if (row.type === 'user') {
    const content = row.message?.content;
    if (typeof content === 'string') {
      node.prompt = promptTextOf(row, content);
      return node;
    }
    if (Array.isArray(content)) {
      const parts = [];
      let sawImage = false;
      for (const block of content) {
        if (!isRecord(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
        else if (block.type === 'image') sawImage = true;
        else if (block.type === 'tool_result') {
          const result = makeToolResult(block, row, node.at);
          if (result !== null) node.results.push(result);
        }
      }
      let text = parts.join('\n').trim();
      if (text === '' && sawImage) text = '[image]';
      if (text !== '') node.prompt = promptTextOf(row, text);
    }
  }
  return node;
}

/**
 * Find the root of a node's parent chain, memoizing and tolerating cycles.
 * @param node - start node.
 * @param byUuid - deduped node map.
 * @param memo - uuid -> root node.
 * @returns root node.
 */
function findRoot(node, byUuid, memo) {
  const trail = [];
  const seen = new Set();
  let current = node;
  while (current) {
    const known = memo.get(current.uuid);
    if (known !== undefined) {
      for (const item of trail) memo.set(item.uuid, known);
      return known;
    }
    if (seen.has(current.uuid)) {
      for (const item of trail) memo.set(item.uuid, current);
      return current;
    }
    seen.add(current.uuid);
    trail.push(current);
    if (current.parent === null) break;
    const parent = byUuid.get(current.parent);
    if (parent === undefined) break;
    current = parent;
  }
  const root = trail.length > 0 ? trail[trail.length - 1] : node;
  for (const item of trail) memo.set(item.uuid, root);
  return root;
}

/**
 * Allocate a conversation-unique tool-call id.
 * @param raw - source id.
 * @param used - conversation-wide id set.
 * @returns unique id (first use keeps the source spelling).
 */
function uniqueCallId(raw, used) {
  const base = typeof raw === 'string' && raw !== '' ? raw : 'tool-call';
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}~${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

/**
 * Build the run for one assistant `message.id`.
 * @param group - `{mid, rows, firstIndex, at}`.
 * @param usedCallIds - conversation-wide id set.
 * @param createdAt - fallback timestamp.
 * @returns `{run, calls, index, at}`.
 */
function buildRun(group, usedCallIds, createdAt) {
  const rows = [...group.rows].sort((left, right) => {
    const leftApi = left.api === null ? Number.MAX_SAFE_INTEGER : left.api;
    const rightApi = right.api === null ? Number.MAX_SAFE_INTEGER : right.api;
    if (leftApi !== rightApi) return leftApi - rightApi;
    return left.i - right.i;
  });

  let at = 0;
  for (const row of rows) {
    if (row.at > 0 && (at === 0 || row.at < at)) at = row.at;
  }
  if (at === 0) at = group.at > 0 ? group.at : createdAt;
  if (at === 0) at = Date.now();

  const blocks = [];
  const calls = [];
  for (const row of rows) {
    for (const block of row.blocks) {
      if (block.type === 'tool-call') {
        const callId = uniqueCallId(block.origId, usedCallIds);
        blocks.push({
          type: 'tool-call',
          id: callId,
          name: block.name,
          arguments: block.arguments,
        });
        calls.push({
          callId,
          origId: block.origId,
          name: block.name,
          arguments: block.arguments,
          at: block.at > 0 ? block.at : at,
        });
      } else {
        blocks.push({ type: block.type, text: block.text });
      }
    }
  }

  return {
    run: { at, blocks, toolResults: [] },
    calls,
    index: group.firstIndex,
    at,
  };
}

/**
 * Normalize one leaf-to-root chain into prompt/run events.
 * @param segment - `{chain, treeNodes, start}`.
 * @param main - predicate for main-tree rows.
 * @param callMeta - global orig-id -> `{name, arguments}`.
 * @param usedCallIds - conversation-wide id set.
 * @param createdAt - fallback timestamp.
 * @returns events sorted by transcript position.
 */
function buildSegmentEvents(segment, main, callMeta, usedCallIds, createdAt) {
  const selectedMids = new Set();
  for (const node of segment.chain) {
    if (node.type === 'assistant') selectedMids.add(node.mid);
  }

  const groups = new Map();
  for (const node of segment.treeNodes) {
    if (node.type !== 'assistant' || !main(node) || !selectedMids.has(node.mid)) continue;
    if (node.blocks.length === 0) continue;
    const group = groups.get(node.mid);
    if (group === undefined) {
      groups.set(node.mid, {
        mid: node.mid,
        rows: [node],
        firstIndex: node.i,
        at: node.at,
      });
    } else {
      group.rows.push(node);
      if (node.i < group.firstIndex) group.firstIndex = node.i;
      if (node.at > 0 && (group.at === 0 || node.at < group.at)) group.at = node.at;
    }
  }

  const orderedGroups = [...groups.values()].sort((left, right) => left.firstIndex - right.firstIndex);
  const built = orderedGroups.map((group) => buildRun(group, usedCallIds, createdAt));

  const selectedCallIds = new Set();
  for (const item of built) for (const call of item.calls) selectedCallIds.add(call.origId);

  const chainUuids = new Set(segment.chain.map((node) => node.uuid));
  const resultRecords = [];
  for (const node of segment.treeNodes) {
    if ((node.type !== 'user' && node.type !== 'assistant') || !main(node)) continue;
    if (node.results.length === 0) continue;
    const onChain = chainUuids.has(node.uuid);
    if (!onChain && !node.results.some((result) => selectedCallIds.has(result.callId))) continue;
    for (let index = 0; index < node.results.length; index += 1) {
      resultRecords.push({ ...node.results[index], nodeIndex: node.i, ord: index });
    }
  }
  resultRecords.sort((left, right) => left.nodeIndex - right.nodeIndex || left.ord - right.ord);

  const pools = new Map();
  for (const result of resultRecords) {
    const pool = pools.get(result.callId);
    if (pool === undefined) pools.set(result.callId, [result]);
    else pool.push(result);
  }

  const usedResults = new Set();
  const ownerByOrig = new Map();
  for (const item of built) {
    for (const call of item.calls) {
      const pool = pools.get(call.origId);
      let result = null;
      while (pool !== undefined && pool.length > 0) {
        const candidate = pool.shift();
        if (!usedResults.has(candidate)) {
          result = candidate;
          break;
        }
      }
      if (!ownerByOrig.has(call.origId)) ownerByOrig.set(call.origId, item.run);
      if (result === null) {
        item.run.toolResults.push({
          callId: call.callId,
          name: call.name,
          arguments: call.arguments,
          output: '[结果未记录]',
          isError: true,
          at: call.at > 0 ? call.at : item.at,
        });
        continue;
      }
      usedResults.add(result);
      item.run.toolResults.push({
        callId: call.callId,
        name: call.name,
        arguments: call.arguments,
        output: result.output,
        isError: result.isError === true,
        at: result.at > 0 ? result.at : call.at,
      });
    }
  }

  const events = [];
  for (const node of segment.chain) {
    if (node.type !== 'user' || node.prompt === null) continue;
    const at = node.at > 0 ? node.at : createdAt;
    events.push({ kind: 'prompt', index: node.i, at, text: node.prompt });
  }
  for (const item of built) {
    if (item.run.blocks.length === 0) continue;
    events.push({ kind: 'run', index: item.index, at: item.at, run: item.run });
  }

  // Results without a call (or extra duplicate results) still need a matching
  // tool-call block. Re-use the owning run when one exists, otherwise emit a
  // synthetic run at the result's transcript position.
  for (const result of resultRecords) {
    if (usedResults.has(result)) continue;
    const meta = callMeta.get(result.callId) ?? { name: 'unknown', arguments: '{}' };
    const callId = uniqueCallId(result.callId, usedCallIds);
    const block = { type: 'tool-call', id: callId, name: meta.name, arguments: meta.arguments };
    const record = {
      callId,
      name: meta.name,
      arguments: meta.arguments,
      output: result.output,
      isError: result.isError === true,
      at: result.at > 0 ? result.at : createdAt,
    };
    const owner = ownerByOrig.get(result.callId);
    if (owner !== undefined) {
      owner.blocks.push(block);
      owner.toolResults.push(record);
    } else {
      events.push({
        kind: 'run',
        index: result.nodeIndex,
        at: record.at,
        run: { at: record.at, blocks: [block], toolResults: [record] },
      });
    }
  }

  events.sort((left, right) => left.index - right.index || (left.kind === 'prompt' ? -1 : 1));
  return events;
}

/**
 * Read and normalize one transcript.
 * @param entry - index entry.
 * @param deadline - absolute wall-clock deadline in ms.
 * @returns neutral conversation.
 */
async function loadConversation(entry, deadline) {
  const stat = await fs.promises.stat(entry.file);
  const createdAtFromFile = Math.max(Math.trunc(stat.birthtimeMs || 0), Math.trunc(stat.mtimeMs || 0));
  const nodes = [];
  const byUuid = new Map();
  let firstTs = 0;
  let lastTs = 0;
  let cwd = null;
  let lastTitle = '';
  let sawJson = false;
  let badLines = 0;
  let lineNo = 0;

  const stream = fs.createReadStream(entry.file, { encoding: 'utf8' });
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      lineNo += 1;
      if ((lineNo & 2047) === 0 && Date.now() > deadline) {
        const error = new Error(`读取 Claude Code 会话超过 ${LOAD_BUDGET_MS / 1000}s 预算`);
        error.code = 'ETIMEDOUT';
        throw error;
      }
      if (line.trim() === '') continue;
      const row = parseJsonLine(line);
      if (row === null) {
        badLines += 1;
        continue;
      }
      sawJson = true;
      const at = toMillis(row.timestamp);
      if (at > 0) {
        if (firstTs === 0 || at < firstTs) firstTs = at;
        if (at > lastTs) lastTs = at;
      }
      if (typeof row.cwd === 'string' && row.cwd !== '' && cwd === null) cwd = row.cwd;
      if (row.type === 'ai-title' && typeof row.aiTitle === 'string') {
        const title = row.aiTitle.trim();
        if (title !== '') lastTitle = title;
      }
      if (typeof row.uuid !== 'string' || row.uuid === '') continue;
      const node = buildNode(row, lineNo - 1);
      nodes.push(node);
      // The transcript can rewrite a row (same uuid, corrected parentUuid).
      // The last occurrence wins.
      byUuid.set(node.uuid, node);
    }
  } finally {
    try {
      reader.close();
    } catch {
      // ignore
    }
    try {
      stream.destroy();
    } catch {
      // ignore
    }
  }

  if (Date.now() > deadline) {
    const error = new Error(`读取 Claude Code 会话超过 ${LOAD_BUDGET_MS / 1000}s 预算`);
    error.code = 'ETIMEDOUT';
    throw error;
  }
  if (!sawJson) throw new Error(`Claude Code 会话文件没有可解析的 JSONL 行：${entry.id}`);
  if (badLines > 0 && nodes.length === 0) {
    throw new Error(`Claude Code 会话文件只有损坏行：${entry.id}`);
  }

  const deduped = [...byUuid.values()].sort((left, right) => left.i - right.i);
  if (deduped.length === 0) {
    return {
      source: id,
      id: entry.id,
      title: cleanTitle(lastTitle || '', `Claude Code 会话 ${entry.id.slice(0, 8)}`),
      createdAt: firstTs > 0 ? firstTs : createdAtFromFile,
      updatedAt: Math.max(createdAtFromFile, lastTs, firstTs),
      cwd: cwd ?? decodeProjectDir(entry.projectDir),
      messageCount: 0,
      turns: [],
    };
  }

  const hasMainMessage = deduped.some(
    (node) => (node.type === 'user' || node.type === 'assistant') && !node.sidechain,
  );
  /** Whether a row belongs to the main transcript (all-sidechain files are subagents). */
  const main = (node) => hasMainMessage ? !node.sidechain : true;

  const rootMemo = new Map();
  const trees = new Map();
  for (const node of deduped) {
    const root = findRoot(node, byUuid, rootMemo);
    const bucket = trees.get(root.uuid);
    if (bucket === undefined) trees.set(root.uuid, [node]);
    else bucket.push(node);
  }

  const segments = [];
  for (const treeNodes of trees.values()) {
    const messages = treeNodes.filter(
      (node) => main(node) && (node.type === 'user' || node.type === 'assistant'),
    );
    if (messages.length === 0) continue;
    const leaf = messages[messages.length - 1];
    const chain = [];
    const seen = new Set();
    let current = leaf;
    while (current) {
      if (seen.has(current.uuid)) break;
      seen.add(current.uuid);
      if (main(current)) chain.push(current);
      const parent = current.parent === null ? undefined : byUuid.get(current.parent);
      if (parent === undefined) break;
      current = parent;
    }
    chain.reverse();
    if (chain.length === 0) continue;
    segments.push({ chain, treeNodes, start: chain[0].i });
  }
  segments.sort((left, right) => left.start - right.start);

  if (segments.length === 0) {
    // No parent links at all: fall back to file order, as the contract allows.
    const messages = deduped.filter(
      (node) => main(node) && (node.type === 'user' || node.type === 'assistant'),
    );
    if (messages.length > 0) {
      segments.push({ chain: messages, treeNodes: deduped, start: messages[0].i });
    }
  }

  const callMeta = new Map();
  for (const node of deduped) {
    if (node.type !== 'assistant') continue;
    for (const block of node.blocks) {
      if (block.type !== 'tool-call' || callMeta.has(block.origId)) continue;
      callMeta.set(block.origId, { name: block.name, arguments: block.arguments });
    }
  }

  let firstPrompt = '';
  for (const node of deduped) {
    if (node.prompt !== null) {
      firstPrompt = node.prompt;
      break;
    }
  }

  const conversationCwd = cwd ?? decodeProjectDir(entry.projectDir);
  const createdAt = firstTs > 0 ? firstTs : createdAtFromFile;
  const updatedAt = Math.max(Math.trunc(stat.mtimeMs || 0), lastTs, createdAt);

  const usedCallIds = new Set();
  const events = [];
  for (let index = 0; index < segments.length; index += 1) {
    if ((index & 15) === 0 && Date.now() > deadline) {
      const error = new Error(`处理 Claude Code 会话超过 ${LOAD_BUDGET_MS / 1000}s 预算`);
      error.code = 'ETIMEDOUT';
      throw error;
    }
    events.push(...buildSegmentEvents(segments[index], main, callMeta, usedCallIds, createdAt));
  }

  const turns = [];
  let currentTurn = null;
  for (const event of events) {
    if (event.kind === 'prompt') {
      const at = event.at > 0 ? event.at : createdAt;
      currentTurn = {
        at,
        user: { content: [{ type: 'text', text: event.text }] },
        runs: [],
      };
      turns.push(currentTurn);
      continue;
    }
    if (currentTurn === null) {
      if (turns.length > 0) {
        currentTurn = turns[turns.length - 1];
      } else {
        const at = event.at > 0 ? event.at : createdAt;
        currentTurn = { at, user: null, runs: [] };
        turns.push(currentTurn);
      }
    }
    currentTurn.runs.push(event.run);
  }

  for (const turn of turns) {
    if (turn.at <= 0) turn.at = createdAt;
    for (const run of turn.runs) {
      if (run.at <= 0) run.at = turn.at;
      for (const result of run.toolResults) {
        if (result.at <= 0) result.at = run.at;
      }
    }
  }

  const title = cleanTitle(
    lastTitle !== '' ? lastTitle : titleFromPrompt(firstPrompt),
    `Claude Code 会话 ${entry.id.slice(0, 8)}`,
  );
  const messageCount = turns.reduce(
    (count, turn) => count + (turn.user === null ? 0 : 1) + turn.runs.length,
    0,
  );

  return {
    source: id,
    id: entry.id,
    title,
    createdAt,
    updatedAt,
    cwd: conversationCwd !== null && conversationCwd !== '' ? conversationCwd : null,
    messageCount,
    turns,
  };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Report whether local Claude Code transcripts are readable.
 * @returns availability facts.
 */
export async function status() {
  let stat;
  try {
    stat = fs.statSync(PROJECTS_DIR);
  } catch {
    return {
      available: false,
      location: LOCATION,
      error: `找不到 Claude Code 数据目录 ${LOCATION}`,
    };
  }
  if (!stat.isDirectory()) {
    return { available: false, location: LOCATION, error: `${LOCATION} 不是目录` };
  }

  let entries;
  try {
    entries = sessionIndex();
  } catch (error) {
    return {
      available: false,
      location: LOCATION,
      error: `无法读取 ${LOCATION}：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (entries.length === 0) {
    return {
      available: false,
      location: LOCATION,
      error: `${LOCATION} 下没有可读的 Claude Code 会话（*.jsonl）`,
    };
  }

  for (const entry of entries) {
    try {
      fs.accessSync(entry.file, fs.constants.R_OK);
      return { available: true, location: LOCATION, error: null };
    } catch {
      // try the next transcript
    }
  }
  return {
    available: false,
    location: LOCATION,
    error: `${LOCATION} 下的会话文件均不可读`,
  };
}

/**
 * List Claude Code conversations, newest first.
 *
 * Small files are fully scanned so `messageCount` is exact; files above 2 MiB
 * only get a 1 MiB head/tail scan and report `messageCount: null`.
 * @returns conversation summaries.
 */
export async function list() {
  let entries;
  try {
    entries = sessionIndex();
  } catch {
    return [];
  }
  const rows = [];
  for (const entry of entries) {
    try {
      const summary = await summarize(entry);
      if (summary !== null) rows.push(summary);
    } catch {
      // A truncated or unreadable transcript should not fail the whole scan.
    }
  }
  rows.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
  return rows;
}

/**
 * Load one Claude Code conversation by session id.
 * @param conversationId - transcript filename without `.jsonl`.
 * @returns neutral conversation.
 */
export async function load(conversationId) {
  if (typeof conversationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/u.test(conversationId)) {
    throw new TypeError(`非法 Claude Code 会话 id：${String(conversationId)}`);
  }
  let entries;
  try {
    entries = sessionIndex();
  } catch (error) {
    throw new Error(`无法读取 Claude Code 数据目录：${error instanceof Error ? error.message : String(error)}`);
  }
  const entry = entries.find((item) => item.id === conversationId);
  if (entry === undefined) {
    throw new Error(`找不到 Claude Code 会话：${conversationId}`);
  }
  return loadConversation(entry, Date.now() + LOAD_BUDGET_MS);
}
