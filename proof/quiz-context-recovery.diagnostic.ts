// Diagnostic evidence for the current continuity gaps. These assertions describe
// existing behavior; replace them with desired-behavior tests when fixing it.
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuizStore } from '../src/main/quizStore';
import { QuizService } from '../src/main/quizService';
import { createQuizAgentHandler } from '../src/main/quizAgentHandler';
import { modelSession, responseValue } from '../extensions/storm-quiz-runtime';
import type {
  QuizAgentRequest,
  QuizLearnerRequest,
  QuizResult,
} from '../src/shared/quizProtocol';

function value<T>(result: QuizResult<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'storm-context-diagnostic-'));
  const path = join(dir, 'quiz.json');
  const service = new QuizService(new QuizStore(path), () => true);
  const session = value(await service.createSession());
  const attached = value(await service.attachSession(session.id));
  async function send(type: string, fields = {}, learner = false) {
    const snapshot = (await service.getSnapshot(session.id))!;
    const request = {
      type,
      sessionId: session.id,
      expectedRevision: snapshot.session.revision,
      idempotencyKey: crypto.randomUUID(),
      ...fields,
    };
    return value(
      learner
        ? await service.learnerRequest(request as QuizLearnerRequest)
        : await service.request({
            ...request,
            agentToken: attached.agentToken,
          } as QuizAgentRequest),
    );
  }
  return {
    path,
    service,
    session,
    attached,
    send,
    close: () => rm(dir, { recursive: true, force: true }),
  };
}

test('public CLI status contains history and awaiting state, model projection drops both', async () => {
  const f = await fixture();
  try {
    await f.send(
      'message',
      { text: 'Please use the capacitor example.' },
      true,
    );
    const handler = createQuizAgentHandler(f.service);
    const response = await handler({
      protocol: 1,
      requestId: 'diagnostic-status',
      type: 'quiz',
      operation: 'snapshot',
      sessionId: f.session.id,
      agentToken: f.attached.agentToken,
    });
    if (!response.ok || response.type !== 'quiz' || !('snapshot' in response))
      throw new Error('Expected public snapshot');
    const raw = response.snapshot!.session;
    expect(raw.transcript[0].text).toBe('Please use the capacitor example.');
    expect(raw.awaitingAgent).toBe(true);
    expect(raw).not.toHaveProperty('agentToken');
    const projected = modelSession(raw);
    expect(projected).not.toHaveProperty('transcript');
    expect(projected).not.toHaveProperty('awaitingAgent');
    expect(JSON.stringify(projected)).not.toContain('capacitor');
  } finally {
    await f.close();
  }
});

test('reattach receives old events but starting at attach cursor skips pending free chat', async () => {
  const f = await fixture();
  try {
    await f.send('message', { text: 'Why does this formula apply?' }, true);
    value(await f.service.disconnectAgent(f.session.id, f.attached.agentToken));
    const handler = createQuizAgentHandler(f.service);
    const response = await handler({
      protocol: 1,
      requestId: 'diagnostic-attach',
      type: 'quiz',
      operation: 'attach',
      sessionId: f.session.id,
      clientId: 'diagnostic',
    });
    const reattached = responseValue(response);
    expect(
      reattached.snapshot.events.some((e: any) => e.type === 'message'),
    ).toBe(true);
    expect(reattached.snapshot.session.transcript[0].text).toContain('formula');
    expect(reattached.snapshot.session.awaitingAgent).toBe(false);
    expect(
      JSON.stringify(modelSession(reattached.snapshot.session)),
    ).not.toContain('formula');
    const nextWait = await f.service.getSnapshot(
      f.session.id,
      reattached.snapshot.session.eventCursor,
    );
    expect(nextWait!.events).toEqual([]);
  } finally {
    await f.close();
  }
});

test('pending clarification choices disappear even though prompt text is stored', async () => {
  const f = await fixture();
  try {
    const posed = await f.send('pose-prompt', {
      kind: 'clarification',
      prompt: 'Which part should we revisit?',
      choices: [{ id: 'units', text: 'Explain the units' }],
    });
    expect(posed.currentPrompt!.choices[0].id).toBe('units');
    expect(posed.transcript[0].text).toBe('Which part should we revisit?');
    expect(posed.transcript[0]).not.toHaveProperty('question');
    const projected = modelSession(posed);
    expect(projected).not.toHaveProperty('currentPrompt');
    expect(JSON.stringify(projected)).not.toContain('units');
  } finally {
    await f.close();
  }
});

test('current submitted answer and feedback survive projection; earlier discussion does not', async () => {
  const f = await fixture();
  try {
    await f.send(
      'message',
      { text: 'My difficulty is interpreting units.' },
      true,
    );
    await f.send('pose-question', {
      question: 'What is speed?',
      choices: [{ id: 'speed', text: 'Distance divided by time' }],
    });
    await f.send(
      'answer',
      { choiceId: 'speed', reasoning: 'The units are km/h.' },
      true,
    );
    const answered = (await f.service.getSnapshot(f.session.id))!.session;
    expect(modelSession(answered).currentQuestion).toMatchObject({
      status: 'answered',
      selectedChoiceId: 'speed',
      reasoningDraft: 'The units are km/h.',
    });
    const feedback = await f.send('feedback', {
      text: 'Distance per unit time.',
      verdict: 'correct',
    });
    expect(modelSession(feedback).currentQuestion).toMatchObject({
      status: 'feedback',
      feedback: 'Distance per unit time.',
    });
    expect(JSON.stringify(modelSession(feedback))).not.toContain(
      'My difficulty',
    );
  } finally {
    await f.close();
  }
});

test('restart after Continue preserves history/events but projection cannot identify that Continue occurred', async () => {
  const f = await fixture();
  try {
    await f.send('pose-question', {
      question: 'Choose A',
      choices: [{ id: 'a', text: 'A' }],
    });
    await f.send('answer', { choiceId: 'a', reasoning: '' }, true);
    await f.send('feedback', { text: 'A is correct.', verdict: 'correct' });
    await f.send('continue', {}, true);
    const restarted = new QuizService(new QuizStore(f.path), () => true);
    const reattached = value(await restarted.attachSession(f.session.id));
    expect(reattached.snapshot.events.some((e) => e.type === 'continue')).toBe(
      true,
    );
    expect(reattached.snapshot.session.transcript).toHaveLength(3);
    expect(reattached.snapshot.session.awaitingAgent).toBe(false);
    const projected = modelSession(reattached.snapshot.session);
    expect(projected.currentQuestion).toBeNull();
    expect(projected).not.toHaveProperty('transcript');
    expect(projected).not.toHaveProperty('awaitingAgent');
    expect(
      (await restarted.getSnapshot(
        f.session.id,
        reattached.snapshot.session.eventCursor,
      ))!.events,
    ).toEqual([]);
  } finally {
    await f.close();
  }
});
