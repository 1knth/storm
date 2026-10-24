import { describe, expect, test } from 'bun:test';
import {
  createWaitRuntime,
  parseWaitResponse,
  refreshSnapshot,
  attachStateMessage,
  responseValue,
  snapshotValue,
  learnerNotification,
  attachPrompt,
  modelSession,
} from './storm-quiz-runtime';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe('model-safe quiz context', () => {
  test('notifications contain only new events and preserve exact multiline Unicode reasoning', () => {
    const first = {
      cursor: 2,
      type: 'answer',
      data: { reasoning: 'café 🧠\nsecond line', choiceId: 'b' },
    };
    const next = { cursor: 3, type: 'continue', data: { message: 'Continue' } };
    const firstNotice = learnerNotification([first], {
      id: 'q-1',
      text: 'Question',
    });
    const nextNotice = learnerNotification([next], {
      id: 'q-1',
      text: 'Question',
    });
    expect(
      JSON.parse(firstNotice.slice(firstNotice.indexOf('{'))).events[0].data
        .reasoning,
    ).toBe('café 🧠\nsecond line');
    expect(nextNotice).not.toContain('café');
    expect(nextNotice).not.toContain('Question');
    expect(nextNotice).toContain('continue');
  });

  test('matching and free-text learner submissions remain exact in notifications', () => {
    const notification = learnerNotification(
      [
        {
          cursor: 4,
          type: 'answer',
          data: {
            matches: { leftA: 'rightB' },
            answer: 'Exact text — café\nsecond line',
            reasoning: 'Because of the evidence.',
          },
        },
      ],
      {
        id: 'q1',
        kind: 'matching',
        prompt: 'Match these',
        leftItems: [{ id: 'leftA', text: 'A' }],
        rightItems: [{ id: 'rightB', text: 'B' }],
      },
    );
    expect(notification).toContain('"matches":{"leftA":"rightB"}');
    expect(notification).toContain('Exact text — café\\nsecond line');
    expect(notification).toContain('Because of the evidence.');
    expect(notification).toContain('"kind":"matching"');
  });

  test('Continue context stays bounded as stored transcript grows and redacts nested tokens', () => {
    const event = {
      cursor: 30,
      type: 'continue',
      data: { agentToken: 'synthetic-secret', message: 'Continue' },
      agentToken: 'synthetic-secret',
    };
    const small = learnerNotification([event], null);
    const largeTranscript = Array.from(
      { length: 1000 },
      (_, i) => `learner history ${i}`,
    ).join(' ');
    const large = learnerNotification([event], { transcript: largeTranscript });
    expect(large.length).toBe(small.length);
    expect(large).not.toContain('synthetic-secret');
    expect(
      JSON.stringify(
        modelSession({
          id: 'q',
          revision: 3,
          status: 'waiting',
          scope: 'scope',
          transcript: largeTranscript,
          agentToken: 'synthetic-secret',
          currentQuestion: { id: 'q1', agentToken: 'synthetic-secret' },
        }),
      ),
    ).not.toContain('synthetic-secret');
    const prompt = attachPrompt({
      id: 'q',
      revision: 3,
      status: 'waiting',
      scope: 'scope',
      agentToken: 'synthetic-secret',
    });
    expect(prompt).not.toContain('synthetic-secret');
    expect(prompt).toContain(
      'set the explicit verdict field to correct, partial, or incorrect',
    );
    expect(prompt).toContain('do not repeat a verdict heading');
    expect(prompt).toContain(
      "address the learner's supplied reasoning specifically",
    );
    expect(prompt).toContain('do not use em dashes');
    expect(prompt).toContain('Do not add a separate Continue instruction');
    expect(prompt).toContain(
      'kind next-steps or clarification and 1–6 structured choices',
    );
    expect(prompt).toContain(
      'Keep explanations as thorough as the material requires',
    );
    expect(prompt).not.toContain('**Verdict** —');
    expect(prompt).toContain('Keep the explicit Continue gate');
    expect(prompt).toContain('Substantial teaching is welcome');
    expect(prompt).toContain('the line breaks and blank lines are intentional');
    expect(prompt).toContain(
      'A writer argues,\n\n*“The college should extend evening library hours.”*\n\nWhich addition identifies an exception, a **circumstance** in which that recommendation might not apply, rather than **evidence**, a **warrant**, or a **qualifier**?',
    );
    expect(prompt).toContain('real newline characters and blank lines');
  });

  test('unscoped attach asks for study context without assuming a source location', () => {
    const prompt = attachPrompt({ id: 'draft', status: 'connected' });
    expect(prompt).toContain('No study scope was supplied');
    expect(prompt).toContain('ask what they are studying');
    expect(prompt).toContain('registered Storm CLI discovery tools');
    expect(prompt).not.toContain('scope:');
    expect(
      JSON.stringify(modelSession({ id: 'draft', status: 'connected' })),
    ).not.toContain('scope');
  });

  test('recurring learner notifications stay compact without repeating attach guidance', () => {
    const notice = learnerNotification(
      [{ cursor: 4, type: 'answer', data: { answer: '42' } }],
      { id: 'q1', text: 'Question' },
    );
    expect(notice).toContain('Storm quiz learner activity');
    expect(notice).not.toContain('**Verdict**');
    expect(notice).not.toContain('Your reasoning');
    expect(notice).not.toContain('Substantial teaching');
  });
});

