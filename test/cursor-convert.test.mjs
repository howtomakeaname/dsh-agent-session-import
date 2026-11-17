import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConversation } from '../lib/host/convert.js';

const userBubble = (id, text) => ({ bubbleId: id, value: { type: 1, text, startedAtMs: 100 } });

test('V3+ tool data is read from toolFormerData on the bubble', () => {
  const loaded = {
    composerId: 'composer-v3',
    header: { createdAt: 1 },
    data: {
      _v: 18,
      fullConversationHeadersOnly: [
        { bubbleId: 'u1', type: 1 },
        { bubbleId: 'a1', type: 2 },
      ],
      capabilities: null,
    },
    bubbles: [
      userBubble('u1', 'read the file'),
      {
        bubbleId: 'a1',
        value: {
          type: 2,
          capabilityType: 15,
          toolFormerData: { name: 'read_file', rawArgs: '{"path":"a.js"}', result: 'ok', status: 'success' },
          startedAtMs: 200,
        },
      },
    ],
  };
  const conversation = normalizeConversation(loaded, { id: 'composer-v3', title: 'v3' });
  assert.equal(conversation.turns.length, 1);
  const run = conversation.turns[0].runs[0];
  assert.equal(run.blocks[0].type, 'tool-call');
  assert.equal(run.blocks[0].name, 'read_file');
  assert.equal(run.toolResults[0].output, 'ok');
});

test('V1 tool data falls back to composerData capabilities.bubbleDataMap', () => {
  const loaded = {
    composerId: 'composer-v1',
    header: { createdAt: 1 },
    data: {
      _v: 1,
      fullConversationHeadersOnly: [
        { bubbleId: 'u1', type: 1 },
        { bubbleId: 'a1', type: 2 },
      ],
      capabilities: [
        {
          data: {
            bubbleDataMap: {
              a1: { name: 'grep', rawArgs: '{"pattern":"x"}', result: 'found', status: 'success' },
            },
          },
        },
      ],
    },
    bubbles: [
      userBubble('u1', 'search for x'),
      { bubbleId: 'a1', value: { type: 2, capabilityType: 15, startedAtMs: 200 } },
    ],
  };
  const conversation = normalizeConversation(loaded, { id: 'composer-v1', title: 'v1' });
  const run = conversation.turns[0].runs[0];
  assert.equal(run.blocks[0].type, 'tool-call');
  assert.equal(run.blocks[0].name, 'grep');
  assert.equal(run.toolResults[0].output, 'found');
});

test('V1 bubbleDataMap encoded as a JSON string is accepted', () => {
  const loaded = {
    composerId: 'composer-v1-string',
    header: { createdAt: 1 },
    data: {
      _v: 2,
      fullConversationHeadersOnly: [{ bubbleId: 'u1', type: 1 }, { bubbleId: 'a1', type: 2 }],
      capabilities: [{ data: { bubbleDataMap: JSON.stringify({ a1: { name: 'edit', rawArgs: '{}', result: 'done' } }) } }],
    },
    bubbles: [userBubble('u1', 'edit it'), { bubbleId: 'a1', value: { type: 2, capabilityType: 15 } }],
  };
  const conversation = normalizeConversation(loaded, { id: 'composer-v1-string', title: 'v1 string' });
  assert.equal(conversation.turns[0].runs[0].blocks[0].name, 'edit');
});

test('Cursor 3.30 /t: sub-bubble keys keep the tool call id', () => {
  const loaded = {
    composerId: 'composer-suffix',
    header: { createdAt: 1 },
    data: { _v: 18, fullConversationHeadersOnly: [], capabilities: null },
    bubbles: [
      userBubble('u1', 'run it'),
      {
        bubbleId: 'a1/t:toolu_123',
        value: { type: 2, capabilityType: 15, toolFormerData: { name: 'run', rawArgs: '{}', result: 'ok' }, startedAtMs: 200 },
      },
    ],
  };
  const conversation = normalizeConversation(loaded, { id: 'composer-suffix', title: 'suffix' });
  const tool = conversation.turns[0].runs[0].blocks.find((block) => block.type === 'tool-call');
  assert.equal(tool?.id, 'toolu_123');
});
