/**
 * Per-source scan cache.
 *
 * `list()` asks every provider for its conversations and caches the result for
 * a short window; `payload()` merges the durable imported map into that snapshot
 * for the RPC response.
 */
import { providerLabels, providers } from './providers/registry.js';
import { importKey } from './state.js';

/** Freshness window for the per-source scan cache (milliseconds). */
export const SCAN_CACHE_MS = 120_000;

/** Provider conversation scanner with a short-lived cache. */
export class SourceScanner {
  constructor() {
    this.scan = null;
    this.scanAt = 0;
    this.scanning = null;
    this.labelsCache = null;
  }

  /** Resolve the display labels of every provider, cached for the process. */
  async labels() {
    if (this.labelsCache === null) this.labelsCache = await providerLabels();
    return this.labelsCache;
  }

  /**
   * Scan every provider, reusing a fresh cache entry.
   * @param refresh - force a fresh scan.
   * @param imported - durable imported map (`importKey()` keys).
   * @returns list payload.
   */
  async list(refresh, imported) {
    const now = Date.now();
    if (refresh !== true && this.scan !== null && now - this.scanAt < SCAN_CACHE_MS) return this.payload(imported);
    if (this.scanning !== null) return this.scanning;
    this.scanning = (async () => {
      let list;
      try {
        list = await providers();
      } catch (error) {
        this.scan = { sources: [], error: error instanceof Error ? error.message : String(error) };
        this.scanAt = Date.now();
        this.scanning = null;
        return this.payload(imported);
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
              for (const summary of await provider.list()) {
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
      return this.payload(imported);
    })();
    return this.scanning;
  }

  /**
   * Project the scan cache into the RPC payload.
   * @param imported - durable imported map (`importKey()` keys).
   * @returns list payload.
   */
  payload(imported) {
    const scan = this.scan ?? { sources: [], error: null };
    const sources = scan.sources.map((source) => {
      const conversations = source.conversations.map((conversation) => ({
        ...conversation,
        key: importKey(conversation.source, conversation.id),
        importedSessionId: imported[importKey(conversation.source, conversation.id)]?.sessionId ?? null,
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

  /** Drop the cached scan and labels. */
  clear() {
    this.scan = null;
    this.scanAt = 0;
    this.scanning = null;
    this.labelsCache = null;
  }
}
