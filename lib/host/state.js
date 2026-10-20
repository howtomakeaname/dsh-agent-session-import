/**
 * Durable `<source>:<id> → imported session` map for the importer.
 *
 * The map lives in `$DSH_HOME/session-import/imported.json` and is written
 * atomically after every successful import. State produced before multiple
 * sources existed (bare Cursor ids) is migrated in place on load.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Provider id assumed by the legacy bare-id state format. */
export const LEGACY_PROVIDER_ID = 'cursor';

/**
 * Stable map/selection key for one conversation.
 * @param source - provider id.
 * @param id - provider-local conversation id.
 * @returns `"<source>:<id>"`.
 */
export function importKey(source, id) {
  return `${source}:${id}`;
}

/** Persisted imported-conversation map. */
export class ImportedState {
  /**
   * @param home - DeepSeek Harness home directory.
   * @param logger - optional logger for non-fatal save failures.
   */
  constructor(home, logger = console) {
    this.logger = logger;
    this.path = join(home, 'session-import', 'imported.json');
    this.legacyPath = join(home, 'cursor-import', 'imported.json');
    this.entries = this.load();
  }

  /** Read the durable map, migrating pre-provider (bare-id) keys. */
  load() {
    try {
      const sourcePath = existsSync(this.path) ? this.path : this.legacyPath;
      if (!existsSync(sourcePath)) return {};
      const parsed = JSON.parse(readFileSync(sourcePath, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const migrated = {};
      for (const [key, value] of Object.entries(parsed)) {
        migrated[key.includes(':') ? key : importKey(LEGACY_PROVIDER_ID, key)] = value;
      }
      return migrated;
    } catch {
      return {};
    }
  }

  /** Snapshot of every imported entry, keyed by `importKey()`. */
  all() {
    return this.entries;
  }

  /**
   * One imported entry.
   * @param key - `importKey()` value.
   * @returns entry or undefined.
   */
  get(key) {
    return this.entries[key];
  }

  /**
   * Record one imported conversation and persist the map atomically.
   * @param key - `importKey()` value.
   * @param entry - metadata returned to the UI.
   * @returns the stored entry.
   */
  set(key, entry) {
    this.entries[key] = entry;
    this.save();
    return entry;
  }

  /** Persist the map atomically; failures only warn, never fail the import. */
  save() {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(this.entries, null, 2)}\n`, 'utf8');
      renameSync(temporary, this.path);
    } catch (error) {
      this.logger.warn?.(`dsh-session-import: failed to save imported map: ${String(error)}`);
    }
  }
}
