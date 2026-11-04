import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { runCli } from './storm';
import { startAgentEndpoint } from '../src/main/agentEndpoint';
import { QuizStore } from '../src/main/quizStore';
import { QuizService } from '../src/main/quizService';
import { createQuizAgentHandler } from '../src/main/quizAgentHandler';
import {
  QUIZ_INTEGRATION_VERSION,
  QUIZ_REQUIRED_FEATURES,
} from '../src/shared/quizIntegrationVersion';

test('quiz capabilities reaches the app and support updates validate and preserve their structured payload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'storm-cli-learning-'));
  const service = new QuizService(
    new QuizStore(join(dir, 'quiz.json')),
    () => true,
  );
  const handle = createQuizAgentHandler(service, undefined, 'test-app');
  const endpoint = await startAgentEndpoint({
    userDataPath: dir,
    broker: { handle: handle as never },
  });
  const invoke = async (args: string[], payload?: unknown) => {
    let output = '',
      error = '';
    const code = await runCli(
      ['--endpoint', endpoint.metadataPath, 'quiz', ...args],
      {
        ...(payload === undefined
          ? {}
          : { stdin: Readable.from([JSON.stringify(payload)]) }),
        stdout: (value) => {
          output += value;
        },
        stderr: (value) => {
          error += value;
        },
      },
    );
    return { code, output, error };
  };
  try {
    const capabilities = await invoke(['capabilities', '--json']);
    assert.equal(capabilities.code, 0, capabilities.error);
    const value = JSON.parse(capabilities.output).result.value;
    assert.equal(value.integrationVersion, QUIZ_INTEGRATION_VERSION);
    assert.equal(value.appVersion, 'test-app');
    for (const feature of QUIZ_REQUIRED_FEATURES)
      assert.ok(value.features.includes(feature));
    assert.ok(!capabilities.output.includes('agentToken'));
    assert.equal((await invoke(['capabilities', 'unwanted-session'])).code, 2);
    const created = await service.createSession();
    assert.ok(created.ok);
    if (!created.ok) return;
    const attached = await service.attachSession(created.value.id);
    assert.ok(attached.ok);
    if (!attached.ok) return;
    const sessionId = created.value.id,
      agentToken = attached.value.agentToken;
    const posed = await service.request({
      type: 'pose-question',
      sessionId,
      agentToken,
      expectedRevision: 1,
      idempotencyKey: 'pose',
      kind: 'short-answer',
      question: 'Explain.',
      unmodelledReason: 'An exploratory diagnostic.',
    });
    assert.ok(posed.ok);
    if (!posed.ok) return;
    const payload = {
      type: 'support-update',
      expectedRevision: 2,
      questionId: posed.value.currentQuestion!.id,
      support: 'hinted',
      text: 'Check the initial condition.',
    };
    const args = ['request', sessionId, '--token', agentToken];
    for (const invalid of [
      { ...payload, support: 'unknown' },
      { ...payload, questionId: '' },
      { ...payload, text: ' ' },
    ])
      assert.equal((await invoke(args, invalid)).code, 2);
    const updated = await invoke(args, payload);
    assert.equal(updated.code, 0, updated.error);
    assert.equal(
      JSON.parse(updated.output).result.value.currentQuestion.suppliedSupport,
      'hinted',
    );
    assert.equal(
      (await service.getSnapshot(sessionId))!.session.transcript.at(-1)!.text,
      payload.text,
    );
  } finally {
    await endpoint.close();
    await rm(dir, { recursive: true, force: true });
  }
});
