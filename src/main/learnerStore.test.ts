import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
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

test('learner read repairs failed recording after Continue exactly once at the original grade time', async () => {
  let failing = true;
  const f = await fixture((learner) => async (session, question) => {
    if (failing) throw new Error('sensitive failure detail');
    await learner.recordQuestion(session, question);
  });
  try {
    await f.agent({ ...f.question, concepts: ['loops'], level: 'recall' });
    await f.learnerAction({
      type: 'answer',
      choiceId: 'a',
      reasoning: '',
      confidence: 70,
    });
    const feedback = await f.agent({
      type: 'feedback',
      text: 'Correct.',
      verdict: 'correct',
    });
    assert.ok(feedback.ok);
    if (!feedback.ok) return;
    const gradedAt = feedback.value.currentQuestion!.gradedAt;
    const handler = createQuizAgentHandler(f.service, (s, id) =>
      f.learner.state(s, id),
    );
    const read = () =>
      handler({
        protocol: 1,
        requestId: 'learner',
        type: 'quiz',
        operation: 'learner',
        sessionId: f.sessionId,
        agentToken: f.agentToken,
      });
    const pending = await read();
    assert.ok('result' in pending && pending.result.ok);
    if (!('result' in pending && pending.result.ok)) return;
    const diagnostics = (pending.result.value as any).recording;
    assert.equal(diagnostics.pending, 1);
    assert.ok(diagnostics.failures >= 1);
    assert.equal(diagnostics.lastError, 'LEARNER_RECORDING_RETRY_PENDING');
    assert.ok(!JSON.stringify(pending).includes('sensitive failure detail'));
    await f.learnerAction({ type: 'continue' });
    await f.agent({
      type: 'agent-message',
      text: 'Later activity must not move the grade time.',
    });
    failing = false;
    const repaired = await read();
    assert.equal(
      'result' in repaired &&
        repaired.result.ok &&
        (repaired.result.value as any).recording.pending,
      0,
    );
    await Promise.all([read(), read(), read()]);
    const attempts = await f.learner.attempts(learnerScopeKey(scope));
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.at, gradedAt);
  } finally {
    await f.cleanup();
  }
});

test('restart recovers a grade from durable history after recording failed and current question was cleared', async () => {
  const f = await fixture(() => async () => {
    throw new Error('disk unavailable');
  });
  try {
    await f.agent(f.question);
    await f.learnerAction({
      type: 'answer',
      choiceId: 'a',
      reasoning: '',
      confidence: 90,
    });
    const feedback = await f.agent({
      type: 'feedback',
      text: 'A missing condition.',
      verdict: 'incorrect',
    });
    assert.ok(feedback.ok);
    if (!feedback.ok) return;
    const gradedAt = feedback.value.currentQuestion!.gradedAt;
    await f.learnerAction({ type: 'continue' });
    // New instances discard all process memory, simulating a crash after durable feedback.
    const learner = new LearnerStore(join(f.dir, 'learner.json'));
    const restarted = new QuizService(
      new QuizStore(join(f.dir, 'sessions.json')),
      () => true,
      () => '2099-01-01T00:00:00.000Z',
      undefined,
      undefined,
      (session, question) => learner.recordQuestion(session, question),
    );
    await restarted.listSessions();
    await restarted.reconcileLearner(f.sessionId);
    const attempts = await learner.attempts(learnerScopeKey(scope));
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.at, gradedAt);
    assert.equal(attempts[0]?.support, 'unknown');
    assert.equal(attempts[0]?.confidence, 90);
  } finally {
    await f.cleanup();
  }
});

test('feedback retry repairs uncertain recording without duplicating a question', async () => {
  let writes = 0;
  const f = await fixture((learner) => async (session, question) => {
    await learner.recordQuestion(session, question);
    if (++writes === 1)
      throw new Error('record persisted, acknowledgement lost');
  });
  try {
    await f.agent({ ...f.question, concepts: ['loops'], level: 'recall' });
    await f.learnerAction({
      type: 'answer',
      choiceId: 'a',
      reasoning: '',
      confidence: 60,
    });
    const before = (await f.service.getSnapshot(f.sessionId))!.session;
    const request = {
      type: 'feedback' as const,
      text: 'Correct.',
      verdict: 'correct' as const,
      sessionId: f.sessionId,
      agentToken: f.agentToken,
      expectedRevision: before.revision,
      idempotencyKey: 'uncertain-feedback',
    };
    assert.ok((await f.service.request(request)).ok);
    assert.equal(f.service.learnerRecordingDiagnostics().pending, 1);
    assert.ok((await f.service.request(request)).ok);
    assert.equal(f.service.learnerRecordingDiagnostics().pending, 0);
    assert.equal((await f.learner.attempts(learnerScopeKey(scope))).length, 1);
    assert.equal(
      (await f.service.getSnapshot(f.sessionId))!.session.transcript.filter(
        (m) => m.question?.verdict,
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
    await f.learner.record('unscoped', {
      ...old!,
      id: 'legacy',
      confidence: 50,
    });
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

test('large startup replay is batched, retried on failure, then skipped on repeated learner reads', async () => {
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
    let batches = 0;
    let merges = 0;
    const merge = learner.recordMany.bind(learner);
    learner.recordMany = async (key, attempts) => {
      merges++;
      await merge(key, attempts);
    };
    const service = new QuizService(
      new QuizStore(join(dir, 'sessions.json')),
      () => true,
      undefined,
      undefined,
      undefined,
      undefined,
      async (entries) => {
        batches++;
        assert.equal(entries.length, 2000);
        if (batches === 1) throw new Error('temporary failure');
        await learner.recordGrades(entries);
      },
    );
    await service.listSessions();
    assert.equal(service.learnerRecordingDiagnostics().pending, 2000);
    const repaired = await service.reconcileLearner('history');
    assert.equal(repaired.pending, 0);
    assert.equal(repaired.failures, 0);
    assert.equal(batches, 2);
    assert.equal(merges, 1);
    const before = await stat(join(dir, 'learner.json'));
    await service.reconcileLearner('history');
    await service.reconcileLearner('history');
    assert.equal(batches, 2);
    assert.equal(merges, 1);
    const attempts = await learner.attempts(learnerScopeKey(scope));
    assert.equal(attempts.length, 2000);
    assert.ok(attempts.every((a) => a.at === at));
    // Even a fresh process replay should leave an identical derived file untouched.
    const fresh = new LearnerStore(join(dir, 'learner.json'));
    await fresh.recordMany(learnerScopeKey(scope), attempts);
    const after = await stat(join(dir, 'learner.json'));
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
    await fresh.recordMany(learnerScopeKey(scope), [
      { ...attempts[0], verdict: 'partial' },
    ]);
    assert.equal(
      (await fresh.attempts(learnerScopeKey(scope))).filter(
        (a) => a.id === attempts[0].id,
      ).length,
      1,
    );
    assert.equal(
      (await fresh.attempts(learnerScopeKey(scope))).find(
        (a) => a.id === attempts[0].id,
      )?.verdict,
      'partial',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
