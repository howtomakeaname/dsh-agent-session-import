/**
 * Cursor IDE provider: local `composerHeaders` + `cursorDiskKV` history read
 * through the read-only store, normalized into the neutral conversation model.
 *
 * The heavy lifting lives in `../cursor-store.js` (SQLite access) and
 * `../convert.js` (bubble → turns); this module only adapts it to the provider
 * contract shared by every import source.
 */
import { cursorDataAvailable, listComposerSummaries, loadComposer, stateDbPath } from '../cursor-store.js';
import { normalizeConversation } from '../convert.js';

/** Stable provider id used in UI keys and the imported map. */
export const id = 'cursor';

/** Display label. */
export const label = 'Cursor IDE';

/** One-line description for the source picker. */
export const description = 'Cursor IDE Agent/Composer 对话（只读本地 SQLite 历史）';

/** A full composerHeaders scan is heavier than one conversation read; cache it
 * briefly so a batch import does not rescan the table per conversation. */
const SUMMARY_CACHE_MS = 120_000;
let summaryCache = null;
let summaryCacheAt = 0;

/**
 * Read (and briefly cache) the composer summaries.
 * @returns conversation summaries.
 */
async function summaries() {
  if (summaryCache !== null && Date.now() - summaryCacheAt < SUMMARY_CACHE_MS) return summaryCache;
  summaryCache = await listComposerSummaries({ withMessageCounts: false });
  summaryCacheAt = Date.now();
  return summaryCache;
}

/**
 * Report whether local Cursor data is readable.
 * @returns availability facts.
 */
export async function status() {
  const available = cursorDataAvailable();
  return {
    available,
    location: '~/Library/Application Support/Cursor/User/globalStorage',
    error: available ? null : '找不到 Cursor 数据（state.vscdb）',
  };
}

/**
 * List importable Cursor conversations, newest first.
 * @returns conversation summaries.
 */
export async function list() {
  const rows = await listComposerSummaries({ withMessageCounts: true });
  summaryCache = rows;
  summaryCacheAt = Date.now();
  return rows.map((summary) => ({
    id: summary.id,
    title: summary.title,
    cwd: summary.cwd,
    cwdLabel: summary.cwdLabel === '' ? '未知项目' : summary.cwdLabel,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    messageCount: summary.messageCount,
    isArchived: summary.isArchived,
  }));
}

/**
 * Load and normalize one Cursor conversation.
 * @param conversationId - Cursor composer id.
 * @returns neutral conversation.
 */
export async function load(conversationId) {
  const [loaded, known] = await Promise.all([loadComposer(conversationId), summaries().catch(() => [])]);
  const summary = Array.isArray(known) ? known.find((entry) => entry.id === conversationId) : undefined;
  return normalizeConversation(loaded, summary);
}

/** Absolute path of the Cursor state database (diagnostics). */
export function databasePath() {
  return stateDbPath();
}
