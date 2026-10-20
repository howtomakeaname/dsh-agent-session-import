import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { sqliteFileUri } from '../lib/host/platform.js';
import { queryJsonReadOnly } from '../lib/host/sqlite.js';

test('sqliteFileUri normalizes Windows and POSIX paths', () => {
  assert.equal(sqliteFileUri('/tmp/data.db'), 'file:/tmp/data.db?mode=ro');
  assert.equal(sqliteFileUri('C:\\Users\\demo\\data.db'), 'file:/C:/Users/demo/data.db?mode=ro');
});

test('queryJsonReadOnly reads a real SQLite database through node:sqlite', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-sqlite-'));
  const databasePath = join(directory, 'fixture.db');

  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  database.exec("INSERT INTO items (name) VALUES ('alpha'), ('beta')");
  database.close();

  const rows = await queryJsonReadOnly(databasePath, 'SELECT id, name FROM items ORDER BY id');
  assert.deepEqual(rows, [
    { id: 1, name: 'alpha' },
    { id: 2, name: 'beta' },
  ]);
});
