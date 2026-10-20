/**
 * Turn one normalized conversation into a durable DSH session.
 *
 * The session is written through the public persistence seam
 * (`ctx.sessionPersistence.create/append/flush/close`), so the backend owns
 * directory escaping, Zstandard framing, locking and crash recovery.
 *
 * Two event shapes are supported:
 *
 *  - `mode: 'full'` (default) — faithful transcript: assistant text/reasoning/
 *    tool-call content blocks plus `tool/call` + `tool/result` events. Best for
 *    reading; resuming may hit model-provider rules about historical thinking
 *    blocks and tool-call ids.
 *  - `mode: 'compatible'` — resume-safe transcript: every model round becomes a
 *    plain assistant text message (tool calls/results inlined as text, reasoning
 *    omitted) and no tool wire events are written. Any provider accepts this
 *    history, and it is much cheaper in context.
 *
 * Both modes start the surface with an empty, protected `system/message` head:
 * DSH v4 requires one so the agent loop can append its system prompt on resume,
 * and the projection of empty content contributes no wire message.
 */
import { randomUUID } from 'node:crypto';

/** Maximum characters kept in a transcript title. */
const TITLE_MAX_CHARS = 160;

/** Maximum characters of one tool-call argument summary in compatible mode. */
const COMPATIBLE_ARGS_MAX = 4_000;

/** Provider/model pair recorded on imported assistant messages (neutral, so
 * the LLM adapter never mistakes imported history for another model's replay). */
function modelSource(conversation) {
  const provider = typeof conversation.source === 'string' && conversation.source !== '' ? conversation.source : 'imported';
  return { kind: 'model', provider, model: 'imported' };
}

/** Clamp a millisecond timestamp to a non-negative safe integer. */
function safeTime(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.trunc(value);
  if (typeof fallback === 'number' && Number.isFinite(fallback) && fallback >= 0) return Math.trunc(fallback);
  return Date.now();
}

/** One-line transcript title. */
function cleanTitle(title, fallback) {
  const text = typeof title === 'string' ? title.replaceAll(/\s+/g, ' ').trim() : '';
  if (text === '') return fallback;
  return text.length <= TITLE_MAX_CHARS ? text : `${text.slice(0, TITLE_MAX_CHARS)}…`;
}

/**
 * Make a tool-call id acceptable to every model provider: the Anthropic-style
 * wire format (and DeepSeek's compatible endpoint) accept only
 * `[A-Za-z0-9_-]`. Imported ids frequently contain newlines, spaces, `/` or
 * `:` (measured 64% on one large Cursor conversation), which would make a
 * resumed request invalid.
 * @param raw - source call id.
 * @param used - per-conversation map of already produced ids.
 * @returns sanitized, conversation-unique id.
 */
function sanitizeCallId(raw, used) {
  let base = typeof raw === 'string' ? raw : '';
  base = base.replaceAll(/[^A-Za-z0-9_-]/g, '_').replaceAll(/_+/g, '_');
  if (base === '') base = 'call';
  if (base.length > 96) base = base.slice(0, 96);
  const count = used.get(base) ?? 0;
  used.set(base, count + 1);
  return count === 0 ? base : `${base}_${count + 1}`;
}

/**
 * Normalize historical tool arguments to a JSON object string.
 *
 * Some agents store arguments as a JSON-encoded string inside the arguments
 * string (double encoding, measured on 19–52% of historical tool calls). The
 * DSH provider adapter does `JSON.parse(raw)` once and silently degrades a
 * non-object result to `{}`, so unwrap until an object/array appears; wrap
 * scalars so the call still shows its input.
 * @param raw - argument string.
 * @returns JSON object string.
 */
function normalizeArguments(raw) {
  const text = typeof raw === 'string' ? raw : '';
  if (text.trim() === '') return '{}';
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return JSON.stringify({ text });
  }
  for (let depth = 0; depth < 3 && typeof value === 'string'; depth += 1) {
    try {
      value = JSON.parse(value);
    } catch {
      break;
    }
  }
  if (typeof value === 'string') return JSON.stringify({ text: value });
  if (value === null || typeof value !== 'object') return JSON.stringify({ value });
  if (Array.isArray(value)) return JSON.stringify({ items: value });
  return JSON.stringify(value);
}

/** Inline one tool call as compatible-mode text. */
function toolCallLine(block, argumentsJson) {
  const name = typeof block.name === 'string' && block.name !== '' ? block.name : 'tool';
  const args = argumentsJson.length <= COMPATIBLE_ARGS_MAX ? argumentsJson : `${argumentsJson.slice(0, COMPATIBLE_ARGS_MAX)}…`;
  return `[工具调用] ${name} ${args}`;
}