describe('quiz CLI response handling', () => {
  test('explains connected and completed attach rejection states safely', () => {
    expect(attachStateMessage('connected')).toContain('already connected');
    expect(attachStateMessage('connected')).toContain('Stop agent');
    expect(attachStateMessage('connected')).toContain('Do not reset');
    expect(attachStateMessage('complete')).toContain('complete');
    expect(attachStateMessage(undefined)).toContain('Check the quiz status');
  });
  test('reads the actual CLI broker envelope with result.value', () => {
    const stdout =
      JSON.stringify({
        protocol: 1,
        requestId: 'fake-request',
        ok: true,
        type: 'quiz',
        operation: 'attach',
        result: {
          ok: true,
          value: {
            agentToken: 'synthetic-token',
            snapshot: { session: { id: 'quiz-1' }, events: [] },
          },
        },
      }) + '\n';
    expect(responseValue(JSON.parse(stdout))).toMatchObject({
      agentToken: 'synthetic-token',
      snapshot: { session: { id: 'quiz-1' } },
    });
  });

  test('decodes CLI status snapshot envelope separately from result.value operations', () => {
    const response = {
      protocol: 1,
      requestId: 'fake-status',
      ok: true,
      type: 'quiz',
      operation: 'snapshot',
      snapshot: {
        session: { id: 'quiz-1', revision: 7, eventCursor: 3 },
        events: [],
      },
    };
    expect(snapshotValue(JSON.parse(JSON.stringify(response)))).toEqual(
      response.snapshot,
    );
    expect(() => snapshotValue({ ...response, snapshot: undefined })).toThrow(
      'snapshot.session',
    );
  });

  test('decodes quiz request result.value and rejects malformed success envelopes', () => {
    const response = {
      protocol: 1,
      requestId: 'fake-request',
      ok: true,
      type: 'quiz',
      operation: 'request',
      result: { ok: true, value: { revision: 8, currentQuestion: null } },
    };
    expect(responseValue(JSON.parse(JSON.stringify(response)))).toEqual(
      response.result.value,
    );
    expect(() => responseValue({ ok: true, operation: 'request' })).toThrow(
      'result.value',
    );
  });

  test('parses CLI error envelopes without exposing them as result values', () => {
    expect(() =>
      responseValue({
        ok: true,
        result: { ok: false, error: { message: 'attach rejected' } },
      }),
    ).toThrow('attach rejected');
  });
});

