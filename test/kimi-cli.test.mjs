import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

/**
 * The provider resolves its data roots at import time, so point KIMI_CODE_HOME
 * at a temporary CLI data root and import a fresh module instance.
 */
test('Kimi Code CLI sessions appear in list() and load()', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kimi-code-cli-'));
  const projectDir = join(root, 'project');
  mkdirSync(projectDir, { recursive: true });
  const sessionDir = join(root, 'sessions', 'wd_demo_123456789abc', 'cli-session-1');
  mkdirSync(join(sessionDir, 'agents', 'main'), { recursive: true });

  writeFileSync(join(sessionDir, 'state.json'), JSON.stringify({
    title: 'CLI demo session',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
    isCustomTitle: true,
    agents: { main: { type: 'main' } },
  }));
  writeFileSync(join(root, 'session_index.jsonl'), `${JSON.stringify({
    sessionId: 'cli-session-1',
    sessionDir,
    workDir: projectDir,
  })}\n`);
  const wire = [
    { type: 'metadata', protocol_version: '1.4', created_at: 1_767_225_600_000 },
    { type: 'turn.prompt', time: 1_767_225_601_000, input: [{ type: 'text', text: 'hello from CLI' }] },
    { type: 'context.append_loop_event', time: 1_767_225_602_000, event: { type: 'step.begin' } },
    { type: 'context.append_loop_event', time: 1_767_225_603_000, event: { type: 'content.part', part: { type: 'text', text: 'reading the file' } } },
    { type: 'context.append_loop_event', time: 1_767_225_604_000, event: { type: 'tool.call', toolCallId: 'call-1', name: 'Read', args: { path: 'a.txt' } } },
    { type: 'context.append_loop_event', time: 1_767_225_605_000, event: { type: 'tool.result', toolCallId: 'call-1', result: { output: 'file body' } } },
    { type: 'context.append_loop_event', time: 1_767_225_606_000, event: { type: 'step.end' } },
  ].map((record) => JSON.stringify(record)).join('\n');
  writeFileSync(join(sessionDir, 'agents', 'main', 'wire.jsonl'), `${wire}\n`);

  const previous = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = root;
  try {
    const kimi = await import(`../lib/host/providers/kimi.js?cli-test=${Date.now()}`);
    const summaries = await kimi.list();
    const summary = summaries.find((entry) => entry.id === 'cli-session-1');
    assert.ok(summary !== undefined, 'CLI session missing from list()');
    assert.equal(summary.title, 'CLI demo session');
    assert.equal(summary.cwd, projectDir);

    const conversation = await kimi.load('cli-session-1');
    assert.equal(conversation.source, 'kimi');
    assert.equal(conversation.cwd, projectDir);
    assert.equal(conversation.turns.length, 1);
    assert.equal(conversation.turns[0].user.content[0].text, 'hello from CLI');
    assert.equal(conversation.turns[0].runs[0].toolResults[0].output, 'file body');
  } finally {
    if (previous === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previous;
  }
});
