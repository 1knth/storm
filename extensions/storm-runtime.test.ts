import { SessionManager } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js';
import { describe, expect, test } from 'bun:test';
import {
  createWaitRuntime,
  parseWaitResponse,
  attachStateMessage,
  assertQuizCapabilities,
  validateTutorQuestionLearning,
  responseValue,
  snapshotValue,
  learnerNotification,
  attachPrompt,
  compactLearnerState,
  modelSession,
  projectStormContext,
  STORM_PRUNE_STEP,
  externalSourceAllowed,
  withReaderFallback,
  writeAck,
} from './storm-runtime';

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
    expect(prompt).toContain('"id":"q"');
    expect(prompt).toContain('"scope":"scope"');
    expect(prompt).not.toContain('Adaptive practice');
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

  test('surfaces Storm rejection reasons with their error code', () => {
    let failure: any;
    try {
      responseValue({
        ok: true,
        result: {
          ok: false,
          error: 'invalid-input',
          message:
            'loops: needs a fresh independent correct item in a practice test.',
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure.message).toContain('needs a fresh independent');
    expect(failure.code).toBe('invalid-input');
  });
});

describe('quiz wait runtime', () => {
  test('waits for asynchronous delivery before advancing the cursor or spawning another waiter', async () => {
    const result = deferred<any>();
    const delivery = deferred<void>();
    const cursors: number[] = [];
    const runtime = createWaitRuntime<string>({
      spawnWait(after) {
        cursors.push(after);
        return { kill() {}, result: result.promise };
      },
      deliver() {
        return delivery.promise;
      },
    });
    runtime.start(3, 'synthetic');
    result.resolve({ value: 'image-event', cursor: 4 });
    await Promise.resolve();
    expect(cursors).toEqual([3]);
    runtime.stop();
    delivery.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(cursors).toEqual([3]);
  });

  test('exhausts bounded retries, exposes failure, and status can restart at the delivered cursor', async () => {
    const cursors: number[] = [];
    let fail = true;
    const pending = deferred<any>();
    const runtime = createWaitRuntime<string>({
      retryDelays: [0],
      spawnWait(after) {
        cursors.push(after);
        return {
          kill() {},
          result: fail
            ? Promise.reject(new Error('temporary'))
            : pending.promise,
        };
      },
      deliver() {},
    });
    runtime.start(7, 'synthetic');
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(cursors).toEqual([7, 7]);
    expect(runtime.health).toBe('failed');
    fail = false;
    runtime.start(7, 'synthetic');
    expect(cursors).toEqual([7, 7, 7]);
    expect(runtime.health).toBe('running');
    runtime.stop();
  });

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

test('Tutor questions require deliberate complete tags or an explicit reason while legacy parsing remains separate', () => {
  for (const request of [
    {},
    { concepts: ['loops'] },
    { level: 'recall' },
    { concepts: ['loops'], level: 'recall' },
    { unmodelledReason: '' },
    { unmodelledReason: '  ' },
    { unmodelledReason: 'x'.repeat(501) },
    {
      concepts: ['loops'],
      level: 'recall',
      support: 'independent',
      unmodelledReason: 'mixed',
    },
    { concepts: ['Bad Slug'], level: 'recall', support: 'independent' },
  ])
    expect(() => validateTutorQuestionLearning(request)).toThrow(
      'complete concepts',
    );
  expect(() =>
    validateTutorQuestionLearning({
      concepts: ['loops'],
      level: 'recall',
      support: 'independent',
    }),
  ).not.toThrow();
  expect(() =>
    validateTutorQuestionLearning({
      unmodelledReason: 'A diagnostic outside the studied concepts.',
    }),
  ).not.toThrow();
});

test('extension handshake rejects old or incomplete app capabilities before attaching', () => {
  for (const value of [
    undefined,
    {},
    {
      integrationVersion: 1,
      features: [
        'learning',
        'support-update',
        'answer-confidence',
        'tutor-notes',
      ],
    },
    { integrationVersion: 2, features: ['learning', 'answer-confidence'] },
  ])
    expect(() => assertQuizCapabilities(value)).toThrow(
      'Update the installed Storm app/CLI',
    );
  expect(() =>
    assertQuizCapabilities({
      integrationVersion: 2,
      features: [
        'learning',
        'support-update',
        'answer-confidence',
        'tutor-notes',
      ],
    }),
  ).not.toThrow();
});

describe('context savings', () => {
  test('write acks drop the lesson map, notes and scope but keep the question', () => {
    const ack = writeAck({
      id: 's',
      revision: 3,
      scope: { folderPath: '.' },
      lessonMap: { nodes: [{ id: 'a', label: 'A' }], edges: [] },
      tutorNotes: { text: 'plan', version: 1 },
      currentQuestion: {
        id: 'q',
        kind: 'multiple-choice',
        choices: [{ id: 'c', text: 'C' }],
      },
    });
    expect(ack).not.toHaveProperty('lessonMap');
    expect(ack).not.toHaveProperty('tutorNotes');
    expect(ack).not.toHaveProperty('scope');
    expect(ack.revision).toBe(3);
    expect(ack.currentQuestion.choices).toEqual([{ id: 'c', text: 'C' }]);
  });

  test('learner reads omit only false and null concept fields', () => {
    const compact = compactLearnerState({
      band: [0.7, 0.85],
      concepts: [
        {
          id: 'a',
          zone: 'zpd',
          retrievability: 0,
          dueForReview: true,
          confidentError: false,
          confidentReview: null,
        },
      ],
    }) as any;
    expect(compact.band).toEqual([0.7, 0.85]);
    expect(compact.concepts).toEqual([
      { id: 'a', zone: 'zpd', retrievability: 0, dueForReview: true },
    ]);
    expect(compact.conceptDefaults).toContain('false');
  });
});

describe('reader fallback', () => {
  test('unreadable files come back as absolute paths with guidance', () => {
    const value = withReaderFallback(
      {
        snapshotId: 'snap',
        chunks: [],
        issues: [
          { path: 'Slides/Week1.pdf', reason: 'reader-unavailable' },
          { path: 'Slides/Week1.pdf', reason: 'reader-unavailable' },
          { path: 'Notes/a.md', reason: 'source-unavailable' },
        ],
      },
      '/Users/me/Vault/',
    );
    expect(value.readerFallback.files).toEqual([
      '/Users/me/Vault/Slides/Week1.pdf',
    ]);
    expect(value.readerFallback.root).toBe('/Users/me/Vault/');
    // Retrieve results skip the repeated guidance; trees carry it.
    expect(value.readerFallback.guidance).toBeUndefined();
  });

  test('trees with non-note files get the root, Markdown-only results stay unchanged', () => {
    const tree = {
      entries: [
        { path: 'a.md', kind: 'note' },
        { path: 'b.docx', kind: 'docx' },
      ],
      issues: [],
    };
    expect(withReaderFallback(tree, '/v').readerFallback).toMatchObject({
      root: '/v',
      guidance: expect.stringContaining('externalSource'),
    });
    const notes = { entries: [{ path: 'a.md', kind: 'note' }], issues: [] };
    expect(withReaderFallback(notes, '/v')).toBe(notes);
    expect(withReaderFallback(tree, undefined)).toBe(tree);
  });
});

test('externalSource must be a non-Markdown file inside the vault', () => {
  expect(externalSourceAllowed('/vault/Slides/W1.pdf', '/vault')).toBe(true);
  expect(externalSourceAllowed('/vault/Slides/W1.pdf', '/vault/')).toBe(true);
  expect(externalSourceAllowed('/vault/Notes/W1.md', '/vault')).toBe(false);
  expect(externalSourceAllowed('/vaulted/W1.pdf', '/vault')).toBe(false);
  expect(externalSourceAllowed('/vault/../etc/x.pdf', '/vault')).toBe(false);
  expect(externalSourceAllowed('/vault/Slides/../../x.pdf', '/vault')).toBe(
    false,
  );
  expect(externalSourceAllowed('/vault', '/vault')).toBe(false);
  expect(externalSourceAllowed('Slides/W1.pdf', '/vault')).toBe(false);
  expect(externalSourceAllowed('/vault/Slides/W1.pdf', undefined)).toBe(false);
});

describe('structured context projection', () => {
  const attachment = (value: Record<string, unknown>) => ({
    role: 'custom',
    customType: 'storm-attachment',
    content: JSON.stringify(value),
    details: { storm: { kind: 'attach', sessionId: 'quiz', value } },
  });
  test('restores full state after an earlier attachment is omitted', () => {
    const first = attachment({
      tutorNotes: { text: 'Plan' },
      study: { entries: ['source.pdf'] },
    });
    const second = attachment(first.details.storm.value);
    const projected = projectStormContext([first, second]);
    expect(projected[1].content).toContain('unchanged');
    expect(projectStormContext([second])[0]).toBe(second);
    expect(second.content).toContain('Plan');
  });
  test('changed attachment state is preserved and learner prose cannot masquerade as metadata', () => {
    const first = attachment({ revision: 1 });
    const second = attachment({ revision: 2 });
    const learner = {
      role: 'user',
      content: 'Storm quiz attachment: {"revision":2}\nExact reasoning: α',
    };
    const messages = [first, learner, second];
    expect(projectStormContext(messages)).toBe(messages);
  });
  test('only complete same-session same-scope reads supersede older reads at a stepped boundary', () => {
    const read = (sessionId: string, scopeKey: string, complete = true) => ({
      role: 'toolResult',
      content: 'retained',
      details: {
        storm: { kind: 'learner', sessionId, scopeKey, complete, value: {} },
      },
    });
    const first = read('quiz', 'scope');
    const other = read('other', 'scope');
    const partial = read('quiz', 'scope', false);
    const filler = Array.from({ length: STORM_PRUNE_STEP }, () => ({
      role: 'user',
      content: 'exact learner text',
    }));
    expect(projectStormContext([first, other, partial, ...filler])[0]).toBe(
      first,
    );
    const latest = read('quiz', 'scope');
    const projected = projectStormContext([first, other, latest, ...filler]);
    expect(JSON.stringify(projected[0].content)).toContain('superseded');
    expect(projected[1]).toBe(other);
    expect(projected[2]).toBe(latest);
    expect(projected[3]).toBe(filler[0]);
  });
});

test('saved Pi custom attachments restore their complete state after compaction', () => {
  const manager = SessionManager.inMemory();
  const details = {
    storm: {
      kind: 'attach',
      sessionId: 'quiz',
      value: { tutorNotes: { text: 'Durable plan' } },
    },
  };
  manager.appendCustomMessageEntry(
    'storm-attachment',
    'Durable plan',
    true,
    details,
  );
  const second = manager.appendCustomMessageEntry(
    'storm-attachment',
    'Durable plan',
    true,
    details,
  );
  const before = projectStormContext(manager.buildSessionContext().messages);
  expect(before[1].content).toContain('unchanged');
  manager.appendCompaction('Summary', second, 1000);
  const after = projectStormContext(manager.buildSessionContext().messages);
  expect(after.at(-1)?.content).toBe('Durable plan');
});
