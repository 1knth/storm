import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCli } from './storm';
import { startAgentEndpoint } from '../src/main/agentEndpoint';

type Event = { cursor: number; revision: number; type: string; data: unknown };
function snapshot(events: Event[] = [], status = 'connected') {
  return {
    session: {
      id: 'quiz-1',
      revision: 1,
      eventCursor: events.at(-1)?.cursor ?? 0,
      status,
    },
    events,
  };
}

async function runWait(
  snapshots: ReturnType<typeof snapshot>[],
  timeout: number,
) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'storm-quiz-wait-'));
  let calls = 0;
  const endpoint = await startAgentEndpoint({
    userDataPath: path.join(scratch, 'profile'),
    broker: {
      handle: async (request: any) => {
        assert.equal(request.type, 'quiz');
        assert.equal(request.operation, 'snapshot');
        const responseSnapshot =
          snapshots[Math.min(calls, snapshots.length - 1)];
        calls++;
        return {
          protocol: 1,
          requestId: request.requestId,
          ok: true,
          type: 'quiz',
          operation: 'snapshot',
          snapshot: responseSnapshot,
        };
      },
    },
  });
  let output = '';
  let error = '';
  try {
    const code = await runCli(
      [
        '--endpoint',
        endpoint.metadataPath,
        'quiz',
        'wait',
        'quiz-1',
        '--token',
        'secret',
        '--after',
        '0',
        '--timeout',
        String(timeout),
      ],
      {
        home: scratch,
        stdout: (text) => (output += text),
        stderr: (text) => (error += text),
      },
    );
    return {
      code,
      output: JSON.parse(output),
      error,
      calls,
    };
  } finally {
    await endpoint.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

test('quiz wait returns learner activity from the broker snapshot field', async () => {
  const result = await runWait(
    [
      snapshot([
        { cursor: 1, revision: 1, type: 'agent-message', data: {} },
        { cursor: 2, revision: 1, type: 'answer', data: { choiceId: 'a' } },
      ]),
    ],
    0,
  );
  assert.equal(result.code, 0, result.error);
  assert.equal(result.output.timedOut, false);
  assert.equal(result.output.after, 2);
  assert.equal(result.calls, 1);
});

test('quiz wait treats a prompt response as learner activity', async () => {
  const result = await runWait(
    [
      snapshot([
        { cursor: 1, revision: 1, type: 'agent-message', data: {} },
        {
          cursor: 2,
          revision: 2,
          type: 'respond-prompt',
          data: { choiceId: 'continue' },
        },
      ]),
    ],
    0,
  );
  assert.equal(result.code, 0, result.error);
  assert.equal(result.output.timedOut, false);
  assert.equal(result.output.after, 2);
  assert.equal(result.calls, 1);
});

test('quiz wait ignores agent events until learner activity arrives', async () => {
  const result = await runWait(
    [
      snapshot([{ cursor: 1, revision: 1, type: 'agent-message', data: {} }]),
      snapshot([{ cursor: 2, revision: 2, type: 'learner-message', data: {} }]),
    ],
    2,
  );
  assert.equal(result.code, 0, result.error);
  assert.equal(result.output.timedOut, false);
  assert.equal(result.output.after, 2);
  assert.equal(result.calls, 2);
});

test('quiz wait with timeout zero polls once and returns latest cursor', async () => {
  const result = await runWait(
    [
      snapshot([
        { cursor: 7, revision: 1, type: 'agent-message', data: {} },
        { cursor: 9, revision: 1, type: 'feedback', data: {} },
      ]),
    ],
    0,
  );
  assert.equal(result.code, 0, result.error);
  assert.equal(result.output.timedOut, true);
  assert.equal(result.output.after, 9);
  assert.equal(result.calls, 1);
});

test('quiz wait returns disconnected status from the broker snapshot field', async () => {
  const result = await runWait([snapshot([], 'disconnected')], 0);
  assert.equal(result.code, 0, result.error);
  assert.equal(result.output.disconnected, true);
  assert.equal(result.calls, 1);
});

test('quiz wait wakes for learner Skip and ignores agent skip-question events', async () => {
  const result = await runWait(
    [
      snapshot([
        {
          cursor: 1,
          revision: 1,
          type: 'skip-question',
          data: { questionId: 'q1' },
        },
      ]),
      snapshot([
        { cursor: 2, revision: 2, type: 'skip', data: { questionId: 'q2' } },
      ]),
    ],
    2,
  );
  assert.equal(result.code, 0, result.error);
  assert.equal(result.output.timedOut, false);
  assert.equal(result.output.after, 2);
  assert.equal(result.calls, 2);
});
