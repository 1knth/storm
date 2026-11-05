import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeSessions,
  argumentShape,
  errorSignature,
  normalizeError,
} from './analyzeTutorSessions';

const call = (id: string, name: string, args: Record<string, unknown>) => ({
  message: {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: args }],
  },
});
const result = (id: string, text: string, isError = false) => ({
  message: {
    role: 'toolResult',
    toolCallId: id,
    content: [{ type: 'text', text }],
    isError,
  },
});
const oversized = (id: string, secret: string) => [
  call(id, 'storm', { action: 'notes', text: secret.padEnd(6100, '.') }),
  result(
    id,
    `Validation failed for tool "storm":\n  - text: expected at most 4000 characters\n\nReceived arguments:\n{"text":"${secret}"}`,
    true,
  ),
];

test('signatures ignore identifiers and numbers but separate actions', () => {
  const a = normalizeError(
    'invalid-input Operation call_3d11|fc_07d0; session 2b19798c-8764-4430-a5a1-edcd200ef56b at 450',
  );
  const b = normalizeError(
    'invalid-input Operation call_9aa|fc_1; session 11111111-2222-3333-4444-555555555555 at 7',
  );
  assert.equal(a, b);
  assert.notEqual(
    errorSignature('storm:prompt', a),
    errorSignature('storm:message', a),
  );
});

test('echoed arguments and argument values never reach the analysis', () => {
  const analysis = analyzeSessions([oversized('c1', 'learner said hunter2')]);
  const serialized = JSON.stringify(analysis);
  assert.ok(!serialized.includes('hunter2'));
  assert.equal(analysis.signatures[0].shapes[0].shape, 'text:str≤7k');
  assert.equal(
    argumentShape({ action: 'map', nodes: [1, 2], goal: 'x' }),
    'goal:str nodes:arr[2]',
  );
});

test('failures group across sessions and count further failures before recovery', () => {
  const analysis = analyzeSessions([
    [
      ...oversized('c1', 'one'),
      ...oversized('c2', 'two'),
      call('c3', 'storm', { action: 'notes', text: 'short' }),
      result('c3', '{"ok":true}'),
    ],
    [
      ...oversized('c4', 'three'),
      call('c5', 'read', { path: 'x' }),
      result('c5', 'no', true),
    ],
  ]);
  assert.equal(analysis.calls, 4);
  assert.equal(analysis.failures, 3);
  const [notes] = analysis.signatures;
  assert.equal(notes.key, 'storm:notes');
  assert.equal(notes.count, 3);
  assert.equal(notes.sessions, 2);
  assert.equal(notes.recovered, 2);
  assert.equal(notes.meanRetries, 0.5);
});
