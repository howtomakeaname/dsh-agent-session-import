/**
 * Read-only access to Cursor 3.x local agent transcripts.
 *
 * Cursor writes the newer Agents Window / CLI conversations as JSONL under:
 *   ~/.cursor/projects/<encoded-project>/agent-transcripts/<id>/<id>.jsonl
 *
 * The format stores user/assistant messages and tool_use inputs, but no tool
 * results. Tool calls are therefore preserved as text blocks, not as a DSH
 * tool lifecycle (which would require a matching result event).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { cursorAgentProjectsDir } from './platform.js';

/** Summaries cache lifetime; transcript directories change as agents run. */
const SUMMARY_TTL_MS = 120_000;
let summaryCache = null;
let summaryCacheAt = 0;
let summaryCacheRoot = null;
const fileCache = new Map();

/** Decode a Cursor project directory name back to an existing filesystem path.
 * Cursor replaces path separators with '-', which is ambiguous when a real
 * component contains a hyphen. Try all segment boundaries and accept only a
 * directory that actually exists.
 * @param key - encoded project directory name.
 * @returns absolute path, or null when it cannot be resolved.
 */
export function decodeProjectCwd(key) {
  if (typeof key !== 'string' || key === '') return null;
  if (process.platform === 'win32') return null;
  const tokens = key.split('-').filter((token) => token !== '');
  if (tokens.length === 0) return null;
  const walk = (index, current) => {
    if (index === tokens.length) return current;
    for (let end = index + 1; end <= tokens.length; end += 1) {
      const component = tokens.slice(index, end).join('-');
      const candidate = join(current, component);
      try {
        if (!statSync(candidate).isDirectory()) continue;
      } catch {
        continue;
      }
      const found = walk(end, candidate);
      if (found !== null) return found;
    }
    return null;
  };
  return walk(0, '/');
}

/** Read one transcript file, using a small mtime-keyed cache. */
function readTranscript(filePath) {
  const stat = statSync(filePath);
  const cached = fileCache.get(filePath);
  if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;
  const lines = readFileSync(filePath, 'utf8').split('\n');
  const messages = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.role === 'user' || entry?.role === 'assistant') {
      const content = Array.isArray(entry.message?.content) ? entry.message.content : [];
      messages.push({ role: entry.role, content });
    }
  }
  const record = { mtimeMs: stat.mtimeMs, size: stat.size, messages, stat };
  fileCache.set(filePath, record);
  return record;
}

/** Extract the first user text as a readable conversation title. */
function titleOf(messages) {
  for (const message of messages) {
    if (message.role !== 'user') continue;
    for (const block of message.content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        const title = block.text.replaceAll(/\s+/g, ' ').trim();
        return title.length <= 80 ? title : `${title.slice(0, 80)}…`;
      }
    }
  }
  return null;
}

/**
 * List root agent transcripts (subagent transcripts are intentionally skipped).
 * @param options - override `projectsDir` for tests.
 * @returns transcript summaries, newest first.
 */
export function listAgentTranscriptSummaries(options = {}) {
  const root = resolve(options.projectsDir ?? cursorAgentProjectsDir());
  if (summaryCache !== null && summaryCacheRoot === root && Date.now() - summaryCacheAt < SUMMARY_TTL_MS) return summaryCache;
  const summaries = [];
  if (!existsSync(root)) {
    summaryCache = [];
    summaryCacheRoot = root;
    summaryCacheAt = Date.now();
    return summaryCache;
  }
  let projects;
  try {
    projects = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    projects = [];
  }
  for (const project of projects) {
    const projectDir = join(root, project.name);
    const transcriptRoot = join(projectDir, 'agent-transcripts');
    let conversations;
    try {
      conversations = readdirSync(transcriptRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name !== 'subagents');
    } catch {
      continue;
    }
    for (const conversation of conversations) {
      const id = conversation.name;
      const filePath = join(transcriptRoot, id, `${id}.jsonl`);
      if (!existsSync(filePath)) continue;
      let record;
      try {
        record = readTranscript(filePath);
      } catch {
        continue;
      }
      if (record.messages.length === 0) continue;
      const stat = record.stat;
      summaries.push({
        id,
        title: titleOf(record.messages) ?? `Cursor Agent ${id.slice(0, 8)}`,
        cwd: decodeProjectCwd(project.name),
        cwdLabel: project.name,
        createdAt: Math.trunc(stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs),
        updatedAt: Math.trunc(stat.mtimeMs),
        isArchived: false,
        messageCount: record.messages.length,
        filePath,
        _source: 'transcript',
      });
    }
  }
  summaries.sort((left, right) => right.updatedAt - left.updatedAt);
  summaryCache = summaries;
  summaryCacheRoot = root;
  summaryCacheAt = Date.now();
  return summaries;
}

/** Build a text representation of a tool_use block (the transcript has no result). */
function toolUseText(block) {
  const name = typeof block.name === 'string' && block.name !== '' ? block.name : 'tool';
  let args = '';
  try {
    args = JSON.stringify(block.input ?? {});
  } catch {
    args = '{}';
  }
  return `[工具调用] ${name} ${args}`;
}

/**
 * Normalize one Cursor agent transcript into the neutral conversation model.
 * @param filePath - transcript JSONL path.
 * @param summary - summary from listAgentTranscriptSummaries.
 * @returns neutral conversation.
 */
export function loadAgentTranscript(filePath, summary) {
  const record = readTranscript(filePath);
  const createdAt = Number(summary?.createdAt) || Math.trunc(record.stat.birthtimeMs || record.stat.mtimeMs);
  const updatedAt = Number(summary?.updatedAt) || Math.trunc(record.stat.mtimeMs);
  const turns = [];
  let current = null;
  let sequence = 0;
  const at = () => createdAt + (sequence += 1);
  for (const message of record.messages) {
    if (message.role === 'user') {
      const content = [];
      for (const block of message.content) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
          content.push({ type: 'text', text: block.text });
        } else if (block?.type === 'tool_result' && typeof block.content === 'string' && block.content !== '') {
          content.push({ type: 'text', text: `[工具结果] ${block.content}` });
        }
      }
      if (content.length === 0) continue;
      current = { at: at(), user: { content }, runs: [] };
      turns.push(current);
      continue;
    }
    const blocks = [];
    for (const block of message.content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') blocks.push({ type: 'text', text: block.text });
      else if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim() !== '') blocks.push({ type: 'reasoning', text: block.thinking });
      else if (block?.type === 'tool_use') blocks.push({ type: 'text', text: toolUseText(block) });
    }
    if (blocks.length === 0) continue;
    if (current === null) {
      current = { at: at(), user: null, runs: [] };
      turns.push(current);
    }
    current.runs.push({ at: at(), blocks, toolResults: [] });
  }
  return {
    source: 'cursor',
    id: summary?.id ?? basename(dirname(filePath)),
    title: summary?.title ?? `Cursor Agent ${basename(dirname(filePath)).slice(0, 8)}`,
    createdAt,
    updatedAt,
    cwd: summary?.cwd ?? null,
    turns,
    messageCount: record.messages.length,
  };
}
