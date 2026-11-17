import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listAgentTranscriptSummaries, loadAgentTranscript } from '../lib/host/cursor-transcripts.js';

function makeTranscript() {
  const root = mkdtempSync(join(tmpdir(), 'cursor-transcripts-'));
  const project = root.slice(1).replaceAll('/', '-');
  const dir = join(root, project, 'agent-transcripts', 'conversation-1');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'conversation-1.jsonl');
  const lines = [
    { role: 'user', message: { content: [{ type: 'text', text: 'Investigate the setup path.' }] } },
    {
      role: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'I will inspect it.' },
          { type: 'tool_use', name: 'read_file', input: { path: 'README.md' } },
        ],
      },
    },
    { role: 'assistant', message: { content: [{ type: 'text', text: 'The setup is npm test.' }] } },
    { type: 'turn_ended', status: 'success' },
  ];
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return { root, file };
}

test('Cursor agent transcripts are listed and normalized', () => {
  const { root, file } = makeTranscript();
  try {
    const summaries = listAgentTranscriptSummaries({ projectsDir: root });
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].id, 'conversation-1');
    assert.equal(summaries[0].messageCount, 3);
    assert.equal(summaries[0].title, 'Investigate the setup path.');
    const conversation = loadAgentTranscript(file, summaries[0]);
    assert.equal(conversation.source, 'cursor');
    assert.equal(conversation.turns.length, 1);
    assert.equal(conversation.turns[0].user.content[0].text, 'Investigate the setup path.');
    const texts = conversation.turns[0].runs.flatMap((run) => run.blocks.map((block) => block.text));
    assert.ok(texts.some((text) => text.includes('read_file')));
    assert.ok(texts.some((text) => text.includes('The setup is npm test.')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
