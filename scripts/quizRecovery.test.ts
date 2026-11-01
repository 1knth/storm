import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuizService } from '../src/main/quizService';
import { QuizStore } from '../src/main/quizStore';
import { createQuizAgentHandler } from '../src/main/quizAgentHandler';
import { startAgentEndpoint } from '../src/main/agentEndpoint';
import { AgentBroker } from '../src/main/agentBroker';
import { runCli } from './storm';

test('compact CLI recovery, event waiting, and chunked history round-trip through an isolated endpoint', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'storm-compact-cli-'));
  const service = new QuizService(
    new QuizStore(join(dir, 'quiz.json')),
    () => true,
  );
  const created = await service.createSession();
  if (!created.ok) throw new Error('Create failed');
  const handle = createQuizAgentHandler(service);
  const endpoint = await startAgentEndpoint({
    userDataPath: dir,
    broker: new AgentBroker({
      resolveTarget: async () => {
        throw new Error('Quiz recovery must not resolve notes');
      },
      renderer: {
        dispatch: async () => ({
          ok: false,
          code: 'UNEXPECTED',
          message: 'Quiz recovery must not edit notes',
        }),
      },
      quiz: handle,
    }),
  });
  async function cli(args: string[], chunks: Buffer[] = []) {
    let stdout = '',
      stderr = '';
    const code = await runCli(
      ['--endpoint', endpoint.metadataPath, 'quiz', ...args],
      {
        stdin: (async function* () {
          yield* chunks;
        })(),
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      },
    );
    assert.equal(code, 0, stderr);
    return JSON.parse(stdout);
  }
  try {
    const attached = (await cli(['attach', created.value.id, '--compact']))
      .result.value;
    const token = attached.agentToken;
    assert.equal(attached.snapshot.recovery.pendingAction, 'start-session');
    const text = 'café 🧠 explanation';
    const request = Buffer.from(
      JSON.stringify({
        type: 'agent-message',
        expectedRevision: attached.snapshot.session.revision,
        text,
      }),
    );
    const split = request.indexOf(Buffer.from('é')) + 1;
    await cli(
      ['request', created.value.id, '--token', token],
      [request.subarray(0, split), request.subarray(split)],
    );
    const status = await cli([
      'status',
      created.value.id,
      '--token',
      token,
      '--compact',
    ]);
    assert.equal(status.snapshot.recovery.history.entries[0].text, text);
    const chunk = await cli([
      'context',
      created.value.id,
      '--token',
      token,
      '--section',
      'history',
      '--before',
      '1',
      '--offset',
      '0',
    ]);
    assert.equal(JSON.parse(chunk.result.value.text).text, text);
    const waited = await cli([
      'wait',
      created.value.id,
      '--token',
      token,
      '--after',
      String(status.snapshot.session.eventCursor),
      '--timeout',
      '0',
      '--compact',
    ]);
    assert.equal(waited.timedOut, true);
    assert.deepEqual(waited.snapshot.events, []);
    assert.deepEqual(waited.snapshot.session.transcript, []);
    assert.equal(waited.snapshot.recovery, undefined);
    const full = await cli(['status', created.value.id, '--token', token]);
    assert.equal(full.snapshot.session.transcript[0].text, text);
    await cli([
      'activity',
      created.value.id,
      '--token',
      token,
      '--state',
      'thinking',
    ]);
    assert.equal(
      (await service.getSnapshot(created.value.id))!.session.activity!.state,
      'thinking',
    );
    await cli(['detach', created.value.id, '--token', token]);
    assert.equal(
      (await service.getSnapshot(created.value.id))!.session.status,
      'disconnected',
    );
  } finally {
    await endpoint.close();
    await rm(dir, { recursive: true, force: true });
  }
});
