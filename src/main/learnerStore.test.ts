import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuizService } from './quizService';
import { QuizStore } from './quizStore';
import { LearnerStore, learnerScopeKey } from './learnerStore';
import {
  quizFixture,
  QuizSessionDriver,
  quizValue,
  FailingQuizStore,
  quizScope as scope,
} from './quizTestFixtures';
import { createQuizAgentHandler } from './quizAgentHandler';

async function fixture() {
  const shared = await quizFixture({
    scope,
    connected: true,
    learning: true,
    fileName: 'sessions.json',
    store: (path) => new FailingQuizStore(path),
  });
  const { dir, learner, store, service, driver } = shared;
  const sessionId = driver.id;
  const agentToken = driver.agentToken;
  const agent = (fields: Record<string, unknown>) => driver.agentInput(fields);
  const learnerAction = (fields: Record<string, unknown>) =>
    driver.learnerInput(fields);
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
    store,
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

test('failed publication commits neither feedback nor attempts; retry commits both', async () => {
  const f = await fixture();
  try {
    await f.agent({ ...f.question, concepts: ['loops'], level: 'recall' });
    await f.learnerAction({ type: 'answer', choiceId: 'a', reasoning: '' });
    f.store.fail = true;
    assert.equal(
      (
        await f.agent({
          type: 'feedback',
          text: 'Correct.',
          verdict: 'correct',
        })
      ).ok,
      false,
    );
    assert.equal((await f.learner.attempts(learnerScopeKey(scope))).length, 0);
    assert.equal(
      (await f.store.get(f.sessionId))?.currentQuestion?.status,
      'answered',
    );
    f.store.fail = false;
    assert.ok(
      (
        await f.agent({
          type: 'feedback',
          text: 'Correct.',
          verdict: 'correct',
        })
      ).ok,
    );
    assert.equal((await f.learner.attempts(learnerScopeKey(scope))).length, 1);
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

test('rated untagged grades calibrate without inventing concepts or independence', async () => {
  const f = await fixture();
  try {
    await f.agent(f.question);
    await f.learnerAction({
      type: 'answer',
      choiceId: 'a',
      reasoning: '',
      confidence: 80,
    });
    await f.agent({
      type: 'feedback',
      text: 'A useful distinction.',
      verdict: 'partial',
    });
    const [attempt] = await f.learner.attempts(learnerScopeKey(scope));
    assert.deepEqual(attempt?.concepts, []);
    assert.equal(attempt?.level, 'recall');
    assert.equal(attempt?.support, 'unknown');
    const state = await f.learner.state(scope);
    assert.equal(state.calibration.rated, 1);
    assert.equal(state.calibration.accuracy, 50);
    assert.deepEqual(state.concepts, []);
    assert.equal(state.diagnostics.ratedUntagged, 1);
    assert.equal(f.service.learnerRecordingDiagnostics().unmodelled, 1);
  } finally {
    await f.cleanup();
  }
});

test('help updates retain strongest supplied support through answer, grade and recovery', async () => {
  const f = await fixture();
  try {
    const posed = await f.agent({
      ...f.question,
      concepts: ['loops'],
      level: 'apply',
    });
    assert.ok(posed.ok);
    if (!posed.ok) return;
    const questionId = posed.value.currentQuestion!.id;
    const revision = posed.value.revision;
    assert.deepEqual(
      await f.agent({
        type: 'support-update',
        questionId: 'other',
        support: 'worked',
        text: 'Example',
      }),
      { ok: false, error: 'invalid-state' },
    );
    assert.deepEqual(
      await f.agent({
        type: 'support-update',
        questionId,
        support: 'unknown',
        text: 'Example',
      }),
      { ok: false, error: 'invalid-input' },
    );
    assert.deepEqual(
      await f.agent({
        type: 'support-update',
        questionId,
        support: 'hinted',
        text: ' ',
      }),
      { ok: false, error: 'invalid-input' },
    );
    for (const support of ['hinted', 'worked', 'independent']) {
      const result = await f.agent({
        type: 'support-update',
        questionId,
        support,
        text: `Supplied ${support} explanation.`,
      });
      assert.ok(result.ok);
      if (result.ok)
        assert.equal(
          result.value.currentQuestion?.learning?.support,
          support === 'hinted' ? 'hinted' : 'worked',
        );
    }
    const helped = await f.service.getSnapshot(f.sessionId);
    assert.equal(helped?.session.revision, revision + 3);
    assert.equal(
      helped?.session.transcript[0]?.question?.learning?.support,
      'worked',
    );
    await f.learnerAction({
      type: 'answer',
      choiceId: 'a',
      reasoning: '',
      confidence: 95,
    });
    assert.deepEqual(
      await f.agent({
        type: 'support-update',
        questionId,
        support: 'worked',
        text: 'Too late',
      }),
      { ok: false, error: 'invalid-state' },
    );
    await f.agent({
      type: 'feedback',
      verdict: 'correct',
      text: 'Check the condition again on your own later.',
    });
    await f.learnerAction({ type: 'continue' });
    await f.service.reconcileLearner(f.sessionId);
    const attempts = await f.learner.attempts(learnerScopeKey(scope));
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.support, 'worked');
    const state = await f.learner.state(scope);
    assert.equal(state.concepts[0]?.evidence.independent, 0);
  } finally {
    await f.cleanup();
  }
});

test('restart after Continue reads committed facts at the original grade time without recording', async () => {
  const f = await fixture();
  try {
    await f.agent({ ...f.question, concepts: ['loops'], level: 'recall' });
    await f.learnerAction({
      type: 'answer',
      choiceId: 'a',
      reasoning: '',
      confidence: 90,
    });
    const feedback = await f.agent({
      type: 'feedback',
      text: 'Correct.',
      verdict: 'correct',
    });
    assert.ok(feedback.ok);
    if (!feedback.ok) return;
    const at = feedback.value.currentQuestion!.gradedAt;
    await f.learnerAction({ type: 'continue' });
    const learner = new LearnerStore(join(f.dir, 'learner.json'));
    const store = new QuizStore(join(f.dir, 'sessions.json'));
    const restarted = new QuizService(
      store,
      () => true,
      undefined,
      undefined,
      undefined,
      learner,
    );
    await restarted.listSessions();
    await Promise.all([
      restarted.reconcileLearner(f.sessionId),
      restarted.reconcileLearner(f.sessionId),
    ]);
    const attempts = await learner.attempts(learnerScopeKey(scope));
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].at, at);
  } finally {
    await f.cleanup();
  }
});

test('lost feedback acknowledgement retries do not duplicate committed facts', async () => {
  const f = await fixture();
  try {
    await f.agent({ ...f.question, concepts: ['loops'], level: 'recall' });
    await f.learnerAction({
      type: 'answer',
      choiceId: 'a',
      reasoning: '',
      confidence: 60,
    });
    const before = (await f.store.get(f.sessionId))!;
    const request = {
      type: 'feedback' as const,
      text: 'Correct.',
      verdict: 'correct' as const,
      sessionId: f.sessionId,
      agentToken: f.agentToken,
      expectedRevision: before.revision,
      idempotencyKey: 'uncertain',
    };
    assert.ok((await f.service.request(request)).ok);
    assert.ok((await f.service.request(request)).ok);
    assert.equal((await f.learner.attempts(learnerScopeKey(scope))).length, 1);
    assert.equal(
      (await f.store.get(f.sessionId))!.transcript.filter(
        (message) => message.question?.verdict,
      ).length,
      1,
    );
  } finally {
    await f.cleanup();
  }
});

test('unscoped learner pools stay isolated and ignore the legacy global unscoped pool', async () => {
  const f = await fixture();
  try {
    const grade = async (confidence: number) => {
      const created = await f.service.createSession();
      assert.ok(created.ok);
      if (!created.ok) throw new Error('create');
      const attached = await f.service.attachSession(created.value.id);
      assert.ok(attached.ok);
      if (!attached.ok) throw new Error('attach');
      const sessionId = created.value.id,
        agentToken = attached.value.agentToken;
      const posed = await f.service.request({
        sessionId,
        agentToken,
        expectedRevision: 1,
        idempotencyKey: 'pose',
        type: 'pose-question',
        question: 'Recall',
        kind: 'short-answer',
        concepts: ['loops'],
        level: 'recall',
      });
      assert.ok(posed.ok);
      const answer = await f.service.learnerRequest({
        sessionId,
        expectedRevision: 2,
        idempotencyKey: 'answer',
        type: 'answer',
        answer: 'text',
        confidence,
      });
      assert.ok(answer.ok);
      assert.ok(
        (
          await f.service.request({
            sessionId,
            agentToken,
            expectedRevision: 3,
            idempotencyKey: 'feedback',
            type: 'feedback',
            text: 'Discuss.',
            verdict: 'correct',
          })
        ).ok,
      );
      return { sessionId, agentToken };
    };
    const a = await grade(20),
      b = await grade(95);
    const [old] = await f.learner.attempts(
      learnerScopeKey(undefined, a.sessionId),
    );
    await writeFile(
      join(f.dir, 'learner.json'),
      JSON.stringify({
        version: 1,
        scopes: {
          unscoped: { attempts: [{ ...old!, id: 'legacy', confidence: 50 }] },
        },
      }),
    );
    const handler = createQuizAgentHandler(f.service, (s, id) =>
      f.learner.state(s, id),
    );
    for (const [session, confidence] of [
      [a, 20],
      [b, 95],
    ] as const) {
      const response = await handler({
        protocol: 1,
        requestId: 'r',
        type: 'quiz',
        operation: 'learner',
        ...session,
      });
      assert.ok('result' in response && response.result.ok);
      if ('result' in response && response.result.ok) {
        const state = response.result.value as any;
        assert.equal(state.scopeKey, `session:${session.sessionId}`);
        assert.equal(state.attempts.total, 1);
        assert.equal(state.calibration.meanConfidence, confidence);
      }
    }
  } finally {
    await f.cleanup();
  }
});

test('large legacy transcript import is bounded and repeated learner reads perform no writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'storm-batch-replay-'));
  try {
    const at = '2026-11-01T09:00:00.000Z';
    const history = Array.from({ length: 2000 }, (_, i) => ({
      id: `m${i}`,
      role: 'agent',
      text: 'Feedback',
      createdAt: at,
      question: {
        id: `q${i}`,
        prompt: 'Practice',
        choices: [],
        verdict: 'correct',
        confidence: 80,
        learning: {
          concepts: ['loops'],
          level: 'recall',
          support: 'independent',
        },
        gradedAt: at,
      },
    }));
    const session = {
      id: 'history',
      agentToken: 'synthetic',
      scope,
      revision: 0,
      eventCursor: 0,
      status: 'waiting-agent',
      transcript: history,
      currentQuestion: null,
      freeChatDraft: '',
      createdAt: at,
      updatedAt: at,
    };
    await writeFile(
      join(dir, 'sessions.json'),
      JSON.stringify({
        version: 1,
        sessions: [session],
        events: { history: [] },
        idempotency: {},
      }),
    );
    const learner = new LearnerStore(join(dir, 'learner.json'));
    const store = new QuizStore(join(dir, 'sessions.json'));
    const service = new QuizService(
      store,
      () => true,
      undefined,
      undefined,
      undefined,
      learner,
    );
    await service.listSessions();
    const manifest = await readFile(join(dir, 'sessions.json'), 'utf8');
    for (let i = 0; i < 10; i++) await service.reconcileLearner('history');
    assert.equal(
      await readFile(join(dir, 'sessions.json'), 'utf8'),
      manifest,
      'learner reads must not write',
    );
    const attempts = await learner.attempts(learnerScopeKey(scope));
    assert.equal(attempts.length, 2000);
    assert.ok(attempts.every((attempt) => attempt.at === at));
    const fresh = new LearnerStore(join(dir, 'learner.json'));
    await fresh.connect(new QuizStore(join(dir, 'sessions.json')));
    assert.deepEqual(await fresh.attempts(learnerScopeKey(scope)), attempts);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('legacy learner facts import once, retain deleted-session evidence, and ignore later legacy edits', async () => {
  const f = await fixture();
  try {
    const path = join(f.dir, 'legacy.json');
    const attempt = {
      id: 'legacy-question',
      sessionId: 'deleted',
      scopeSignature: 'old',
      at: '2026-01-01T00:00:00.000Z',
      concepts: ['loops'],
      level: 'recall',
      support: 'independent',
      verdict: 'incorrect',
    };
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        scopes: { [learnerScopeKey(scope)]: { attempts: [attempt] } },
      }),
    );
    const store = new QuizStore(join(f.dir, 'import.json'));
    const learner = new LearnerStore(path);
    await learner.connect(store);
    assert.deepEqual(await learner.attempts(learnerScopeKey(scope)), [attempt]);
    await writeFile(path, 'corrupted after successful import');
    const reopened = new LearnerStore(path);
    await reopened.connect(new QuizStore(join(f.dir, 'import.json')));
    assert.deepEqual(await reopened.attempts(learnerScopeKey(scope)), [
      attempt,
    ]);
  } finally {
    await f.cleanup();
  }
});

