/**
 * Host-side import service: RPC endpoints, per-source scan cache, the job
 * runner and the durable `<source>:<id> → sessionId` map.
 *
 * Routes (registered by `lib/index.js`):
 *   POST /session-import/list   { refresh?: boolean }        → ListResult
 *   POST /session-import/import { items: [{source,id}],       → { jobId }
 *                                ids?: string[] }             (legacy cursor-only)
 *   POST /session-import/status { jobId }                     → ImportStatus
 *   POST /session-import/cancel { jobId }                     → { cancelled }
 * Every endpoint answers `{ ok: true, value }` or `{ ok: false, error: {...} }`.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { providerById, providerLabels, providers } from './providers/registry.js';
import { writeSession } from './writer.js';

/** Freshness window for the per-source scan cache (milliseconds). */
const SCAN_CACHE_MS = 120_000;

/** Completed jobs retained for status reads. */
const MAX_RETAINED_JOBS = 5;

/** Pause between two imported conversations (milliseconds). */
const IMPORT_GAP_MS = 15;

/** Skip the projection-cache warm-up above this event count. */
const WARM_EVENT_LIMIT = 8000;

/** Provider id assumed by the legacy `ids` import payload. */
const LEGACY_PROVIDER_ID = 'cursor';

/** Import modes exposed by the panel. */
const IMPORT_MODES = new Set(['full', 'compatible']);

/** Rough context estimate: characters per model token (mixed CN/EN). */
const CHARS_PER_TOKEN = 3;

/** Full-fidelity transcripts above this estimate get a context warning. */
const LARGE_TRANSCRIPT_CHARS = 1_200_000;

/** Estimate the model-context size of a normalized conversation. */
function estimateTranscriptChars(conversation) {
  let chars = 0;
  for (const turn of conversation.turns ?? []) {
    for (const block of turn.user?.content ?? []) chars += typeof block.text === 'string' ? block.text.length : 0;
    for (const run of turn.runs ?? []) {
      for (const block of run.blocks ?? []) chars += typeof block.text === 'string' ? block.text.length : 0;
      for (const result of run.toolResults ?? []) chars += typeof result.output === 'string' ? result.output.length : 0;
    }
  }
  return chars;
}

/** Resolve the DeepSeek Harness home the same way the CLI does. */
function resolveDshHome() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
  return configured === '' ? join(homedir(), '.dsh') : configured;
}

/** A RemoteResult-style failure. */
function failure(code, message, details = {}) {
  return { ok: false, error: { code, message, details } };
}

/** A RemoteResult-style success. */
function success(value) {
  return { ok: true, value };
}

/** Sleep helper. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Stable map/selection key for one conversation. */
export function importKey(source, id) {
  return `${source}:${id}`;
}

/**
 * Normalize the import payload into `{ source, id }` items.
 * @param payload - RPC payload.
 * @returns normalized items.
 */
function normalizeItems(payload) {
  const raw = Array.isArray(payload?.items)
    ? payload.items
    : Array.isArray(payload?.ids)
      ? payload.ids.map((id) => ({ source: LEGACY_PROVIDER_ID, id }))
      : [];
  const items = [];
  const seen = new Set();
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const source = typeof entry.source === 'string' && entry.source !== '' ? entry.source : LEGACY_PROVIDER_ID;
    const id = typeof entry.id === 'string' ? entry.id : '';
    if (id === '') continue;
    const key = importKey(source, id);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ source, id });
  }
  return items;
}

