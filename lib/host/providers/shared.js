/**
 * Small helpers shared by import providers.
 *
 * A provider turns one third-party agent's on-disk history into the neutral
 * `Conversation` model the DSH writer consumes:
 *
 *   Conversation = {
 *     source, id, title, createdAt, updatedAt, cwd, messageCount,
 *     turns: [{ at, user: {content:[{type:'text',text}]} | null,
 *               runs: [{ at, blocks:[text|reasoning|tool-call],
 *                        toolResults:[{callId,name,arguments,output,isError,at}] }] }]
 *   }
 *
 * Invariants every provider must hold (the writer relies on them):
 *  - tool-call ids are unique inside one conversation;
 *  - every `tool-call` block has exactly one matching result (same id, name,
 *    arguments) in the same run's `toolResults`, and vice versa;
 *  - `blocks` of one run become one assistant message; its results are emitted
 *    right after that message, in order.
 */

/** Maximum characters kept from one tool result. */
export const TOOL_RESULT_MAX_CHARS = 20_000;
/** Maximum characters kept from one reasoning block. */
export const REASONING_MAX_CHARS = 12_000;
/** Maximum characters kept in a conversation title. */
export const TITLE_MAX_CHARS = 160;

/**
 * Truncate a string with a visible marker.
 * @param text - source text.
 * @param max - maximum characters kept.
 * @param label - provider label used in the marker.
 * @returns the source text or its truncated form.
 */
export function clamp(text, max, label = 'importer') {
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
export function toMillis(value, fallback = 0) {
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
export function cleanTitle(title, fallback) {
  const text = typeof title === 'string' ? title.replaceAll(/\s+/g, ' ').trim() : '';
  if (text === '') return fallback;
  return text.length <= TITLE_MAX_CHARS ? text : `${text.slice(0, TITLE_MAX_CHARS)}…`;
}

/**
 * Basename of an absolute directory path, for the conversation list.
 * @param cwd - absolute path or null.
 * @returns display label ('' when unknown).
 */
export function cwdLabel(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return '';
  const parts = cwd.split(/[\\/]/).filter((part) => part !== '');
  return parts.length === 0 ? '' : parts[parts.length - 1];
}

/**
 * Normalize provider text content into one text block list.
 * @param text - plain text.
 * @returns content array (empty when the text is blank).
 */
export function textContent(text) {
  const value = typeof text === 'string' ? text : '';
  return value.trim() === '' ? [] : [{ type: 'text', text: value }];
}

/**
 * Normalize a provider id for use in UI keys and the imported map.
 * @param value - candidate id.
 * @returns lowercase id, or '' when invalid.
 */
export function providerIdOf(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]*$/.test(value) ? value : '';
}
