import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { QuizStore } from './quizStore';
import { quizFixture, quizValue as value } from './quizTestFixtures';
import { QuizService } from './quizService';
import { createQuizAgentHandler } from './quizAgentHandler';
import type { AgentRequest } from '../shared/agentProtocol';

async function fixture() {
  const shared = await quizFixture({ connected: true });
  const { dir, path, store, service, session, attached, driver } = shared;
  const handle = createQuizAgentHandler(service);
  const request = (operation: string, fields = {}) =>
    handle({
      protocol: 1,
      requestId: crypto.randomUUID(),
      type: 'quiz',
      operation,
      sessionId: session.id,
      agentToken: attached.agentToken,
      ...fields,
    } as Extract<AgentRequest, { type: 'quiz' }>);
  async function send(type: string, fields = {}, learner = false) {
    await driver.refresh();
    return value(
      await (learner
        ? driver.learnerInput({ type, ...fields })
        : driver.agentInput({ type, ...fields })),
    );
  }
  return { dir, path, store, service, session, attached, request, send };
}

test('compact status restores pending chat and preserves unfinished work across disconnect', async () => {
  const f = await fixture();
  try {
    const pending = await f.send(
      'message',
      { text: 'Please return to the capacitor example.' },
      true,
    );
    value(await f.service.disconnectAgent(f.session.id, f.attached.agentToken));
    const reply = await f.request('attach', {
      compact: true,
      clientId: 'recovery',
    });
    assert.ok(
      reply.ok &&
        reply.type === 'quiz' &&
        reply.operation === 'attach' &&
        reply.result.ok,
    );
    if (
      !reply.ok ||
      reply.type !== 'quiz' ||
      reply.operation !== 'attach' ||
      !reply.result.ok
    )
      return;
    const snapshot = reply.result.value.snapshot;
    assert.equal(snapshot.recovery!.pendingAction, 'reply');
    assert.equal(snapshot.recovery!.pendingLearnerCursor, pending.eventCursor);
    assert.equal(
      snapshot.recovery!.history.entries[0].text,
      'Please return to the capacitor example.',
    );
    assert.equal('agentToken' in snapshot.session, false);
    assert.deepEqual(snapshot.session.transcript, []);
    assert.equal(snapshot.recovery!.historical, true);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('pending prompts retain choices and Continue survives process recovery', async () => {
  const f = await fixture();
  try {
    await f.send('pose-question', {
      question: 'First?',
      choices: [{ id: 'a', text: 'A' }],
    });
    await f.send('answer', { choiceId: 'a', reasoning: 'Exact café 🧠' }, true);
    await f.send('feedback', { text: 'Correct.', verdict: 'correct' });
    const prompt = await f.send('pose-prompt', {
      kind: 'next-steps',
      prompt: 'What next?',
      choices: [{ id: 'next', text: 'Continue', effect: 'continue' }],
    });
    const status = await f.request('snapshot', {
      compact: true,
      recover: true,
    });
    assert.ok(
      status.ok && status.type === 'quiz' && status.operation === 'snapshot',
    );
    if (!status.ok || status.type !== 'quiz' || status.operation !== 'snapshot')
      return;
    assert.equal(
      status.snapshot!.session.currentPrompt!.choices[0].effect,
      'continue',
    );
    await f.send(
      'respond-prompt',
      { promptId: prompt.currentPrompt!.id, choiceId: 'next' },
      true,
    );
    const restarted = new QuizService(new QuizStore(f.path), () => true);
    const attached = value(await restarted.attachSession(f.session.id));
    const handle = createQuizAgentHandler(restarted);
    const recovered = await handle({
      protocol: 1,
      requestId: 'recovery',
      type: 'quiz',
      operation: 'snapshot',
      sessionId: f.session.id,
      agentToken: attached.agentToken,
      compact: true,
      recover: true,
    });
    if (
      !recovered.ok ||
      recovered.type !== 'quiz' ||
      recovered.operation !== 'snapshot'
    )
      throw new Error('Recovery failed');
    assert.equal(recovered.snapshot!.recovery!.pendingAction, 'next-question');
    assert.ok(
      recovered.snapshot!.recovery!.recentEvents.some(
        (event: any) =>
          event.type === 'respond-prompt' && event.data.effect === 'continue',
      ),
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('compact event pages and history stay bounded; explicit context chunks recover full Unicode text', async () => {
  const f = await fixture();
  try {
    const long = '🧠 café '.repeat(5000);
    await f.send('message', { text: long }, true);
    for (let index = 0; index < 40; index++)
      await f.send('agent-message', { text: `Explanation ${index}` });
    const status = await f.request('snapshot', {
      compact: true,
      recover: true,
    });
    if (!status.ok || status.type !== 'quiz' || status.operation !== 'snapshot')
      throw new Error('Status failed');
    const snapshot = status.snapshot!;
    assert.equal(snapshot.events.length, 32);
    assert.equal(snapshot.hasMore, true);
    assert.ok(snapshot.after! < snapshot.session.eventCursor);
    assert.equal(snapshot.recovery!.history.entries.length, 12);
    assert.equal(snapshot.recovery!.history.incomplete, true);
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 120_000);
    let offset = 0,
      reconstructed = '';
    do {
      const chunk = await f.request('context', {
        section: 'history',
        before: 1,
        offset,
      });
      if (
        !chunk.ok ||
        chunk.type !== 'quiz' ||
        chunk.operation !== 'context' ||
        !chunk.result.ok
      )
        throw new Error('Chunk failed');
      reconstructed += chunk.result.value.text;
      offset = chunk.result.value.nextOffset;
      assert.ok(Buffer.byteLength(chunk.result.value.text) <= 24_000);
    } while (offset !== null);
    assert.equal(JSON.parse(reconstructed).text, long);
    const denied = await f.request('context', {
      section: 'history',
      agentToken: 'wrong',
    });
    assert.ok(
      denied.ok &&
        denied.type === 'quiz' &&
        denied.operation === 'context' &&
        !denied.result.ok,
    );
    const idle = await f.request('snapshot', {
      compact: true,
      after: snapshot.session.eventCursor,
    });
    if (!idle.ok || idle.type !== 'quiz' || idle.operation !== 'snapshot')
      throw new Error('Idle snapshot failed');
    assert.deepEqual(idle.snapshot!.events, []);
    assert.ok(Buffer.byteLength(JSON.stringify(idle.snapshot)) < 2000);
    assert.equal(idle.snapshot!.recovery, undefined);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('cached reads detect external changes and do not expose mutable persisted state', async () => {
  const f = await fixture();
  try {
    await f.send('agent-message', { text: 'Saved.' });
    const read = (await f.store.get(f.session.id))!;
    read.transcript[0].text = 'External mutation';
    assert.equal(
      (await f.store.get(f.session.id))!.transcript[0].text,
      'Saved.',
    );
    await writeFile(f.path, 'corrupt');
    await assert.rejects(f.store.getAgentState(f.session.id));
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('an accidental chat answer can be cleared without grading and replaced with an MCQ', async () => {
  const f = await fixture();
  try {
    const posed = await f.send('pose-question', {
      kind: 'short-answer',
      question: 'Trace the program.',
    });
    const questionId = posed.currentQuestion!.id;
    await f.send('answer', { answer: 'continue' }, true);
    await f.send(
      'message',
      { text: 'clear it and give me a conceptual MCQ' },
      true,
    );
    const clear = {
      type: 'skip-question' as const,
      sessionId: f.session.id,
      agentToken: f.attached.agentToken,
      expectedRevision: (await f.service.getSnapshot(f.session.id))!.session
        .revision,
      idempotencyKey: 'clear-accidental-answer',
      questionId,
      text: 'Cleared the tracing question without a grade.',
    };
    assert.deepEqual(
      await f.service.request({ ...clear, questionId: 'wrong' }),
      { ok: false, error: 'invalid-state' },
    );
    assert.deepEqual(await f.service.request({ ...clear, text: '' }), {
      ok: false,
      error: 'invalid-input',
    });
    assert.deepEqual(
      await f.service.request({
        ...clear,
        expectedRevision: clear.expectedRevision - 1,
      }),
      { ok: false, error: 'stale-revision' },
    );
    assert.deepEqual(
      await f.service.request({ ...clear, agentToken: 'wrong' }),
      { ok: false, error: 'unauthorized' },
    );
    const cleared = value(await f.service.request(clear));
    assert.equal(cleared.currentQuestion, null);
    assert.equal(cleared.awaitingAgent, false);
    assert.equal(
      cleared.transcript.find((m) => m.kind === 'answer')?.text,
      'continue',
    );
    assert.equal(
      cleared.transcript.some((m) => m.question?.verdict),
      false,
    );
    assert.equal(
      value(await f.service.request(clear)).revision,
      cleared.revision,
    );
    const snapshot = (await f.service.getSnapshot(f.session.id))!;
    assert.equal(
      snapshot.events.filter((e) => e.type === 'skip-question').length,
      1,
    );
    assert.equal(
      snapshot.events.some((e) => e.type === 'feedback'),
      false,
    );
    const recovery = await f.request('snapshot', {
      compact: true,
      recover: true,
    });
    assert.equal(
      (recovery as any).snapshot.recovery.pendingAction,
      'wait-for-learner',
    );
    const next = await f.send('pose-question', {
      question: 'Which statement describes a loop?',
      choices: [{ id: 'a', text: 'It repeats a block.' }],
    });
    assert.equal(next.currentQuestion?.kind, 'multiple-choice');
    assert.notEqual(next.currentQuestion?.id, questionId);
    const persisted = await new QuizStore(f.path).get(f.session.id);
    assert.equal(
      persisted?.transcript.find((m) => m.kind === 'answer')?.text,
      'continue',
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('learner Skip releases open and answered questions and recovers next-question activity', async () => {
  const f = await fixture();
  try {
    for (const answered of [false, true]) {
      const posed = await f.send('pose-question', {
        kind: 'short-answer',
        question: 'Trace it.',
      });
      if (answered) await f.send('answer', { answer: 'continue' }, true);
      const before = (await f.service.getSnapshot(f.session.id))!.session;
      const skip = {
        type: 'skip' as const,
        sessionId: f.session.id,
        expectedRevision: before.revision,
        idempotencyKey: `skip-${answered}`,
        questionId: posed.currentQuestion!.id,
      };
      assert.deepEqual(
        await f.service.request({ ...skip, agentToken: f.attached.agentToken }),
        { ok: false, error: 'invalid-input' },
      );
      assert.deepEqual(
        await f.service.learnerRequest({ ...skip, questionId: 'wrong' }),
        { ok: false, error: 'invalid-state' },
      );
      const skipped = value(await f.service.learnerRequest(skip));
      assert.equal(skipped.currentQuestion, null);
      assert.equal(skipped.awaitingAgent, true);
      assert.equal(
        value(await f.service.learnerRequest(skip)).revision,
        skipped.revision,
      );
      const recovery = await f.request('snapshot', {
        compact: true,
        recover: true,
      });
      assert.equal(
        (recovery as any).snapshot.recovery.pendingAction,
        'next-question',
      );
      assert.equal(
        (recovery as any).snapshot.recovery.recentEvents.at(-1).type,
        'skip',
      );
      assert.equal(
        (recovery as any).snapshot.recovery.recentEvents.at(-1).data.questionId,
        posed.currentQuestion!.id,
      );
      assert.deepEqual(
        await f.service.learnerRequest({
          ...skip,
          idempotencyKey: 'empty-skip',
          expectedRevision: skipped.revision,
        }),
        { ok: false, error: 'invalid-state' },
      );
    }
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