describe('quiz status refresh', () => {
  test('refreshes the revision used for feedback without skipping pending learner events', () => {
    const state = {
      revision: 12,
      cursor: 4,
      snapshot: { revision: 12, eventCursor: 4, status: 'connected' },
    };
    const refreshed = refreshSnapshot(state, {
      session: { revision: 14, eventCursor: 9, status: 'connected' },
    });

    expect(refreshed.revision).toBe(14);
    expect(state.revision).toBe(14);
    expect(state.cursor).toBe(4);
    // The subsequent feedback request uses the refreshed revision, while the
    // independent waiter still resumes from its last delivered cursor.
    const feedbackRequest = { expectedRevision: state.revision };
    expect(feedbackRequest.expectedRevision).toBe(14);
    expect(state.cursor).toBe(4);
  });
});

describe('quiz wait runtime', () => {
  test('parses the CLI top-level snapshot envelope and literal newline suffix', () => {
    const parsed = parseWaitResponse(
      JSON.stringify({
        ok: true,
        snapshot: {
          session: { revision: 3, eventCursor: 8, status: 'connected' },
          events: [{ cursor: 8, type: 'answer', data: { choiceId: 'a' } }],
        },
        after: 8,
        timedOut: false,
      }) + '\\n',
    );
    expect(parsed.cursor).toBe(8);
    expect(parsed.value?.events[0]?.type).toBe('answer');
  });
  test('waits serially and delivers activity once before rearming', async () => {
    const first = deferred<any>();
    const second = deferred<any>();
    const spawned: number[] = [];
    const delivered: string[] = [];
    const runtime = createWaitRuntime<string>({
      spawnWait(after) {
        spawned.push(after);
        return {
          kill() {},
          result: spawned.length === 1 ? first.promise : second.promise,
        };
      },
      deliver(value) {
        delivered.push(value);
      },
    });
    runtime.start(4, 'private-token');
    expect(spawned).toEqual([4]);
    first.resolve({ value: 'learner-answer' });
    await Promise.resolve();
    await Promise.resolve();
    expect(delivered).toEqual(['learner-answer']);
    expect(spawned).toEqual([4, 4]);
    runtime.stop();
  });

  test('advances the next wait cursor after learner activity', async () => {
    const first = deferred<any>();
    const second = deferred<any>();
    const spawned: number[] = [];
    const runtime = createWaitRuntime<string>({
      spawnWait(after) {
        spawned.push(after);
        return {
          kill() {},
          result: spawned.length === 1 ? first.promise : second.promise,
        };
      },
      deliver() {},
    });
    runtime.start(4, 'private-token');
    first.resolve({ value: 'learner-answer', cursor: 7 });
    await Promise.resolve();
    await Promise.resolve();
    expect(spawned).toEqual([4, 7]);
    runtime.stop();
  });

  test('disconnect result invokes reconciliation once', async () => {
    const pending = deferred<any>();
    let disconnected = 0;
    const runtime = createWaitRuntime<string>({
      spawnWait: () => ({ kill() {}, result: pending.promise }),
      deliver() {},
      onDisconnect() {
        disconnected++;
      },
    });
    runtime.start(0, 'secret');
    pending.resolve({ disconnected: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(disconnected).toBe(1);
    runtime.stop();
    expect(disconnected).toBe(1);
  });

  test('stop kills waiter and ignores its stale result', async () => {
    const pending = deferred<any>();
    let killed = 0;
    const delivered: string[] = [];
    const runtime = createWaitRuntime<string>({
      spawnWait: () => ({
        kill() {
          killed++;
        },
        result: pending.promise,
      }),
      deliver: (value) => delivered.push(value),
    });
    runtime.start(0, 'secret');
    runtime.stop();
    pending.resolve({ value: 'stale' });
    await Promise.resolve();
    expect(killed).toBe(1);
    expect(delivered).toEqual([]);
  });
});
