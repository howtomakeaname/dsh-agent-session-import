import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import {
  appDataRoot,
  cursorGlobalStorageDir,
  cursorUserDir,
  displayHomePath,
  isAbsoluteFilePath,
  kimiAppSupportCandidates,
  resolveProjectCwd,
  sqlite3Command,
  sqliteFileUri,
  fileUriToPath,
} from '../lib/host/platform.js';

const home = join('/', 'Users', 'demo');

test('application-data roots follow each platform convention', () => {
  assert.equal(appDataRoot({ platform: 'darwin', home }), join(home, 'Library', 'Application Support'));
  assert.equal(appDataRoot({ platform: 'win32', home, env: { APPDATA: 'C:\\Users\\demo\\AppData\\Roaming' } }),
    'C:\\Users\\demo\\AppData\\Roaming');
  assert.equal(appDataRoot({ platform: 'linux', home, env: {} }), join(home, '.config'));
  assert.equal(appDataRoot({ platform: 'linux', home, env: { XDG_CONFIG_HOME: '/tmp/config' } }), '/tmp/config');
});

test('cursor paths use %APPDATA% on Windows and ~/.config on Linux', () => {
  assert.equal(cursorUserDir({ platform: 'win32', home, env: { APPDATA: 'C:\\Roaming' } }), join('C:\\Roaming', 'Cursor', 'User'));
  assert.equal(cursorGlobalStorageDir({ platform: 'linux', home, env: {} }), join(home, '.config', 'Cursor', 'User', 'globalStorage'));
});

test('absolute-path detection accepts POSIX, Windows drive and UNC forms', () => {
  for (const value of ['/tmp/project', 'C:\\work\\project', 'D:/work/project', '\\\\server\\share']) {
    assert.equal(isAbsoluteFilePath(value), true, value);
  }
  for (const value of ['', 'relative/path', './relative', null, undefined]) {
    assert.equal(isAbsoluteFilePath(value), false, String(value));
  }
});

test('project cwd resolution falls back to home for missing or relative paths', () => {
  const stat = (candidate) => {
    if (candidate === '/tmp/ok' || candidate === 'C:\\work') return { isDirectory: () => true };
    throw new Error('ENOENT');
  };
  assert.equal(resolveProjectCwd('/tmp/ok', { home, stat }), '/tmp/ok');
  assert.equal(resolveProjectCwd('C:\\work', { home, stat }), 'C:\\work');
  assert.equal(resolveProjectCwd('relative/dir', { home, stat }), home);
  assert.equal(resolveProjectCwd('/missing', { home, stat }), home);
  assert.equal(resolveProjectCwd(null, { home, stat }), home);
});

test('file URIs convert to native paths, including Windows drive letters', () => {
  assert.equal(fileUriToPath('file:///tmp/project'), '/tmp/project');
  assert.equal(fileUriToPath('file:///C:/Users/demo/project'), 'C:/Users/demo/project');
  assert.equal(fileUriToPath('https://example.com'), null);
});

test('sqlite file URIs are valid on both Windows and POSIX', () => {
  assert.equal(sqliteFileUri('/tmp/x.db'), 'file:/tmp/x.db?mode=ro');
  assert.equal(sqliteFileUri('C:\\tmp\\x.db'), 'file:/C:/tmp/x.db?mode=ro');
});

test('sqlite fallback binary is resolved through PATH or SQLITE3', () => {
  assert.equal(sqlite3Command(), 'sqlite3');
  assert.equal(sqlite3Command({ SQLITE3: 'C:\\tools\\sqlite3.exe' }), 'C:\\tools\\sqlite3.exe');
});

test('Kimi candidates include the Windows roaming and local app-data roots', () => {
  const candidates = kimiAppSupportCandidates({
    platform: 'win32',
    home,
    env: { APPDATA: 'C:\\Roaming', LOCALAPPDATA: 'C:\\Local' },
  });
  assert.ok(candidates.includes(join('C:\\Roaming', 'kimi-desktop')));
  assert.ok(candidates.includes(join('C:\\Local', 'kimi-desktop')));
});

test('home directories render as ~ in status text', () => {
  assert.equal(displayHomePath(join(home, 'Library', 'Application Support'), home), join('~', 'Library', 'Application Support'));
  assert.equal(displayHomePath('/opt/data', home), '/opt/data');
});
