/**
 * Read-only SQLite queries for local agent stores.
 *
 * `node:sqlite` is preferred (available in the harness runtime on every
 * platform and avoids a `sqlite3` CLI dependency). When unavailable, the helper
 * falls back to the system `sqlite3` CLI through PATH with a read-only URI.
 */
import { execFile } from 'node:child_process';
import { sqlite3Command, sqliteFileUri } from './platform.js';

/** Default CLI timeout (milliseconds). */
export const QUERY_TIMEOUT_MS = 120_000;

/** Default CLI stdout cap (bytes). */
export const QUERY_MAX_BUFFER = 512 * 1024 * 1024;

/** Cached dynamic import so a runtime without `node:sqlite` only pays once. */
let sqliteModulePromise;

/** Load `node:sqlite`, or null when the runtime does not provide it. */
async function loadNodeSqlite() {
  if (sqliteModulePromise === undefined) {
    sqliteModulePromise = import('node:sqlite').catch(() => null);
  }
  return sqliteModulePromise;
}

/**
 * Run one read-only query and return plain row objects.
 * @param dbPath - database file path.
 * @param sql - one SELECT-style statement.
 * @param options - timeout / buffer overrides for the CLI fallback.
 * @returns row objects.
 */
export async function queryJsonReadOnly(dbPath, sql, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : QUERY_TIMEOUT_MS;
  const maxBuffer = Number.isFinite(options.maxBuffer) ? options.maxBuffer : QUERY_MAX_BUFFER;

  const sqlite = await loadNodeSqlite();
  if (typeof sqlite?.DatabaseSync === 'function') {
    const database = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    try {
      // node:sqlite returns null-prototype rows; expose plain objects so
      // callers can use Object spread / assert.deepEqual normally.
      return database.prepare(sql).all().map((row) => ({ ...row }));
    } finally {
      database.close();
    }
  }

  return new Promise((resolve, reject) => {
    execFile(
      sqlite3Command(),
      ['-json', sqliteFileUri(dbPath), sql],
      { encoding: 'utf8', timeout: timeoutMs, maxBuffer },
      (error, stdout, stderr) => {
        if (error !== null) {
          const killed = error.killed === true || (error.signal !== undefined && error.signal !== null);
          const details = String(stderr ?? '').trim();
          const reason = killed ? `sqlite3 timed out after ${timeoutMs}ms` : `sqlite3 failed: ${error.message}`;
          reject(new Error(details === '' ? reason : `${reason}: ${details.slice(0, 500)}`));
          return;
        }
        const text = stdout.trim();
        if (text === '') {
          resolve([]);
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (parseError) {
          reject(new Error(`sqlite3 returned non-JSON output: ${String(parseError)}`));
        }
      },
    );
  });
}
