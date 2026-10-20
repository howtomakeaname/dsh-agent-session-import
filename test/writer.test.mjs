import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSessionPlan } from '../lib/host/writer.js';

const conversation = {
  source: 'demo',
  id: 'conversation-1',
  title: 'Demo conversation',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_100_000,
  cwd: '/tmp/demo',
  messageCount: 2,
  turns: [
    {
      at: 1_700_000_000_000,
      user: { content: [{ type: 'text', text: 'please read a file' }] },
      runs: [
        {
          at: 1_700_000_001_000,
          blocks: [
            { type: 'reasoning', text: 'need the file first' },
            { type: 'tool-call', id: 'call id/1', name: 'read_file', arguments: '{"path":"a.txt"}' },
            { type: 'text', text: 'done' },
          ],
          toolResults: [
            { callId: 'call id/1', name: 'read_file', arguments: '{"path":"a.txt"}', output: 'file body', isError: false, at: 1_700_000_002_000 },
          ],
        },
      ],
    },
  ],
};

const options = { cwd: '/tmp/demo', sourceLabel: 'Demo Agent' };

test('faithful plan keeps structured reasoning and tool lifecycle', () => {
  const plan = buildSessionPlan(conversation, { ...options, mode: 'full' });
  assert.equal(plan.mode, 'full');
  const system = plan.events.find((event) => event.type === 'system/message');
  assert.deepEqual(system.data.message.content, []);

  const user = plan.events.find((event) => event.type === 'user/message');
  assert.match(user.data.content[0].text, /【导入说明】.*Demo Agent/);

  const calls = plan.events.filter((event) => event.type === 'tool/call');
  const results = plan.events.filter((event) => event.type === 'tool/result');
  assert.equal(calls.length, 1);
  assert.equal(results.length, 1);
  assert.equal(calls[0].data.callId, results[0].data.message.toolCallId);

  const assistant = plan.events.filter((event) => event.type === 'assistant/message').flatMap((event) => event.data.message.content);
  assert.ok(assistant.some((block) => block.type === 'reasoning'));
  assert.ok(assistant.some((block) => block.type === 'tool-call'));
  assert.ok(assistant.some((block) => block.type === 'text'));
});

test('resume-safe plan flattens content into text without wire events', () => {
  const plan = buildSessionPlan(conversation, { ...options, mode: 'compatible' });
  assert.equal(plan.mode, 'compatible');
  assert.equal(plan.events.filter((event) => event.type === 'tool/call').length, 0);
  assert.equal(plan.events.filter((event) => event.type === 'tool/result').length, 0);

  const text = plan.events
    .filter((event) => event.type === 'assistant/message')
    .flatMap((event) => event.data.message.content)
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  assert.match(text, /【思考】need the file first/);
  assert.match(text, /\[工具调用\] read_file/);
  assert.match(text, /\[工具结果\] file body/);
});

test('tool call ids are sanitized consistently', () => {
  const plan = buildSessionPlan(conversation, { ...options, mode: 'full' });
  for (const event of plan.events) {
    const id = event.type === 'tool/call'
      ? event.data.callId
      : event.type === 'tool/result'
        ? event.data.message.toolCallId
        : null;
    if (id !== null) assert.match(id, /^[A-Za-z0-9_-]+$/);
  }
});