/**
 * The user-visible provenance note prepended to the first user message.
 *
 * It is deliberately a normal user-role text block, not a system message:
 * DSH composes its own system prompt per route (cwd, tools, preset, model) and
 * rewrites the protected system head on resume, so an imported prompt there
 * would be replaced or duplicated. User-role context notes are how the harness
 * itself injects context, and they survive every resume path.
 * @param conversation - normalized conversation.
 * @param options - writer options (carries the provider display label).
 * @returns the note text.
 */
function importNotice(conversation, options) {
  const rawLabel = options?.sourceLabel ?? conversation.source;
  const label = typeof rawLabel === 'string' && rawLabel !== '' ? rawLabel : '第三方 agent';
  return [
    `【导入说明】本会话由 ${label} 导入到 DeepSeek Harness。`,
    '历史中的工具调用与结果属于原 agent（工具名可能与当前 DSH 不同，例如 read_file_v2、run_terminal_command_v2、exec、mcp_*），仅作为历史记录；',
    '继续对话时请使用本会话当前实际提供的工具。',
  ].join('');
}

/** Inline one tool result as compatible-mode text. */
function toolResultLine(result) {
  const output = typeof result.output === 'string' ? result.output : '';
  const prefix = result.isError === true ? '[工具结果: 错误]' : '[工具结果]';
  return `${prefix} ${output === '' ? '[没有输出]' : output}`;
}

/**
 * Build the session header and event log for one conversation.
 * @param conversation - normalized conversation from a provider.
 * @param options - `{ cwd, mode? }`; mode is `'full'` or `'compatible'`.
 * @returns `{ header, events }`.
 */