/** The host-side importer. */
export class ImportService {
  /**
   * @param ctx - host plugin context.
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.home = resolveDshHome();
    this.statePath = join(this.home, 'session-import', 'imported.json');
    this.scan = null;
    this.scanAt = 0;
    this.scanning = null;
    /** @type {Map<string, object>} */
    this.jobs = new Map();
    this.activeJobId = null;
    this.cancelRequested = false;
    this.imported = this.loadImported();
    this.labelsCache = null;
  }

  /** Read the durable imported map, migrating pre-provider (bare-id) keys. */
  loadImported() {
    try {
      // State written by the pre-multi-source build lives beside this one.
      const legacyPath = join(this.home, 'cursor-import', 'imported.json');
      const sourcePath = existsSync(this.statePath) ? this.statePath : legacyPath;
      if (!existsSync(sourcePath)) return {};
      const parsed = JSON.parse(readFileSync(sourcePath, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const migrated = {};
      for (const [key, value] of Object.entries(parsed)) {
        const normalized = key.includes(':') ? key : importKey(LEGACY_PROVIDER_ID, key);
        migrated[normalized] = value;
      }
      return migrated;
    } catch {
      return {};
    }
  }

  /** Persist the imported map atomically. */
  saveImported() {
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      const temporary = `${this.statePath}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(this.imported, null, 2)}\n`, 'utf8');
      renameSync(temporary, this.statePath);
    } catch (error) {
      this.ctx.logger.warn(`dsh-session-import: failed to save imported map: ${String(error)}`);
    }
  }

  /** Drop jobs beyond the retention window. */
  pruneJobs() {
    if (this.jobs.size <= MAX_RETAINED_JOBS) return;
    for (const [jobId, job] of this.jobs) {
      if (this.jobs.size <= MAX_RETAINED_JOBS) break;
      if (job.state === 'running') continue;
      this.jobs.delete(jobId);
    }
  }

  /** Resolve the display labels of every provider, cached for the process. */
  async labels() {
    if (this.labelsCache === null) this.labelsCache = await providerLabels();
    return this.labelsCache;
  }

  /**
   * Scan every provider, reusing a fresh cache entry.
   * @param refresh - force a fresh scan.
   * @returns list payload.
   */
  async list(refresh) {
    const now = Date.now();
    if (refresh !== true && this.scan !== null && now - this.scanAt < SCAN_CACHE_MS) return this.listPayload();
    if (this.scanning !== null) return this.scanning;
    this.scanning = (async () => {
      let list;
      try {
        list = await providers();
      } catch (error) {
        this.scan = { sources: [], error: error instanceof Error ? error.message : String(error) };
        this.scanAt = Date.now();
        this.scanning = null;
        return this.listPayload();
      }
      const results = await Promise.allSettled(
        list.map(async (provider) => {
          const descriptor = {
            id: provider.id,
            label: typeof provider.label === 'string' ? provider.label : provider.id,
            description: typeof provider.description === 'string' ? provider.description : '',
          };
          let status = { available: false, location: '', error: null };
          try {
            status = (await provider.status()) ?? status;
          } catch (error) {
            status.error = error instanceof Error ? error.message : String(error);
          }
          const conversations = [];
          if (status.available === true) {
            try {
              const summaries = await provider.list();
              for (const summary of summaries) {
                conversations.push({
                  source: provider.id,
                  id: summary.id,
                  title: summary.title,
                  cwd: summary.cwd ?? null,
                  cwdLabel: summary.cwdLabel ?? '',
                  createdAt: summary.createdAt ?? 0,
                  updatedAt: summary.updatedAt ?? summary.createdAt ?? 0,
                  messageCount: typeof summary.messageCount === 'number' ? summary.messageCount : null,
                  isArchived: summary.isArchived === true,
                });
              }
            } catch (error) {
              status = { ...status, error: error instanceof Error ? error.message : String(error) };
            }
          }
          return {
            ...descriptor,
            available: status.available === true,
            location: status.location ?? '',
            error: status.error ?? null,
            conversations,
          };
        }),
      );
      const sources = [];
      for (const result of results) {
        if (result.status === 'fulfilled') sources.push(result.value);
      }
      this.scan = { sources, error: null };
      this.scanAt = Date.now();
      this.scanning = null;
      return this.listPayload();
    })();
    return this.scanning;
  }

  /** Project the scan cache into the RPC payload. */
  listPayload() {
    const scan = this.scan ?? { sources: [], error: null };
    const sources = scan.sources.map((source) => {
      const conversations = source.conversations.map((conversation) => ({
        ...conversation,
        key: importKey(conversation.source, conversation.id),
        importedSessionId: this.imported[importKey(conversation.source, conversation.id)]?.sessionId ?? null,
      }));
      return { ...source, conversations, count: conversations.length };
    });
    return {
      scannedAt: this.scanAt,
      error: scan.error ?? null,
      sources,
      total: sources.reduce((sum, source) => sum + source.count, 0),
    };
  }

  /** Resolve a writable project directory for one conversation. */
  resolveCwd(conversation) {
    const candidate = conversation.cwd;
    if (typeof candidate === 'string' && candidate.startsWith('/')) {
      try {
        if (statSync(candidate).isDirectory()) return candidate;
      } catch {
        // The original project no longer exists: fall back below.
      }
    }
    return homedir();
  }

  /**
   * Start importing the requested conversations.
   * @param payload - RPC payload with `items` (or legacy `ids`).
   * @param options - import options.
   * @returns `{ jobId }`.
   */
  startImport(payload, options) {
    if (this.activeJobId !== null) {
      const active = this.jobs.get(this.activeJobId);
      return failure('busy', `已有导入任务在进行中（${active?.completed ?? 0}/${active?.total ?? 0}）`, { jobId: this.activeJobId });
    }
    const items = normalizeItems(payload);
    if (items.length === 0) return failure('bad-request', '没有选择要导入的对话');
    const mode = IMPORT_MODES.has(options?.mode) ? options.mode : 'full';
    const persistence = this.ctx.get('sessionPersistence');
    if (persistence === undefined) return failure('unavailable', '当前 DSH 组合没有会话持久化后端，无法写入会话');

    const job = {
      jobId: `job-${randomUUID()}`,
      mode,
      state: 'running',
      total: items.length,
      completed: 0,
      current: null,
      results: [],
      startedAt: Date.now(),
      finishedAt: undefined,
      error: undefined,
    };
    this.jobs.set(job.jobId, job);
    this.activeJobId = job.jobId;
    this.cancelRequested = false;
    this.pruneJobs();
    this.runJob(job, items, persistence, { ...(options ?? {}), mode }).catch((error) => {
      job.state = 'failed';
      job.error = error instanceof Error ? error.message : String(error);
      job.finishedAt = Date.now();
      this.activeJobId = null;
      this.ctx.logger.warn(`dsh-session-import: job ${job.jobId} failed: ${String(error)}`);
    });
    return success({ jobId: job.jobId });
  }

  /**
   * Import conversations sequentially, reporting progress into the job object.
   * @param job - job state.
   * @param items - `{ source, id }` items.
   * @param persistence - session persistence service.
   * @param options - import options.
   */
  async runJob(job, items, persistence, options) {
    for (const item of items) {
      if (this.cancelRequested) {
        job.state = 'cancelled';
        break;
      }
      const key = importKey(item.source, item.id);
      const known = this.imported[key];
      job.current = { source: item.source, id: item.id, title: known?.title ?? item.id };
      try {
        const provider = await providerById(item.source);
        if (provider === undefined) throw new Error(`未知的导入来源：${item.source}`);
        const conversation = await provider.load(item.id);
        const normalized = {
          ...conversation,
          source: provider.id,
          title: conversation.title || known?.title || `${typeof provider.label === 'string' ? provider.label : provider.id} 对话 ${item.id.slice(0, 8)}`,
        };
        // Surface the real conversation title in the progress modal instead of
        // the raw provider id while the write is running.
        job.current = { source: item.source, id: item.id, title: normalized.title };
        const hasSurface = Array.isArray(normalized.turns) && normalized.turns.some((turn) => turn.user !== null || (Array.isArray(turn.runs) && turn.runs.some((run) => Array.isArray(run.blocks) && run.blocks.length > 0)));
        if (!hasSurface) {
          job.results.push({ source: item.source, id: item.id, title: normalized.title, ok: false, skipped: true, error: '这条对话没有可导入的消息' });
        } else {
          const cwd = this.resolveCwd(normalized);
          const transcriptChars = estimateTranscriptChars(normalized);
          const warnings = [];
          if (options.mode !== 'compatible' && transcriptChars > LARGE_TRANSCRIPT_CHARS) {
            warnings.push(`历史较长（约 ${Math.round(transcriptChars / CHARS_PER_TOKEN / 1000)}k tokens），续聊会占用较多上下文；如需继续对话建议以「接续友好」模式重新导入`);
          }
          const written = await writeSession(persistence, normalized, { cwd, mode: options.mode, sourceLabel: provider.label });
          const warmed = await this.warmProjectionCache(written.sessionId, written.plan);
          this.imported[key] = {
            source: item.source,
            remoteId: item.id,
            sessionId: written.sessionId,
            importedAt: Date.now(),
            title: normalized.title,
            cwd,
            messageCount: normalized.messageCount ?? null,
            mode: options.mode,
            transcriptChars,
            projectionCacheWarmed: warmed,
          };
          this.saveImported();
          job.results.push({
            source: item.source,
            id: item.id,
            title: normalized.title,
            ok: true,
            sessionId: written.sessionId,
            cwd,
            importedMessages: normalized.messageCount ?? null,
            mode: options.mode,
            ...(warnings.length === 0 ? {} : { warnings }),
          });
        }
      } catch (error) {
        job.results.push({
          source: item.source,
          id: item.id,
          title: known?.title ?? item.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      job.completed += 1;
      job.current = null;
      if (IMPORT_GAP_MS > 0) await sleep(IMPORT_GAP_MS);
    }
    if (job.state === 'running') job.state = this.cancelRequested ? 'cancelled' : 'done';
    job.finishedAt = Date.now();
    job.current = null;
    this.activeJobId = null;
    const okCount = job.results.filter((result) => result.ok === true).length;
    this.ctx.logger.info(`dsh-session-import: job ${job.jobId} ${job.state} (${okCount}/${job.total} imported)`);
  }

  /**
   * Persist the session's projection checkpoint (title, list metadata, stats)
   * so the history list can label the imported session without folding its
   * whole log on every page load.
   *
   * A detached in-memory Session is built from the exact log we just wrote and
   * handed to the projection cache's public `write()`; it is never entered into
   * the live store and nothing is appended. Every failure is soft: the session
   * itself is already durable, only the list title stays cold.
   *
   * @param sessionId - persisted session id.
   * @param plan - `{ header, events }` produced by the writer.
   * @returns whether a checkpoint was written.
   */
  async warmProjectionCache(sessionId, plan) {
    const sessions = this.ctx.get('sessions');
    const cache = this.ctx.get('sessionProjectionCache');
    if (sessions === undefined || cache === undefined) return false;
    if (sessions.get(sessionId) !== undefined) return false;
    // Folding a huge log just to prefill the list title is not worth blocking
    // the job; the title appears when the session is first opened instead.
    if (plan.events.length > WARM_EVENT_LIMIT) return false;
    try {
      const session = sessions.prepare(sessionId, {
        seed: plan.events,
        meta: {
          createdAt: plan.header.createdAt,
          cwd: plan.header.cwd,
          isSeeded: false,
          delegationDepth: 0,
        },
      });
      await cache.write(session);
      return true;
    } catch (error) {
      this.ctx.logger.warn(`dsh-session-import: projection warm-up for ${sessionId} failed: ${String(error)}`);
      return false;
    }
  }

  /** Return a status snapshot for one job. */
  status(jobId) {
    const job = typeof jobId === 'string' ? this.jobs.get(jobId) : undefined;
    if (job === undefined) return failure('not-found', '找不到这个导入任务（可能已过期，重新扫描即可）');
    return {
      jobId: job.jobId,
      state: job.state,
      total: job.total,
      completed: job.completed,
      current: job.current,
      results: job.results,
      startedAt: job.startedAt,
      ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
      ...(job.error === undefined ? {} : { error: job.error }),
    };
  }

  /** Request cancellation of the running job. */
  cancel(jobId) {
    const job = typeof jobId === 'string' ? this.jobs.get(jobId) : undefined;
    if (job === undefined) return failure('not-found', '找不到这个导入任务');
    if (job.state !== 'running') return { cancelled: false, state: job.state };
    if (job.jobId !== this.activeJobId) return { cancelled: false, state: job.state };
    this.cancelRequested = true;
    return { cancelled: true, state: 'cancelling' };
  }

  /**
   * Dispatch one HTTP endpoint call.
   * @param endpoint - endpoint name.
   * @param payload - JSON payload.
   * @returns RemoteResult.
   */
  async handle(endpoint, payload) {
    try {
      const body = payload !== null && typeof payload === 'object' ? payload : {};
      switch (endpoint) {
        case 'list':
          return success(await this.list(body.refresh === true));
        case 'import':
          return this.startImport(body, body.options);
        case 'status':
          return success(this.status(body.jobId));
        case 'cancel':
          return success(this.cancel(body.jobId));
        default:
          return failure('unknown-endpoint', `unknown endpoint: ${String(endpoint)}`);
      }
    } catch (error) {
      return failure('internal', error instanceof Error ? error.message : String(error));
    }
  }

  /** Release cached state (the service has no timers of its own). */
  dispose() {
    this.scan = null;
    this.jobs.clear();
  }
}