test('learner diagnostics cover the learning pool and isolate unscoped quizzes', async () => {
  const f = await fixture();
  try {
    const first = new QuizSessionDriver(
      f.service,
      (await f.store.get(f.sessionId))!,
    );
    const second = new QuizSessionDriver(
      f.service,
      quizValue(await f.service.createSession(scope)),
    );
    const unscoped = new QuizSessionDriver(
      f.service,
      quizValue(await f.service.createSession()),
    );
    for (const driver of [second, unscoped])
      quizValue(await driver.agent({ type: 'attach' }));
    for (const driver of [first, second, unscoped]) {
      quizValue(
        await driver.agent({
          type: 'pose-question',
          kind: 'short-answer',
          question: 'Recall the rule',
        }),
      );
      quizValue(
        await driver.learner({
          type: 'answer',
          answer: 'A rule',
          confidence: 80,
        }),
      );
      quizValue(
        await driver.agent({
          type: 'feedback',
          text: 'Discussed.',
          verdict: 'correct',
        }),
      );
    }
    assert.equal((await f.service.reconcileLearner(first.id)).unmodelled, 2);
    assert.equal((await f.service.reconcileLearner(unscoped.id)).unmodelled, 1);
    assert.equal(f.service.learnerRecordingDiagnostics().unmodelled, 3);
  } finally {
    await f.cleanup();
  }
});