export function buildSessionPlan(conversation, options) {
  const mode = options?.mode === 'compatible' ? 'compatible' : 'full';
  const createdAt = safeTime(conversation.createdAt, Date.now());
  const header = {
    // The persistence seam stores the current logical header shape, which
    // includes the format version (4 today); the backend stamps it physically.
    version: 4,
    id: `session-${randomUUID()}`,
    createdAt,
    cwd: options.cwd,
    isSeeded: false,
    delegationDepth: 0,
  };

  const events = [];
  let seq = 0;
  /** Append one event and return it. */
  const push = (type, data, time, surfaceOp) => {
    const event = { type, seq: seq++, time: safeTime(time, createdAt), data };
    if (surfaceOp !== undefined) event.surfaceOp = surfaceOp;
    events.push(event);
    return event;
  };
  const title = cleanTitle(conversation.title, `导入的对话 ${String(conversation.id).slice(0, 8)}`);
  const notice = options?.importNotice === false ? null : importNotice(conversation, options);
  let noticeWritten = notice === null;
  const usedCallIds = new Map();
  let titleWritten = false;
  let systemHeadWritten = false;
  let turnNumber = 0;

  for (const turn of conversation.turns) {
    turnNumber += 1;
    const turnTime = safeTime(turn.at, createdAt);
    push('turn/start', { turn: turnNumber }, turnTime);

    let stepNumber = 1;
    let stepStarted = false;
    let lastTime = turnTime;
    const startStep = (time) => {
      push('step/start', { turn: turnNumber, step: stepNumber }, time);
      // DSH v4 requires a protected `system/message` surface head: the
      // agent-loop appends a system prompt on resume, and cold readers reject
      // any later system node whose head is not protected. An empty head
      // projects to no wire message but claims surface node 0.
      if (!systemHeadWritten) {
        push(
          'system/message',
          {
            turn: turnNumber,
            step: stepNumber,
            message: { id: randomUUID(), role: 'system', source: { kind: 'system-prompt' }, content: [] },
          },
          time,
          'append',
        );
        systemHeadWritten = true;
      }
      stepStarted = true;
      lastTime = time;
    };
    const endStep = (time) => {
      if (!stepStarted) return;
      push('step/end', { turn: turnNumber, step: stepNumber }, time);
      stepStarted = false;
      lastTime = time;
    };
    const nextStep = (time) => {
      endStep(time);
      stepNumber += 1;
      startStep(time);
    };

    // The user prompt opens the turn's first step.
    if (turn.user !== null) {
      startStep(turnTime);
      const content = [];
      if (!noticeWritten) {
        content.push({ type: 'text', text: notice });
        noticeWritten = true;
      }
      for (const block of turn.user.content) content.push(block);
      const message = {
        role: 'user',
        source: { kind: 'user' },
        content,
        id: randomUUID(),
      };
      push('user/message', message, turnTime, 'append');
      if (!titleWritten) {
        // A user-sourced title must carry no source message seqs; the title is
        // the conversation's own name, not a model-generated one.
        push('session/title', { title, messageSeqs: [], source: { kind: 'user' } }, turnTime);
        titleWritten = true;
      }
    }

    let firstRun = true;
    for (const run of turn.runs) {
      const runTime = safeTime(run.at, lastTime);
      if (!stepStarted) {
        startStep(runTime);
      } else if (!firstRun) {
        nextStep(runTime);
      }
      firstRun = false;

      if (mode === 'compatible') {
        // One plain assistant message per model round. This mode makes resumed
        // requests safe (no foreign tool_use ids, no unsigned thinking wire
        // blocks) — it does NOT drop content: text, reasoning, tool calls and
        // results are all kept, just flattened to text.
        const lines = [];
        for (const block of run.blocks) {
          if (block.type === 'text') lines.push(block.text);
          else if (block.type === 'reasoning') lines.push(`【思考】${block.text}`);
          else if (block.type === 'tool-call') lines.push(toolCallLine(block, normalizeArguments(block.arguments)));
        }
        for (const result of run.toolResults) lines.push(toolResultLine(result));
        const text = lines.filter((line) => typeof line === 'string' && line.trim() !== '').join('\n\n');
        if (text !== '') {
          push(
            'assistant/message',
            {
              turn: turnNumber,
              step: stepNumber,
              message: {
                id: randomUUID(),
                role: 'assistant',
                source: modelSource(conversation),
                content: [{ type: 'text', text }],
              },
              stream: [],
            },
            runTime,
            'append',
          );
        }
        lastTime = runTime;
        continue;
      }

      // ── faithful mode ────────────────────────────────────────────────────
      const content = [];
      const callIds = [];
      for (const block of run.blocks) {
        if (block.type === 'tool-call') {
          const id = sanitizeCallId(block.id, usedCallIds);
          callIds.push(id);
          content.push({ type: 'tool-call', id, name: block.name, arguments: normalizeArguments(block.arguments) });
        } else if (block.type === 'reasoning') {
          content.push({ type: 'reasoning', text: block.text });
        } else if (block.type === 'text') {
          content.push({ type: 'text', text: block.text });
        }
      }
      if (content.length > 0) {
        push(
          'assistant/message',
          {
            turn: turnNumber,
            step: stepNumber,
            message: {
              id: randomUUID(),
              role: 'assistant',
              source: modelSource(conversation),
              content,
            },
            stream: [],
          },
          runTime,
          'append',
        );
      }
      let resultIndex = 0;
      for (const result of run.toolResults) {
        const resultTime = safeTime(result.at, runTime);
        const id = resultIndex < callIds.length ? callIds[resultIndex] : sanitizeCallId(result.callId, usedCallIds);
        resultIndex += 1;
        const text = typeof result.output === 'string' && result.output !== '' ? result.output : '[没有输出]';
        // v4 tracks an advertised → started → settled tool lifecycle: the
        // assistant message advertises the call, `tool/call` starts it, and
        // `tool/result` settles it. The event is trace-only (no surfaceOp).
        push(
          'tool/call',
          {
            turn: turnNumber,
            step: stepNumber,
            callId: id,
            name: result.name,
            arguments: normalizeArguments(result.arguments),
          },
          resultTime,
        );
        push(
          'tool/result',
          {
            turn: turnNumber,
            step: stepNumber,
            message: {
              id: randomUUID(),
              role: 'tool',
              source: { kind: 'tool', callId: id },
              toolCallId: id,
              content: [{ type: 'text', text }],
              ...(result.isError === true ? { isError: true } : {}),
            },
          },
          resultTime,
          'append',
        );
        lastTime = resultTime;
      }
      lastTime = Math.max(lastTime, runTime);
    }
    endStep(lastTime);
    push('turn/end', { turn: turnNumber, reason: { kind: 'completed' } }, lastTime);
  }

  // A transcript with no title event still needs one for the history list.
  if (!titleWritten) push('session/title', { title, messageSeqs: [], source: { kind: 'user' } }, createdAt);
  return { header, events, mode };
}

/**
 * Write one conversation through the persistence seam.
 * @param persistence - `ctx.sessionPersistence` service.
 * @param conversation - normalized conversation.
 * @param options - `{ cwd, mode? }`.
 * @returns `{ sessionId, eventCount, plan }`.
 */
export async function writeSession(persistence, conversation, options) {
  const plan = buildSessionPlan(conversation, options);
  const { header, events } = plan;
  const handle = await persistence.create(header);
  try {
    await handle.append(events);
    await handle.flush();
  } finally {
    await handle.close();
  }
  return { sessionId: header.id, eventCount: events.length, plan };
}
