/**
 * Normalize a Cursor composer (composerData + bubble records) into the
 * intermediate conversation model the DSH writer consumes.
 *
 * Cursor bubble shapes handled here (observed across composer versions):
 *  - type 1: user prompt. `text`, `richText` (ProseMirror doc JSON), `context`
 *    (attached files/images/links), optional `images`.
 *  - type 2 with `toolFormerData`: one tool call plus its result in the same
 *    bubble (`name`, `rawArgs` JSON string, `result` JSON string, `status`).
 *  - type 2 with `capabilityType: 30` / `thinking`: a reasoning block. The
 *    `thinking` field is itself a JSON string `{ text, isLastThinkingChunk }`.
 *  - other type 2: assistant text (`text`).
 */

/** Maximum characters kept from one tool result (the rest is elided). */
export const TOOL_RESULT_MAX_CHARS = 20_000;
/** Maximum characters kept from one reasoning block. */
export const REASONING_MAX_CHARS = 12_000;
/** Maximum characters kept from one attachment/context description list. */
const CONTEXT_MAX_LINES = 40;

/** Parse a JSON string, falling back to the raw string. */
function parseJsonish(value) {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Truncate a string with a visible marker. */
function clamp(text, max) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} characters by Cursor importer]`;
}

/** Extract plain text from a Cursor rich-text ProseMirror document. */
function richTextToPlain(value) {
  if (typeof value === 'string') {
    const document = parseJsonish(value);
    if (document === undefined) return value;
    return richTextToPlain(document);
  }
  if (value === null || typeof value !== 'object') return '';
  const parts = [];
  if (typeof value.text === 'string') parts.push(value.text);
  if (Array.isArray(value.content)) for (const child of value.content) parts.push(richTextToPlain(child));
  return parts.join('');
}

/** Extract plain text from one reasoning bubble. */
function reasoningText(value) {
  const parsed = parseJsonish(value);
  if (parsed !== undefined && typeof parsed === 'object' && parsed !== null) {
    if (typeof parsed.text === 'string') return parsed.text;
    if (typeof parsed.subject === 'string') return parsed.subject;
  }
  if (typeof value === 'string') return parseJsonish(value) === undefined ? value : '';
  return '';
}

/** Read the URI path of one context-reference entry. */
function refPath(entry) {
  if (typeof entry === 'string') return entry;
  if (entry === null || typeof entry !== 'object') return '';
  if (typeof entry.path === 'string') return entry.path;
  const uri = entry.uri ?? entry;
  if (typeof uri.fsPath === 'string') return uri.fsPath;
  if (typeof uri.external === 'string') {
    try {
      return uri.external.startsWith('file://') ? decodeURIComponent(uri.external.slice(7)) : uri.external;
    } catch {
      return uri.external;
    }
  }
  if (typeof uri.path === 'string') return uri.path;
  return '';
}

/**
 * Summarize a user bubble's context into compact lines for the transcript.
 * Images and file selections are referenced by path; their bytes are not copied.
 * @param bubble - user bubble value.
 * @returns context lines, possibly empty.
 */
function contextLines(bubble) {
  const lines = [];
  const seen = new Set();
  const add = (line) => {
    const trimmed = String(line).trim();
    if (trimmed === '' || seen.has(trimmed)) return;
    seen.add(trimmed);
    if (lines.length < CONTEXT_MAX_LINES) lines.push(trimmed);
  };
  const context = bubble.context !== null && typeof bubble.context === 'object' ? bubble.context : {};
  for (const [key, label] of [
    ['fileSelections', '文件'],
    ['selectedDocuments', '文档'],
    ['selectedImages', '图片'],
    ['folderSelections', '目录'],
    ['terminalSelections', '终端'],
    ['gitDiff', 'Git 变更'],
  ]) {
    const list = context[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const path = refPath(entry);
      if (path !== '') add(`${label}: ${path}`);
    }
  }
  for (const [key, label] of [
    ['externalLinks', '链接'],
    ['selectedDocs', '文档'],
  ]) {
    const list = context[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const value = typeof entry === 'string' ? entry : (entry?.url ?? entry?.title ?? refPath(entry));
      if (value !== undefined && value !== '') add(`${label}: ${value}`);
    }
  }
  const images = Array.isArray(bubble.images) ? bubble.images : [];
  for (const image of images) {
    if (image === null || typeof image !== 'object') continue;
    const path = typeof image.path === 'string' ? image.path : refPath(image);
    if (path !== '') add(`图片: ${path}`);
    else if (typeof image.uuid === 'string') add(`图片附件: ${image.uuid}`);
  }
  if (Array.isArray(bubble.attachedFolders)) for (const folder of bubble.attachedFolders) add(`目录: ${refPath(folder)}`);
  return lines;
}

/** Extract the tool call id of a tool bubble. */
function toolCallId(bubble, header) {
  const fromHeader = header?.grouping?.toolCallId;
  const fromBubble = bubble?.toolFormerData?.toolCallId;
  if (typeof fromBubble === 'string' && fromBubble !== '') return fromBubble;
  if (typeof fromHeader === 'string' && fromHeader !== '') return fromHeader;
  const id = typeof bubble?.bubbleId === 'string' ? bubble.bubbleId : '';
  const marker = id.indexOf('/t:');
  return marker >= 0 ? id.slice(marker + 3) : `tool-${Math.random().toString(36).slice(2)}`;
}

/** Build one tool call block plus its result record from a tool bubble. */
function toolCallOf(bubble, header) {
  const former = bubble.toolFormerData ?? {};
  const callId = toolCallId(bubble, header);
  const name = typeof former.name === 'string' && former.name !== '' ? former.name : 'tool';
  let args = typeof former.rawArgs === 'string' ? former.rawArgs : '';
  if (args === '' && former.params !== undefined) {
    try {
      args = JSON.stringify(former.params);
    } catch {
      args = '';
    }
  }
  const block = { type: 'tool-call', id: callId, name, arguments: args };
  let output = former.result;
  if (typeof output !== 'string') {
    try {
      output = output === undefined ? '' : JSON.stringify(output);
    } catch {
      output = String(output);
    }
  }
  const status = typeof former.status === 'string' ? former.status : '';
  const isError = status === 'error' || status === 'errored' || status === 'failed' || former.error !== undefined;
  return {
    callId,
    name,
    arguments: args,
    block,
    isError,
    output: clamp(output, TOOL_RESULT_MAX_CHARS),
    at: toMillis(bubble.completedAtMs ?? bubble.startedAtMs ?? bubble.createdAt, header?.completedAtMs ?? header?.startedAtMs),
  };
}

/** Convert a Cursor timestamp (ISO string or millisecond number) to milliseconds. */
function toMillis(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof fallback === 'number' && Number.isFinite(fallback)) return fallback;
  return 0;
}

/**
 * Convert one assistant bubble into zero or one normalized block.
 * @param bubble - assistant bubble value.
 * @param header - matching entry in `fullConversationHeadersOnly`.
 * @returns `{ kind: 'text'|'reasoning'|'tool', block?, tool? }` or null.
 */
function assistantBlockOf(bubble, header) {
  const capabilityType = header?.grouping?.capabilityType ?? bubble.capabilityType;
  if (bubble.toolFormerData !== undefined && bubble.toolFormerData !== null) {
    return { kind: 'tool', tool: toolCallOf(bubble, header) };
  }
  if (capabilityType === 30 || typeof bubble.thinking === 'string') {
    const text = clamp(reasoningText(bubble.thinking), REASONING_MAX_CHARS);
    if (text.trim() !== '') return { kind: 'reasoning', block: { type: 'reasoning', text } };
  }
  const text = clamp(typeof bubble.text === 'string' ? bubble.text : richTextToPlain(bubble.richText), Number.MAX_SAFE_INTEGER);
  if (text.trim() !== '') return { kind: 'text', block: { type: 'text', text } };
  return null;
}

/**
 * Normalize one composer into the intermediate conversation model.
 * @param loaded - `{ composerId, header, data, bubbles }` from the Cursor store.
 * @param summary - optional list summary supplying title/cwd/timestamps.
 * @returns normalized conversation.
 */
export function normalizeConversation(loaded, summary) {
  const { header, data, bubbles } = loaded;
  const bubbleValues = new Map(bubbles.map((entry) => [entry.bubbleId, entry.value]));
  const headerEntries = Array.isArray(data.fullConversationHeadersOnly) ? data.fullConversationHeadersOnly : [];

  const createdAt = toMillis(summary?.createdAt ?? header.createdAt, data.createdAt);
  const updatedAt = toMillis(summary?.updatedAt ?? header.lastUpdatedAt, createdAt);
  const cwd = summary?.cwd ?? null;
  const title = summary?.title ?? (typeof header.name === 'string' ? header.name : `Cursor 对话 ${loaded.composerId.slice(0, 8)}`);

  /** @type {Array<{kind:'user'|'assistant', at:number, bubble:object, header:object}>} */
  // Preferred order: the composer's compact header list. Newer cursor-import
  // reads skip the composerData document entirely (it can be pathological for
  // SQLite's JSON functions), so the fallback rebuilds order from the bubble
  // records themselves: type + startedAtMs are present on every message bubble.
  let sequence = [];
  if (headerEntries.length > 0) {
    for (const headerEntry of headerEntries) {
      const bubbleId = headerEntry?.bubbleId;
      if (typeof bubbleId !== 'string') continue;
      const bubble = bubbleValues.get(bubbleId);
      if (bubble === undefined) continue;
      if (headerEntry.type === 1) {
        sequence.push({ kind: 'user', at: toMillis(bubble.completedAtMs ?? bubble.startedAtMs ?? bubble.createdAt, headerEntry.completedAtMs ?? headerEntry.startedAtMs), bubble, header: headerEntry });
        continue;
      }
      if (headerEntry.type !== 2) continue;
      sequence.push({ kind: 'assistant', at: toMillis(bubble.completedAtMs ?? bubble.startedAtMs ?? bubble.createdAt, headerEntry.completedAtMs ?? headerEntry.startedAtMs), bubble, header: headerEntry });
    }
  } else {
    const derived = [];
    let index = 0;
    for (const [bubbleId, bubble] of bubbleValues) {
      const type = bubble?.type;
      const kind = type === 1 ? 'user' : type === 2 ? 'assistant' : null;
      const position = index++;
      if (kind === null) continue;
      derived.push({
        kind,
        at: toMillis(bubble.completedAtMs ?? bubble.startedAtMs ?? bubble.createdAt, 0),
        bubble,
        header: { bubbleId, type },
        position,
      });
    }
    derived.sort((left, right) => (left.at !== right.at ? left.at - right.at : left.position - right.position));
    sequence = derived;
  }

  // Cursor occasionally repeats a tool call id inside one conversation (the
  // source headers carry duplicates). DSH's v4 tool lifecycle tracks calls by
  // id, so keep them unique per conversation while leaving the first one as-is.
  const usedCallIds = new Map();
  const uniqueCallId = (raw) => {
    const count = usedCallIds.get(raw) ?? 0;
    usedCallIds.set(raw, count + 1);
    return count === 0 ? raw : `${raw}~${count + 1}`;
  };

  const turns = [];
  let current = null;
  for (const entry of sequence) {
    if (entry.kind === 'user') {
      const text = typeof entry.bubble.text === 'string' ? entry.bubble.text : richTextToPlain(entry.bubble.richText);
      const lines = contextLines(entry.bubble);
      if (text.trim() === '' && lines.length === 0) continue;
      const content = [];
      if (text.trim() !== '') content.push({ type: 'text', text });
      if (lines.length > 0) content.push({ type: 'text', text: `（附加上下文）\n${lines.join('\n')}` });
      current = { at: entry.at, user: { content }, runs: [] };
      turns.push(current);
      continue;
    }
    const block = assistantBlockOf(entry.bubble, entry.header);
    if (block === null) continue;
    if (current === null) {
      current = { at: entry.at, user: null, runs: [] };
      turns.push(current);
    }
    const lastRun = current.runs.length === 0 ? undefined : current.runs[current.runs.length - 1];
    // A tool result closes the current model round; the next block starts a
    // new run. Everything before the first tool block in a run is one message.
    const startsNewRun = lastRun !== undefined && lastRun.toolResults.length > 0;
    if (lastRun === undefined || startsNewRun) {
      current.runs.push({ at: entry.at, blocks: [], toolResults: [] });
    }
    const run = current.runs[current.runs.length - 1];
    if (block.kind === 'tool') {
      const callId = uniqueCallId(block.tool.callId);
      block.tool.block.id = callId;
      block.tool.callId = callId;
      run.blocks.push(block.tool.block);
      run.toolResults.push({ callId, name: block.tool.name, arguments: block.tool.arguments, isError: block.tool.isError, output: block.tool.output, at: block.tool.at || entry.at });
    } else if (block.kind === 'reasoning') {
      run.blocks.push(block.block);
    } else if (block.kind === 'text') {
      run.blocks.push(block.block);
    }
  }

  const messageCount = turns.reduce((count, turn) => count + (turn.user === null ? 0 : 1) + turn.runs.length, 0);
  return { source: 'cursor', id: loaded.composerId, title, createdAt, updatedAt, cwd, turns, messageCount };
}
