/**
 * Cursor provider: reads the legacy composer SQLite store and the newer Cursor
 * 3.x agent transcript store, normalizing both into the shared conversation
 * model.
 *
 * Composer data lives in `state.vscdb` (composerHeaders + cursorDiskKV).
 * Cursor 3.x Agents Window / CLI conversations may also be written as JSONL
 * under `~/.cursor/projects/<project>/agent-transcripts/<id>/<id>.jsonl`.
 * Composer entries win when both stores contain the same conversation id,
 * because the composer log also contains tool results.
 */
import { existsSync } from 'node:fs';
import {
  cursorDataAvailable,
  listComposerSummaries,
  loadComposer,
  stateDbPath,
} from '../cursor-store.js';
import { listAgentTranscriptSummaries, loadAgentTranscript } from '../cursor-transcripts.js';
import { normalizeConversation } from '../convert.js';
import { cursorAgentProjectsDir, cursorGlobalStorageDir, displayHomePath } from '../platform.js';

/** Stable provider id used in UI keys and the imported map. */
export const id = 'cursor';

/** Display label. */
export const label = 'Cursor IDE';

/** One-line description for the source picker. */
export const description = 'Cursor IDE Agent/Composer 对话（只读本地 SQLite 与 agent transcript）';

/** Summaries are cached briefly so a batch import does not rescan the stores
 * for every selected conversation. */
const SUMMARY_CACHE_MS = 120_000;
let summaryCache = null;
let summaryCacheAt = 0;

/**
 * Read and merge Cursor's composer and transcript summaries.
 * @returns merged summaries, newest first.
 */
async function allSummaries() {
  if (summaryCache !== null && Date.now() - summaryCacheAt < SUMMARY_CACHE_MS) return summaryCache;
  const [composerRows, transcriptRows] = await Promise.all([
    cursorDataAvailable()
      ? listComposerSummaries({ withMessageCounts: true }).catch(() => [])
      : Promise.resolve([]),
    Promise.resolve(listAgentTranscriptSummaries()),
  ]);
  const merged = composerRows.map((summary) => ({ ...summary, _source: 'composer' }));
  const seen = new Set(merged.map((summary) => summary.id));
  for (const transcript of transcriptRows) {
    if (seen.has(transcript.id)) continue;
    seen.add(transcript.id);
    merged.push(transcript);
  }
  merged.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
  summaryCache = merged;
  summaryCacheAt = Date.now();
  return summaryCache;
}

/** Read (and briefly cache) conversation summaries. */
async function summaries() {
  return allSummaries();
}

/**
 * Report whether local Cursor data is readable.
 * @returns availability facts.
 */
export async function status() {
  const composerAvailable = cursorDataAvailable();
  let transcripts = [];
  try {
    transcripts = listAgentTranscriptSummaries();
  } catch {
    transcripts = [];
  }
  const available = composerAvailable || transcripts.length > 0;
  const location = composerAvailable
    ? displayHomePath(cursorGlobalStorageDir())
    : displayHomePath(cursorAgentProjectsDir());
  return {
    available,
    location,
    error: available ? null : '找不到 Cursor 数据（composer state.vscdb 或 agent-transcripts）',
  };
}

/**
 * List importable Cursor conversations, newest first.
 * @returns conversation summaries.
 */
export async function list() {
  const rows = await summaries();
  return rows.map((summary) => ({
    id: summary.id,
    title: summary.title,
    cwd: summary.cwd,
    cwdLabel: summary.cwdLabel === '' || summary.cwdLabel === undefined ? '未知项目' : summary.cwdLabel,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    messageCount: summary.messageCount,
    isArchived: summary.isArchived,
  }));
}

/**
 * Load and normalize one Cursor conversation from either store.
 * @param conversationId - composer id or agent transcript id.
 * @returns neutral conversation.
 */
export async function load(conversationId) {
  const known = await summaries().catch(() => []);
  const summary = Array.isArray(known) ? known.find((entry) => entry.id === conversationId) : undefined;
  if (summary?._source === 'transcript' && typeof summary.filePath === 'string' && existsSync(summary.filePath)) {
    return loadAgentTranscript(summary.filePath, summary);
  }
  const [loaded, knownSummaries] = await Promise.all([
    loadComposer(conversationId),
    Promise.resolve(known).catch(() => []),
  ]);
  const composerSummary = Array.isArray(knownSummaries) ? knownSummaries.find((entry) => entry.id === conversationId) : undefined;
  return normalizeConversation(loaded, composerSummary);
}

/** Absolute path of the Cursor composer database (diagnostics). */
export function databasePath() {
  return stateDbPath();
}
