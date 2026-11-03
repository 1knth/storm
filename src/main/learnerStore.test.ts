import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuizService } from './quizService';
import { QuizStore } from './quizStore';
import { LearnerStore, learnerScopeKey } from './learnerStore';
import { createQuizAgentHandler } from './quizAgentHandler';

const scope = {
  vaultId: 'vault',
  notePath: 'loops.md',
  selectedNotePaths: [],
  folderPath: null,
};

async function fixture(
  record?: (
    store: LearnerStore,
  ) => ConstructorParameters<typeof QuizService>[5],
) {
  const dir = await mkdtemp(join(tmpdir(), 'storm-learner-'));
  const learner = new LearnerStore(join(dir, 'learner.json'));
  const store = new QuizStore(join(dir, 'sessions.json'));
  const service = new QuizService(
    store,
    () => true,
    undefined,
    undefined,
    undefined,
    record
      ? record(learner)
      : (session, question) => learner.recordQuestion(session, question),
  );
  const created = await service.createSession(scope);
  if (!created.ok) throw new Error('create failed');
  const attached = await service.attachSession(created.value.id);
  if (!attached.ok) throw new Error('attach failed');
  const sessionId = created.value.id;
  const agentToken = attached.value.agentToken;
  let revision = attached.value.snapshot.session.revision;
  let key = 0;
  const agent = async (fields: Record<string, unknown>) => {
    const result = await service.request({
      sessionId,
      agentToken,
      expectedRevision: revision,
      idempotencyKey: `k${++key}`,
      ...fields,
    } as never);
    if (result.ok) revision = result.value.revision;
    return result;
  };
  const learnerAction = async (fields: Record<string, unknown>) => {
    const result = await service.learnerRequest({
      sessionId,
      expectedRevision: revision,
      idempotencyKey: `k${++key}`,
      ...fields,
    } as never);
    if (result.ok) revision = result.value.revision;
    return result;
  };
  const question = {
    type: 'pose-question',
    question: 'Which loop repeats until the player says no?',
    choices: [
      { id: 'a', text: 'while' },
      { id: 'b', text: 'for' },
    ],
  };
  return {
    dir,
    learner,
    service,
    sessionId,
    agentToken,
    agent,
    learnerAction,
    question,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test('a tagged, rated, graded answer becomes one learner attempt', async () => {
  const f = await fixture();
  try {
    const posed = await f.agent({
      ...f.question,
      concepts: ['while-loop'],
      level: 'apply',
      support: 'hinted',
    });
    assert.equal(posed.ok, true);
    if (!posed.ok) return;
    assert.deepEqual(posed.value.currentQuestion?.learning, {
      concepts: ['while-loop'],
      level: 'apply',
      support: 'hinted',
    });
    const answered = await f.learnerAction({
      type: 'answer',
      choiceId: 'a',
      reasoning: '',
      confidence: 85,
    });
    assert.equal(answered.ok, true);
    if (!answered.ok) return;
    assert.equal(answered.value.currentQuestion?.confidence, 85);
    const snapshot = await f.service.getSnapshot(f.sessionId);
    const answerEvent = snapshot?.events.findLast((e) => e.type === 'answer');
    assert.equal(
      (answerEvent?.data as { confidence?: number } | undefined)?.confidence,
      85,
    );

    const feedback = {
      type: 'feedback',
      text: 'Right: the condition is checked before each round.',
      verdict: 'correct',
    };
    assert.equal((await f.agent(feedback)).ok, true);
    const attempts = await f.learner.attempts(learnerScopeKey(scope));
    assert.equal(attempts.length, 1);
    assert.deepEqual(
      {
        concepts: attempts[0]!.concepts,
        level: attempts[0]!.level,
        support: attempts[0]!.support,
        verdict: attempts[0]!.verdict,
        confidence: attempts[0]!.confidence,
      },
      {
        concepts: ['while-loop'],
        level: 'apply',
        support: 'hinted',
        verdict: 'correct',
        confidence: 85,
      },
    );
    const state = await f.learner.state(scope);
    assert.equal(state.concepts[0]!.id, 'while-loop');
    assert.equal(state.concepts[0]!.inScope, true);
    assert.equal(state.calibration.rated, 1);
  } finally {
    await f.cleanup();
  }
});

test('untagged questions and verdict-free feedback are not modelled', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.agent(f.question)).ok, true);
    await f.learnerAction({ type: 'answer', choiceId: 'a', reasoning: '' });
    await f.agent({ type: 'feedback', text: 'Good.', verdict: 'correct' });
    await f.learnerAction({ type: 'continue' });
    await f.agent({ ...f.question, concepts: ['loops'], level: 'recall' });
    await f.learnerAction({ type: 'answer', choiceId: 'a', reasoning: '' });
    await f.agent({ type: 'feedback', text: 'Let us discuss.' });
    assert.deepEqual(await f.learner.attempts(learnerScopeKey(scope)), []);
  } finally {
    await f.cleanup();
  }
});

