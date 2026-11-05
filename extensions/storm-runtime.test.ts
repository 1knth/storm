import { describe, expect, test } from 'bun:test';
import { SessionManager } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js';
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
  pruneStormContext,
  reattachPrompt,
  compactAttachPrompts,
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
    expect(prompt).toContain(
      'set the explicit verdict field to correct, partial, or incorrect',
    );
    expect(prompt).toContain('do not repeat a verdict heading');
    expect(prompt).toContain('Never use Markdown headings');
    expect(prompt).toContain('inline Markdown only');
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

  test('attach provides adaptive practice and confidence policy without weakening Continue or Skip', () => {
    const prompt = attachPrompt({ id: 'quiz', status: 'connected' });
    for (const guidance of [
      'After Continue and before choosing or posing a question, read storm with action learner',
      'Tag every substantive question with concepts, level, and support',
      'Reuse existing concept IDs',
      'help actually supplied, not help merely planned',
      'action support-update',
      'strongest support (independent < hinted < worked)',
      'Levels are recall, explain, apply, transfer',
      'independent performance, zpd',
      'beyond (teach with support first)',
      'explain new material before testing it',
      'Target predicted independent success of 0.70–0.85',
      'at most about a third of questions',
      'easiest ZPD concept first at its recommended level and support',
      'After two misses at one level, step down a level or add support',
      'a worked example or contrasting case',
      'Above the band independently, raise the level, offer transfer, or move on',
      'Fade support from worked to hinted to independent',
      'Once two or more concepts are introduced, mix earlier concepts in',
      'data.confidence (0–100)',
      'High-confidence incorrect or partial answers (>=70) are correction candidates',
      'Low-confidence correct answers need brief reinforcement of why',
      'calibration.guidanceEligible is true',
      'at least 20 ratings',
      'at most one brief, supportive comment per session',
      'fresh item at the recommended level and support',
      'Recommendations are advisory; explicit learner requests win',
      'Never present model numbers as grades or as a mastery verdict',
      'Mastery verdicts follow the Tutor evidence criteria',
      'Rated graded answers inform confidence calibration even when untagged',
      'Keep the existing Continue and Skip rules',
      'continue only after explicit Continue or learner Skip',
      'use storm with action skip-question',
    ])
      expect(prompt).toContain(guidance);
  });

  test('attach states extension waiter ownership so the clipboard need not repeat it', () => {
    const prompt = attachPrompt({ id: 'quiz', status: 'connected' });
    for (const guidance of [
      'The extension owns learner-event delivery in this session',
      'do not start another attach, wait subprocess, listener, polling loop, or subagent',
      'then end your turn',
      'makes no idle model calls',
    ])
      expect(prompt).toContain(guidance);
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

  const call = (id: string, name: string, args: Record<string, unknown>) => ({
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: args }],
  });
  const result = (id: string, name: string, text: string) => ({
    role: 'toolResult',
    toolCallId: id,
    toolName: name,
    content: [{ type: 'text', text }],
  });
  const filler = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      role: 'user',
      content: `filler ${i}`,
    }));
  const conversation = () => [
    {
      role: 'user',
      content:
        'You are tutoring in an explicitly attached Storm quiz. Initial quiz state: {"id":"quiz-a","note":"first {state}"}. Long instructions.',
    },
    call('l1', 'storm', { action: 'learner' }),
    result('l1', 'storm', '{"learner":"one","omittedConcepts":0}'),
    call('n1', 'storm', { action: 'notes', text: 'full notes v1' }),
    result('n1', 'storm', '{"tutorNotes":{"version":1}}'),
    call('st1', 'storm', { action: 'status' }),
    result('st1', 'storm', '{"studyContextChanged":{"available":true}}'),
    call('s1', 'storm_study', { action: 'retrieve', query: 'a' }),
    result(
      's1',
      'storm_study',
      '{"snapshotId":"snap","chunks":[{"text":"source"}]}',
    ),
    {
      role: 'user',
      content:
        'You are tutoring in an explicitly attached Storm quiz. Initial quiz state: {"id":"quiz-a","note":"second"}. Long instructions.',
    },
    call('l2', 'storm', { action: 'learner' }),
    result('l2', 'storm', '{"learner":"two","omittedConcepts":0}'),
    call('n2', 'storm', { action: 'notes', text: 'full notes v2' }),
    result('n2', 'storm', '{"tutorNotes":{"version":2}}'),
    call('st2', 'storm', { action: 'status' }),
    result('st2', 'storm', '{"revision":9}'),
  ];
  const text = (m: any) =>
    typeof m.content === 'string' ? m.content : JSON.stringify(m.content);

  test('nothing changes before the first boundary', () => {
    const messages = conversation();
    expect(pruneStormContext(messages)).toBe(messages);
  });

  test('superseded Storm material becomes stubs and the latest stays verbatim', () => {
    const messages = [...conversation(), ...filler(STORM_PRUNE_STEP * 2)];
    const pruned = pruneStormContext(messages) as any[];
    expect(text(pruned[0])).toBe(
      'Earlier Storm attach. Follow the full instructions retained in this conversation; its quiz state then was: {"id":"quiz-a","note":"first {state}"}',
    );
    expect(text(pruned[9])).toContain('second');
    expect(text(pruned[2])).toContain('superseded by a later learner read');
    expect(text(pruned[11])).toBe(text(messages[11]));
    expect(pruned[3].content[0].arguments.text).toContain('Superseded');
    expect(pruned[12].content[0].arguments.text).toBe('full notes v2');
    // A status that reported a scope change keeps its bootstrap.
    expect(text(pruned[6])).toContain('studyContextChanged');
    // Study packets are never stubbed.
    expect(text(pruned[8])).toContain('source');
    expect(messages[0].content).toContain('Long instructions');
  });

  test('failed reads and notes writes do not supersede earlier ones', () => {
    const messages = [
      call('l1', 'storm', { action: 'learner' }),
      result('l1', 'storm', '{"learner":"one","omittedConcepts":0}'),
      call('n1', 'storm', { action: 'notes', text: 'saved notes' }),
      result('n1', 'storm', '{"tutorNotes":{"version":1}}'),
      call('l2', 'storm', { action: 'learner' }),
      { ...result('l2', 'storm', 'CLI failed'), isError: true },
      call('st1', 'storm', { action: 'status' }),
      result('st1', 'storm', '{"revision":1}'),
      call('st2', 'storm', { action: 'status' }),
      result(
        'st2',
        'storm',
        'No Storm quiz attached; use /storm attach SESSION_ID.',
      ),
      call('n2', 'storm', { action: 'notes', text: 'x'.repeat(7000) }),
      { ...result('n2', 'storm', 'too long'), isError: true },
      ...filler(STORM_PRUNE_STEP),
    ];
    expect(pruneStormContext(messages)).toBe(messages);
  });

  test('a learner read that omitted concepts does not replace earlier ones', () => {
    const messages = [
      call('l1', 'storm', { action: 'learner' }),
      result('l1', 'storm', '{"concepts":[{"id":"old"}],"omittedConcepts":0}'),
      call('l2', 'storm', { action: 'learner' }),
      result('l2', 'storm', '{"concepts":[{"id":"new"}],"omittedConcepts":1}'),
      ...filler(STORM_PRUNE_STEP),
    ];
    expect(pruneStormContext(messages)).toBe(messages);
  });

  test('reads and notes about another quiz or learner scope are kept', () => {
    const attach = (id: string) => ({
      role: 'user',
      content: `You are tutoring in an explicitly attached Storm quiz. Initial quiz state: {"id":"${id}"}. Instructions.`,
    });
    const messages = [
      attach('quiz-a'),
      call('l1', 'storm', { action: 'learner' }),
      result('l1', 'storm', '{"scopeKey":"vault-a","omittedConcepts":0}'),
      call('n1', 'storm', { action: 'notes', text: 'quiz A notes' }),
      result('n1', 'storm', '{"tutorNotes":{"version":1}}'),
      attach('quiz-b'),
      call('l2', 'storm', { action: 'learner' }),
      // Same vault learner scope, different quiz.
      result('l2', 'storm', '{"scopeKey":"vault-a","omittedConcepts":0}'),
      call('n2', 'storm', { action: 'notes', text: 'quiz B notes' }),
      result('n2', 'storm', '{"tutorNotes":{"version":1}}'),
      ...filler(STORM_PRUNE_STEP),
    ] as any[];
    const pruned = pruneStormContext(messages) as any[];
    expect(text(pruned[2])).toContain('vault-a');
    expect(pruned[3].content[0].arguments.text).toBe('quiz A notes');
    // Only the repeated attach instructions go.
    expect(text(pruned[0])).toContain(
      'its quiz state then was: {"id":"quiz-a"}',
    );
  });

  test('an attach whose instructions differ from the latest is kept', () => {
    const attach = (id: string, guidance: string) => ({
      role: 'user',
      content: `You are tutoring in an explicitly attached Storm quiz. Initial quiz state: {"id":"${id}"}. ${guidance}`,
    });
    const messages = [
      attach('quiz-a', 'Scoped guidance.'),
      attach('quiz-b', 'Unscoped guidance.'),
      ...filler(STORM_PRUNE_STEP),
    ] as any[];
    expect(pruneStormContext(messages)).toBe(messages);
  });

  test('a result separated from its call by an attach supersedes nothing', () => {
    const attach = (id: string) => ({
      role: 'user',
      content: `You are tutoring in an explicitly attached Storm quiz. Initial quiz state: {"id":"${id}"}. Instructions.`,
    });
    const messages = [
      attach('quiz-b'),
      call('st1', 'storm', { action: 'status' }),
      result('st1', 'storm', '{"revision":1}'),
      call('st2', 'storm', { action: 'status' }),
      // An attach whose quiz state cannot be read starts its own segment.
      {
        role: 'user',
        content:
          'You are tutoring in an explicitly attached Storm quiz. Malformed.',
      },
      result('st2', 'storm', '{"revision":2}'),
      ...filler(STORM_PRUNE_STEP),
    ] as any[];
    const pruned = pruneStormContext(messages) as any[];
    expect(text(pruned[2])).not.toContain('superseded');
  });

  test('a result separated from its call by an attach is not superseded', () => {
    const attach = (id: string) => ({
      role: 'user',
      content: `You are tutoring in an explicitly attached Storm quiz. Initial quiz state: {"id":"${id}"}. Instructions.`,
    });
    const messages = [
      attach('quiz-a'),
      call('c1', 'storm', { action: 'status' }),
      attach('quiz-b'),
      result('c1', 'storm', '{"id":"quiz-a","revision":7}'),
      call('c2', 'storm', { action: 'status' }),
      result('c2', 'storm', '{"id":"quiz-b","revision":1}'),
      ...filler(STORM_PRUNE_STEP),
    ] as any[];
    const pruned = pruneStormContext(messages) as any[];
    expect(text(pruned[3])).not.toContain('superseded');
  });

  test('results pair with the latest call of a reused id', () => {
    const messages = [
      call('call_0', 'storm', { action: 'status' }),
      result('call_0', 'storm', '{"revision":1}'),
      call('call_0', 'storm', { action: 'question', text: 'Q' }),
      result(
        'call_0',
        'storm',
        '{"message":"Storm quiz updated (pose-question)."}',
      ),
      call('call_1', 'storm', { action: 'status' }),
      result('call_1', 'storm', '{"revision":2}'),
      ...filler(STORM_PRUNE_STEP),
    ] as any[];
    const pruned = pruneStormContext(messages) as any[];
    expect(text(pruned[1])).toContain('superseded by a later status read');
    // The question write result is not mistaken for a status read.
    expect(text(pruned[3])).toContain('pose-question');
  });

  test('later reads only stub earlier ones once the boundary passes them', () => {
    const base = [...conversation(), ...filler(STORM_PRUNE_STEP * 2 - 4)];
    const before = pruneStormContext(base);
    // A learner read arriving after the boundary leaves the prefix untouched.
    const after = pruneStormContext([
      ...base,
      call('l3', 'storm', { action: 'learner' }),
      result('l3', 'storm', '{"learner":"three","omittedConcepts":0}'),
    ]);
    expect(JSON.stringify(after.slice(0, before.length))).toBe(
      JSON.stringify(before),
    );
    expect(text(after[11])).toContain('two');
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

describe('reattach', () => {
  const session = { id: 'quiz-a', revision: 3, status: 'connected' };
  test('effective SDK context restores full attaches after compaction or omission', () => {
    const full = attachPrompt(
      { ...session, tutorNotes: { text: 'Retained plan', version: 2 } },
      { study: { indexRevision: 'r1', entries: [{ path: 'retained.pdf' }] } },
    );
    for (const operation of ['compact', 'omit'] as const) {
      const manager = SessionManager.inMemory();
      const first = manager.appendMessage({
        role: 'user',
        content: full,
        timestamp: 1,
      });
      const second = manager.appendMessage({
        role: 'user',
        content: full,
        timestamp: 2,
      });
      const before = compactAttachPrompts(
        manager.buildSessionContext().messages,
      );
      expect(before[1].content).not.toContain('Retained plan');
      expect(before[1].content).toContain('Reattached in this conversation');
      // Shortening is transient: the saved second attach remains complete.
      expect(manager.buildSessionContext().messages[1].content).toBe(full);
      if (operation === 'compact')
        manager.appendCompaction('Summary', second, 1000);
      else manager.appendContextEdit(first, null);
      const after = pruneStormContext(
        compactAttachPrompts(manager.buildSessionContext().messages),
      );
      expect(after.at(-1)?.content).toBe(full);
    }
  });

  test('references survive earlier attach pruning across multiple boundaries', () => {
    const study = { indexRevision: 'r1', entries: [{ path: 'retained.pdf' }] };
    const full = attachPrompt(
      { ...session, tutorNotes: { text: 'Retained plan', version: 2 } },
      { study },
    );
    const filler = Array.from({ length: STORM_PRUNE_STEP }, () => ({
      role: 'user',
      content: 'filler',
    }));
    const prior = [
      { role: 'user', content: full },
      { role: 'user', content: full },
      ...filler,
    ];
    expect(pruneStormContext(prior)[0].content).toContain(
      'Earlier Storm attach.',
    );
    const short = reattachPrompt(full, [full, full]);
    const pruned = pruneStormContext([
      ...prior,
      { role: 'user', content: short },
      ...filler,
    ]);
    // Even a shortened earlier attach retains its complete state. The latest
    // short attach also prevents pruning the full instructions it references.
    expect(JSON.stringify(pruned)).toContain('retained.pdf');
    expect(JSON.stringify(pruned)).toContain('Retained plan');
    expect(pruned[1].content).toBe(full);
  });

  test('a re-attach with instructions already held sends only the state', () => {
    const first = attachPrompt(session, { contextId: 'one' });
    const again = attachPrompt(
      { ...session, revision: 4 },
      { contextId: 'two' },
    );
    const short = reattachPrompt(again, ['other message', first]);
    expect(short.length).toBeLessThan(again.length / 3);
    expect(short).toContain('"revision":4');
    expect(short).toContain('"contextId":"two"');
    expect(short).toContain('instructions given in the earlier attach above');
    // The pruner keeps the earlier full attach, whose instructions differ.
    const messages = [
      { role: 'user', content: first },
      { role: 'user', content: short },
      ...Array.from({ length: STORM_PRUNE_STEP }, (_, i) => ({
        role: 'user',
        content: `filler ${i}`,
      })),
    ];
    expect(pruneStormContext(messages)).toBe(messages);
  });

  test('an unchanged study listing and notes text are referenced, changed ones sent', () => {
    const study = {
      available: true,
      indexRevision: 'r1',
      entries: [{ path: 'a.pdf' }],
    };
    const notes = { text: 'Plan: logic laws', version: 2 };
    const first = attachPrompt({ ...session, tutorNotes: notes }, { study });
    const same = reattachPrompt(
      attachPrompt({ ...session, tutorNotes: notes }, { study }),
      [first],
    );
    expect(same).not.toContain('a.pdf');
    expect(same).not.toContain('Plan: logic laws');
    expect(same).toContain('indexRevision r1) is in the earlier attach');
    const changed = reattachPrompt(
      attachPrompt(
        { ...session, tutorNotes: { text: 'Plan v3', version: 3 } },
        {
          study: {
            ...study,
            indexRevision: 'r2',
            entries: [{ path: 'b.pdf' }],
          },
        },
      ),
      [first],
    );
    expect(changed).toContain('b.pdf');
    expect(changed).toContain('Plan v3');
  });

  test('instructions not already held are sent in full', () => {
    const scoped = attachPrompt({ ...session, scope: { folderPath: '.' } });
    const unscoped = attachPrompt(session);
    expect(reattachPrompt(unscoped, [scoped])).toBe(unscoped);
    expect(reattachPrompt(unscoped, [])).toBe(unscoped);
  });
});