test('invalid learning tags and confidence values are rejected', async () => {
  const f = await fixture();
  try {
    for (const tags of [
      { concepts: ['While Loop'], level: 'apply' },
      { concepts: ['loops'] },
      { level: 'apply' },
      { support: 'hinted' },
      { concepts: ['a', 'b', 'c', 'd'], level: 'apply' },
      { concepts: ['a', 'a'], level: 'apply' },
      { concepts: ['a'], level: 'expert' },
      { concepts: ['a'], level: 'apply', support: 'cheat' },
    ])
      assert.deepEqual(await f.agent({ ...f.question, ...tags }), {
        ok: false,
        error: 'invalid-input',
      });
    const posed = await f.agent({
      ...f.question,
      concepts: ['loops'],
      level: 'recall',
    });
    assert.equal(
      posed.ok && posed.value.currentQuestion?.learning?.support,
      'independent',
    );
    for (const confidence of [101, -1, 2.5, '80'])
      assert.deepEqual(
        await f.learnerAction({
          type: 'answer',
          choiceId: 'a',
          reasoning: '',
          confidence,
        }),
        { ok: false, error: 'invalid-input' },
      );
  } finally {
    await f.cleanup();
  }
});

test('a learner-model failure does not fail the accepted feedback write', async () => {
  const f = await fixture(() => async () => {
    throw new Error('disk full');
  });
  try {
    await f.agent({ ...f.question, concepts: ['loops'], level: 'recall' });
    await f.learnerAction({ type: 'answer', choiceId: 'a', reasoning: '' });
    const feedback = await f.agent({
      type: 'feedback',
      text: 'Correct.',
      verdict: 'correct',
    });
    assert.equal(feedback.ok, true);
    assert.equal(
      feedback.ok && feedback.value.currentQuestion?.status,
      'feedback',
    );
  } finally {
    await f.cleanup();
  }
});

test('records are idempotent by question and persisted with private permissions', async () => {
  const f = await fixture();
  try {
    await f.agent({ ...f.question, concepts: ['loops'], level: 'recall' });
    await f.learnerAction({ type: 'answer', choiceId: 'a', reasoning: '' });
    await f.agent({ type: 'feedback', text: 'Correct.', verdict: 'correct' });
    const [first] = await f.learner.attempts(learnerScopeKey(scope));
    await f.learner.record(learnerScopeKey(scope), {
      ...first!,
      verdict: 'partial',
    });
    const attempts = await f.learner.attempts(learnerScopeKey(scope));
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.verdict, 'partial');
    const saved = JSON.parse(
      await readFile(join(f.dir, 'learner.json'), 'utf8'),
    );
    assert.equal(saved.version, 1);
  } finally {
    await f.cleanup();
  }
});

test('the agent learner operation requires the session capability', async () => {
  const f = await fixture();
  try {
    const handler = createQuizAgentHandler(f.service, (s) =>
      f.learner.state(s),
    );
    const base = {
      protocol: 1 as const,
      requestId: 'r1',
      type: 'quiz' as const,
      operation: 'learner' as const,
      sessionId: f.sessionId,
    };
    const denied = await handler({ ...base, agentToken: 'wrong' });
    assert.deepEqual('result' in denied && denied.result, {
      ok: false,
      error: 'unauthorized',
    });
    const allowed = await handler({ ...base, agentToken: f.agentToken });
    assert.equal('result' in allowed && allowed.result.ok, true);
    assert.equal(
      'result' in allowed &&
        allowed.result.ok &&
        (allowed.result.value as { scopeKey: string }).scopeKey,
      'vault:vault',
    );
  } finally {
    await f.cleanup();
  }
});
