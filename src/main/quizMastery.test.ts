import { describe, it as test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuizService } from './quizService';
import { quizRevisionChange } from './quizOperations';
import { QuizStore } from './quizStore';
import { LearnerStore, learnerScopeKey } from './learnerStore';
import { createHash } from 'node:crypto';
import type { LearnerAttempt } from '../shared/learnerModel';
import { questionFingerprintSource } from '../shared/mastery';
import {
  QUIZ_PRACTICE_TEST_MAX_TRANSITIONS,
  type QuizResult,
  type QuizSession,
} from '../shared/quizProtocol';

const value = (result: QuizResult<QuizSession>) => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as { value: QuizSession }).value;
};

const vault = {
  vaultId: 'vault',
  notePath: 'loops.md',
  selectedNotePaths: [],
  folderPath: null,
};

/** A connected session with a two-node map, driven through the public service API. */
async function fixture(
  options: {
    attempts?: LearnerAttempt[];
    /** Record grades in a real learner store, as the app does. */
    learner?: boolean;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'storm-mastery-'));
  const store = new QuizStore(join(dir, 'quiz.json'));
  const learnerStore = new LearnerStore(join(dir, 'learner.json'));
  if (options.attempts)
    await store.importLearner({
      [learnerScopeKey(vault)]: { attempts: options.attempts },
    });
  const service = new QuizService(
    store,
    () => true,
    undefined,
    undefined,
    undefined,
    learnerStore,
  );

  const cleanup = () => rm(dir, { recursive: true, force: true });
  return {
    ...(await session(service)),
    store,
    service,
    learnerStore,
    dir,
    cleanup,
  };
}

/** Another connected quiz in the same vault, sharing its learning pool. */
async function session(service: QuizService, scope = vault) {
  const created = value(await service.createSession(scope));
  const { id, agentToken } = created;
  let revision = created.revision;
  let key = 0;
  const agent = async (type: string, fields = {}) => {
    const result = await service.request({
      type,
      sessionId: id,
      agentToken,
      expectedRevision: revision,
      idempotencyKey: `k${++key}`,
      ...fields,
    } as never);
    if (result.ok) revision = result.value.revision;
    return result;
  };
  const learner = async (type: string, fields = {}) => {
    const result = await service.learnerRequest({
      type,
      sessionId: id,
      expectedRevision: revision,
      idempotencyKey: `k${++key}`,
      ...fields,
    } as never);
    if (result.ok) revision = result.value.revision;
    return result;
  };
  value(await agent('attach'));
  value(
    await agent('lesson-map', {
      map: {
        nodes: [
          { id: 'loops', label: 'Loops' },
          { id: 'arrays', label: 'Arrays' },
        ],
        edges: [['loops', 'arrays']],
      },
    }),
  );
  /** Pose, answer and grade one multiple-choice item, then continue. */
  const item = async (
    prompt: string,
    grade: {
      level?: string;
      concepts?: string[];
      verdict?: string;
      reasoning?: string;
      stated?: string;
      support?: string;
    } = {},
  ) => {
    value(
      await agent('pose-question', {
        question: prompt,
        choices: [
          { id: 'a', text: 'Yes' },
          { id: 'b', text: 'No' },
        ],
        concepts: grade.concepts ?? ['loops'],
        level: grade.level ?? 'apply',
        ...(grade.support ? { support: grade.support } : {}),
      }),
    );
    value(
      await learner('answer', {
        choiceId: 'a',
        reasoning: grade.stated ?? 'Because the condition is checked first.',
      }),
    );
    const graded = value(
      await agent('feedback', {
        text: 'Graded.',
        verdict: grade.verdict ?? 'correct',
        ...(grade.reasoning ? { reasoning: grade.reasoning } : {}),
      }),
    );
    value(await learner('continue'));
    return graded;
  };
  const status = (status: string) =>
    agent('lesson-map', { map: { statuses: { loops: status } } });
  return { id, agent, learner, item, status };
}

describe('mastery evidence', () => {
  test('mastered is rejected with what is missing, then accepted once the record supports it', async () => {
    const f = await fixture();
    try {
      await f.item('Does a while loop check first?', { level: 'explain' });
      const early = await f.status('mastered');
      assert.equal(early.ok, false);
      assert.equal((early as { error: string }).error, 'invalid-input');
      assert.match(
        (early as { message?: string }).message ?? '',
        /loops: needs 1 more fresh independent correct item; .*practice test; .*reasoning "sound"/,
      );

      // Other statuses are the tutor's call and are never gated.
      value(await f.status('independent'));

      value(
        await f.agent('practice-test', {
          action: 'start',
          concepts: ['loops'],
        }),
      );
      await f.item('Will this loop run zero times?', { reasoning: 'sound' });
      value(await f.agent('practice-test', { action: 'end' }));
      const accepted = value(await f.status('mastered'));
      assert.equal(accepted.lessonMap?.statuses.loops, 'mastered');

      // Retained needs a later session; this one cannot show it.
      const retained = await f.status('retained');
      assert.match(
        (retained as { message?: string }).message ?? '',
        /later session/,
      );
    } finally {
      await f.cleanup();
    }
  });

  test('an independent miss moves a mastered node to needs-review', async () => {
    const f = await fixture();
    try {
      await f.item('First loop item', { level: 'explain', reasoning: 'sound' });
      value(
        await f.agent('practice-test', {
          action: 'start',
          concepts: ['loops'],
        }),
      );
      await f.item('Test loop item');
      value(await f.agent('practice-test', { action: 'end' }));
      value(await f.status('mastered'));
      const missed = await f.item('Later loop item', { verdict: 'incorrect' });
      assert.equal(missed.lessonMap?.statuses.loops, 'needs-review');
      // The miss is now the latest independent answer, so mastery is withdrawn.
      assert.equal((await f.status('mastered')).ok, false);
    } finally {
      await f.cleanup();
    }
  });

  test('practice tests hold test conditions and end only when every concept is covered', async () => {
    const f = await fixture();
    try {
      const unknown = await f.agent('practice-test', {
        action: 'start',
        concepts: ['recursion'],
      });
      assert.match(
        (unknown as { message?: string }).message ?? '',
        /Not lesson map nodes: recursion/,
      );
      await f.item('Asked before the test');
      const started = value(
        await f.agent('practice-test', {
          action: 'start',
          concepts: ['loops', 'arrays'],
        }),
      );
      assert.deepEqual(started.practiceTest?.concepts, ['loops', 'arrays']);

      const pose = (fields: object) =>
        f.agent('pose-question', {
          question: 'Fresh test item',
          choices: [
            { id: 'a', text: 'Yes' },
            { id: 'b', text: 'No' },
          ],
          concepts: ['loops'],
          level: 'apply',
          ...fields,
        });
      const message = async (fields: object) =>
        ((await pose(fields)) as { message?: string }).message ?? '';
      assert.match(await message({ support: 'hinted' }), /independent/);
      assert.match(await message({ concepts: ['other'] }), /test concept/);
      assert.match(
        await message({ question: 'Asked before the test' }),
        /already seen this item/,
      );
      const untagged = await f.agent('pose-question', {
        question: 'Untagged item',
        kind: 'short-answer',
        unmodelledReason: 'warm-up',
      });
      assert.match((untagged as { message?: string }).message ?? '', /tagged/);

      const posed = value(await pose({}));
      assert.equal(posed.currentQuestion?.testId, started.practiceTest?.id);
      const help = await f.agent('support-update', {
        questionId: posed.currentQuestion!.id,
        support: 'hinted',
        text: 'Think about the condition.',
      });
      assert.match((help as { message?: string }).message ?? '', /no help/);
      // The tutor may still clarify wording in chat during a test item.
      value(await f.agent('agent-message', { text: 'n is the list length.' }));
      const early = await f.agent('practice-test', { action: 'end' });
      assert.match(
        (early as { message?: string }).message ?? '',
        /current test item/,
      );

      value(await f.learner('answer', { choiceId: 'a', reasoning: 'r' }));
      value(
        await f.agent('feedback', { text: 'Correct.', verdict: 'correct' }),
      );
      value(await f.learner('continue'));
      const uncovered = await f.agent('practice-test', { action: 'end' });
      assert.match(
        (uncovered as { message?: string }).message ?? '',
        /no graded item yet for: arrays/,
      );
      const cancelled = value(
        await f.agent('practice-test', { action: 'cancel' }),
      );
      assert.equal(cancelled.practiceTest, undefined);
      value(await f.agent('agent-message', { text: 'Nice work.' }));
    } finally {
      await f.cleanup();
    }
  });

  test('a reasoning grade needs stated reasoning and travels with the transcript', async () => {
    const f = await fixture();
    try {
      value(
        await f.agent('pose-question', {
          question: 'No reasoning given',
          choices: [
            { id: 'a', text: 'Yes' },
            { id: 'b', text: 'No' },
          ],
          concepts: ['loops'],
          level: 'recall',
        }),
      );
      value(await f.learner('answer', { choiceId: 'a', reasoning: '  ' }));
      const sound = await f.agent('feedback', {
        text: 'Correct.',
        verdict: 'correct',
        reasoning: 'sound',
      });
      assert.match(
        (sound as { message?: string }).message ?? '',
        /no reasoning/,
      );
      const none = value(
        await f.agent('feedback', {
          text: 'Correct.',
          verdict: 'correct',
          reasoning: 'none',
        }),
      );
      const graded = none.transcript.at(-1)?.question;
      assert.equal(graded?.reasoning, 'none');
      assert.match(graded?.fingerprint ?? '', /^[a-f0-9]{64}$/);
    } finally {
      await f.cleanup();
    }
  });

  test('only an ended test counts: open and cancelled tests give no credit', async () => {
    const f = await fixture();
    try {
      await f.item('Explain the loop', {
        level: 'explain',
        reasoning: 'sound',
      });
      value(
        await f.agent('practice-test', {
          action: 'start',
          concepts: ['loops'],
        }),
      );
      await f.item('Test item one');
      const open = await f.status('mastered');
      assert.match(
        (open as { message?: string }).message ?? '',
        /in a practice test/,
      );
      value(await f.agent('practice-test', { action: 'cancel' }));
      assert.equal((await f.status('mastered')).ok, false);

      // A test cancelled with an item open lifts its restrictions on that item.
      value(
        await f.agent('practice-test', {
          action: 'start',
          concepts: ['loops'],
        }),
      );
      const posed = value(
        await f.agent('pose-question', {
          question: 'Abandoned test item',
          kind: 'short-answer',
          concepts: ['loops'],
          level: 'apply',
        }),
      );
      value(await f.agent('practice-test', { action: 'cancel' }));
      value(
        await f.agent('support-update', {
          questionId: posed.currentQuestion!.id,
          support: 'hinted',
          text: 'Start from the condition.',
        }),
      );
    } finally {
      await f.cleanup();
    }
  });

  test('test requests replay by idempotency key without touching a newer test', async () => {
    const f = await fixture();
    try {
      const { agentToken } = (await f.store.get(f.id))!;
      const request = (action: string, key: string, concepts?: string[]) =>
        f.service.request({
          type: 'practice-test',
          sessionId: f.id,
          agentToken,
          expectedRevision: 0,
          idempotencyKey: key,
          action,
          ...(concepts ? { concepts } : {}),
        } as never);
      const first = value(await request('start', 'start-a', ['loops']));
      const replay = value(await request('start', 'start-a', ['loops']));
      assert.equal(replay.practiceTest?.id, first.practiceTest?.id);
      value(await request('cancel', 'cancel-a'));
      const second = value(await request('start', 'start-b', ['arrays']));
      const stale = value(await request('cancel', 'cancel-a'));
      assert.equal(stale.practiceTest?.id, second.practiceTest?.id);
      const reused = await request('end', 'start-b');
      assert.match(
        (reused as { message?: string }).message ?? '',
        /different test request/,
      );
    } finally {
      await f.cleanup();
    }
  });

  test('a write prepared before a test started keeps the test open', async () => {
    const f = await fixture();
    try {
      const before = (await f.store.get(f.id))!;
      value(
        await f.agent('practice-test', {
          action: 'start',
          concepts: ['loops'],
        }),
      );
      // Commit a semantic update built from the snapshot read before the test.
      const committed = await f.store.update(
        quizRevisionChange(before, {
          ...before,
          revision: before.revision + 1,
        }),
        before.revision,
        {
          cursor: before.eventCursor + 1,
          revision: before.revision + 1,
          type: 'agent-message',
          data: { text: 'hi' },
          createdAt: new Date().toISOString(),
        },
        `${f.id}:late`,
        'late',
      );
      assert.equal(committed.practiceTest?.concepts[0], 'loops');
    } finally {
      await f.cleanup();
    }
  });

  test('freshness spans sessions in the pool, including skipped items', async () => {
    const f = await fixture();
    try {
      value(
        await f.agent('pose-question', {
          question: 'Shown then skipped',
          choices: [
            { id: 'a', text: 'Yes' },
            { id: 'b', text: 'No' },
          ],
          concepts: ['loops'],
          level: 'apply',
        }),
      );
      const open = (await f.store.get(f.id))!.currentQuestion!;
      value(
        await f.agent('skip-question', {
          questionId: open.id,
          text: 'Skipped.',
        }),
      );
      const later = await session(f.service);
      value(
        await later.agent('practice-test', {
          action: 'start',
          concepts: ['loops'],
        }),
      );
      const reused = await later.agent('pose-question', {
        question: 'Shown then skipped',
        choices: [
          { id: 'x', text: 'No' },
          { id: 'y', text: 'Yes' },
        ],
        concepts: ['loops'],
        level: 'apply',
      });
      assert.match(
        (reused as { message?: string }).message ?? '',
        /already seen this item/,
      );
    } finally {
      await f.cleanup();
    }
  });

  test('hidden fields do not make a multiple-choice item fresh', async () => {
    const f = await fixture();
    try {
      await f.item('Same visible item');
      value(
        await f.agent('practice-test', {
          action: 'start',
          concepts: ['loops'],
        }),
      );
      const disguised = await f.agent('pose-question', {
        question: 'Same visible item',
        choices: [
          { id: 'a', text: 'Yes' },
          { id: 'b', text: 'No' },
        ],
        leftItems: [{ id: 'l', text: 'invisible' }],
        concepts: ['loops'],
        level: 'apply',
      });
      assert.match(
        (disguised as { message?: string }).message ?? '',
        /already seen this item/,
      );
    } finally {
      await f.cleanup();
    }
  });

  test('canonical mastery evidence stays available after the legacy learner file becomes unreadable', async () => {
    const f = await fixture();
    try {
      await writeFile(
        join(f.dir, 'learner.json'),
        'invalid legacy JSON after import',
      );
      await f.item('Explain it', { level: 'explain', reasoning: 'sound' });
      value(
        await f.agent('practice-test', {
          action: 'start',
          concepts: ['loops'],
        }),
      );
      await f.item('Apply it');
      value(await f.agent('practice-test', { action: 'end' }));
      assert.equal(
        value(await f.status('mastered')).lessonMap?.statuses.loops,
        'mastered',
      );
    } finally {
      await f.cleanup();
    }
  });

  const holdNextMetadata = (store: QuizStore) => {
    const original = store.transactMetadata.bind(store);
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    store.transactMetadata = async (...args) => {
      store.transactMetadata = original;
      reached();
      await released;
      return original(...args);
    };
    return { waiting, release };
  };

  /** Holds the next store.update until released, to interleave a competing request. */
  const holdNextUpdate = (store: QuizStore) => {
    const original = store.update.bind(store);
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => (reached = resolve));
    store.update = (async (...args: Parameters<QuizStore['update']>) => {
      store.update = original;
      reached();
      await released;
      return original(...args);
    }) as QuizStore['update'];
    return { waiting, release };
  };

  test('a miss committed after a concurrent mastery claim still demotes the node', async () => {
    const f = await fixture();
    try {
      await f.item('Explain it', { level: 'explain', reasoning: 'sound' });
      value(
        await f.agent('practice-test', {
          action: 'start',
          concepts: ['loops'],
        }),
      );
      await f.item('Apply it');
      value(await f.agent('practice-test', { action: 'end' }));
      value(
        await f.agent('pose-question', {
          question: 'Later item',
          kind: 'short-answer',
          concepts: ['loops'],
          level: 'apply',
        }),
      );
      value(await f.learner('answer', { answer: 'wrong' }));
      const hold = holdNextUpdate(f.store);
      const miss = f.agent('feedback', {
        text: 'Not quite.',
        verdict: 'incorrect',
      });
      await hold.waiting;
      // The claim commits while the miss is in flight, so its gate passes.
      value(await f.status('mastered'));
      hold.release();
      const graded = value(await miss);
      assert.equal(graded.lessonMap?.statuses.loops, 'needs-review');
    } finally {
      await f.cleanup();
    }
  });

  test('a question in flight when a test starts is rejected, not posed outside test rules', async () => {
    const f = await fixture();
    try {
      const hold = holdNextUpdate(f.store);
      const pose = f.agent('pose-question', {
        question: 'Hinted item',
        kind: 'short-answer',
        concepts: ['loops'],
        level: 'apply',
        support: 'hinted',
      });
      await hold.waiting;
      value(
        await f.agent('practice-test', {
          action: 'start',
          concepts: ['loops'],
        }),
      );
      hold.release();
      assert.deepEqual(await pose, { ok: false, error: 'stale-revision' });
      const after = (await f.store.get(f.id))!;
      assert.equal(after.currentQuestion, null);
      assert.ok(after.practiceTest);
    } finally {
      await f.cleanup();
    }
  });

  test('saved attempts from deleted quizzes still make an item stale in a test', async () => {
    const prompt = 'Answered in a deleted quiz';
    const choices = [
      { id: 'a', text: 'Yes' },
      { id: 'b', text: 'No' },
    ];
    const fingerprint = createHash('sha256')
      .update(
        questionFingerprintSource({ kind: 'multiple-choice', prompt, choices }),
      )
      .digest('hex');
    const f = await fixture({
      attempts: [
        {
          id: 'old',
          sessionId: 'deleted',
          scopeSignature: 'old',
          at: '2026-01-01T00:00:00.000Z',
          concepts: ['loops'],
          level: 'apply',
          support: 'independent',
          verdict: 'correct',
          fingerprint,
        },
      ],
    });
    try {
      value(
        await f.agent('practice-test', {
          action: 'start',
          concepts: ['loops'],
        }),
      );
      const reused = await f.agent('pose-question', {
        question: prompt,
        choices,
        concepts: ['loops'],
        level: 'apply',
      });
      assert.match(
        (reused as { message?: string }).message ?? '',
        /already seen this item/,
      );
    } finally {
      await f.cleanup();
    }
  });

  test('a session at the test transition limit refuses more instead of forgetting receipts', async () => {
    const f = await fixture();
    try {
      const { agentToken } = (await f.store.get(f.id))!;
      const request = (action: string, key: string) =>
        f.service.request({
          type: 'practice-test',
          sessionId: f.id,
          agentToken,
          expectedRevision: 0,
          idempotencyKey: key,
          action,
          ...(action === 'start' ? { concepts: ['loops'] } : {}),
        } as never);
      for (let i = 0; i < QUIZ_PRACTICE_TEST_MAX_TRANSITIONS / 2; i++) {
        value(await request('start', `s${i}`));
        value(await request('cancel', `c${i}`));
      }
      const full = await request('start', 'one-more');
      assert.match((full as { message?: string }).message ?? '', /limit/);
      // The very first receipt still replays as already handled.
      assert.equal((await request('cancel', 'c0')).ok, true);
    } finally {
      await f.cleanup();
    }
  });

  test('a mastery claim is judged against other pool sessions at commit time', async () => {
    const f = await fixture();
    try {
      await f.item('Explain it', { level: 'explain', reasoning: 'sound' });
      value(
        await f.agent('practice-test', {
          action: 'start',
          concepts: ['loops'],
        }),
      );
      await f.item('Apply it');
      value(await f.agent('practice-test', { action: 'end' }));
      const other = await session(f.service);
      // Hold the other quiz's claim inside its read, then commit a miss here.
      const original = f.store.transactMetadata.bind(f.store);
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      f.store.transactMetadata = (async (
        ...args: Parameters<QuizStore['transactMetadata']>
      ) => {
        f.store.transactMetadata = original;
        await released;
        return original(...args);
      }) as QuizStore['transactMetadata'];
      const claim = other.status('mastered');
      await f.item('Later item', { verdict: 'incorrect' });
      release();
      const result = await claim;
      assert.match(
        (result as { message?: string }).message ?? '',
        /since the latest independent miss/,
      );
    } finally {
      await f.cleanup();
    }
  });

  test('two pool sessions cannot both pose the same test item', async () => {
    const f = await fixture();
    try {
      const other = await session(f.service);
      for (const quiz of [f, other])
        value(
          await quiz.agent('practice-test', {
            action: 'start',
            concepts: ['loops'],
          }),
        );
      const item = {
        question: 'Shared wording',
        kind: 'short-answer',
        concepts: ['loops'],
        level: 'apply',
      };
      const hold = holdNextUpdate(f.store);
      const first = f.agent('pose-question', item);
      await hold.waiting;
      // The other quiz commits the same wording while this one is held.
      value(await other.agent('pose-question', item));
      hold.release();
      const rejected = await first;
      assert.equal(rejected.ok, false);
      assert.match(
        (rejected as { message?: string }).message ?? '',
        /already seen this item/,
      );
    } finally {
      await f.cleanup();
    }
  });

  test('a miss in one quiz demotes the node on every quiz map in the pool', async () => {
    const f = await fixture();
    try {
      await f.item('Explain it', { level: 'explain', reasoning: 'sound' });
      value(
        await f.agent('practice-test', {
          action: 'start',
          concepts: ['loops'],
        }),
      );
      await f.item('Apply it');
      value(await f.agent('practice-test', { action: 'end' }));
      value(await f.status('mastered'));
      const other = await session(f.service);
      await other.item('Missed elsewhere', { verdict: 'incorrect' });
      const first = (await f.store.get(f.id))!;
      assert.equal(first.lessonMap?.statuses.loops, 'needs-review');
    } finally {
      await f.cleanup();
    }
  });

  test('a scope change before a mastery transaction uses the new pool evidence', async () => {
    const f = await fixture();
    try {
      await master(f);
      const hold = holdNextMetadata(f.store);
      const claim = f.status('mastered');
      await hold.waiting;
      value(await f.service.setScope(f.id, { ...vault, vaultId: 'other' }));
      hold.release();
      const result = await claim;
      assert.equal(
        result.ok,
        true,
        'the moved quiz carries its own committed evidence into the new pool',
      );
      assert.equal((await f.store.get(f.id))?.scope?.vaultId, 'other');
    } finally {
      await f.cleanup();
    }
  });

  test('a question in flight does not restore a mastery demoted by another quiz', async () => {
    const f = await fixture();
    try {
      await f.item('Explain it', { level: 'explain', reasoning: 'sound' });
      value(
        await f.agent('practice-test', {
          action: 'start',
          concepts: ['loops'],
        }),
      );
      await f.item('Apply it');
      value(await f.agent('practice-test', { action: 'end' }));
      value(await f.status('mastered'));
      const other = await session(f.service);
      const hold = holdNextUpdate(f.store);
      const pose = f.agent('pose-question', {
        question: 'Next loop item',
        kind: 'short-answer',
        concepts: ['arrays'],
        level: 'apply',
      });
      await hold.waiting;
      await other.item('Missed elsewhere', { verdict: 'incorrect' });
      hold.release();
      const posed = value(await pose);
      assert.equal(posed.lessonMap?.statuses.loops, 'needs-review');
      assert.deepEqual(posed.lessonMap?.focus, ['arrays']);
    } finally {
      await f.cleanup();
    }
  });

  /** Records `loops` mastery evidence in the given quiz and marks it mastered. */
  const master = async (quiz: Awaited<ReturnType<typeof session>>) => {
    await quiz.item('Explain it', { level: 'explain', reasoning: 'sound' });
    value(
      await quiz.agent('practice-test', {
        action: 'start',
        concepts: ['loops'],
      }),
    );
    await quiz.item('Apply it');
    value(await quiz.agent('practice-test', { action: 'end' }));
    value(await quiz.status('mastered'));
  };

  test('moving a quiz to another vault withdraws its mastery claims', async () => {
    const f = await fixture();
    try {
      await master(f);
      // This quiz claims mastery on the evidence f recorded in the same vault.
      const borrower = await session(f.service);
      value(await borrower.status('mastered'));
      const moved = value(
        await f.service.setScope(borrower.id, { ...vault, vaultId: 'other' }),
      );
      assert.equal(moved.lessonMap?.statuses.loops, 'independent');
      // Re-claiming in the new vault is judged on that vault's evidence alone.
      assert.equal((await borrower.status('mastered')).ok, false);
    } finally {
      await f.cleanup();
    }
  });

  test('a deletion before a mastery transaction retains the archived miss', async () => {
    const f = await fixture({ learner: true });
    try {
      const claimer = await session(f.service);
      await master(f);
      const hold = holdNextMetadata(f.store);
      const claim = claimer.status('mastered');
      await hold.waiting;
      await f.item('Missed before deletion', { verdict: 'incorrect' });
      await f.service.deleteSession(f.id);
      hold.release();
      assert.match(
        ((await claim) as { message?: string }).message ?? '',
        /since the latest independent miss/,
      );
    } finally {
      await f.cleanup();
    }
  });

  test('a quiz moving in with a miss withdraws the claims it contradicts', async () => {
    const f = await fixture();
    try {
      await master(f);
      const elsewhere = await session(f.service, {
        ...vault,
        vaultId: 'other',
      });
      await elsewhere.item('Missed in the other vault', {
        verdict: 'incorrect',
      });
      value(await f.service.setScope(elsewhere.id, vault));
      assert.equal(
        (await f.store.get(f.id))!.lessonMap?.statuses.loops,
        'independent',
      );
      // The miss is now the latest independent answer in this vault.
      assert.equal((await f.status('mastered')).ok, false);
    } finally {
      await f.cleanup();
    }
  });

  test('a quiz moving out takes its evidence, withdrawing claims that used it', async () => {
    const f = await fixture();
    try {
      await master(f);
      const borrower = await session(f.service);
      value(await borrower.status('mastered'));
      value(await f.service.setScope(f.id, { ...vault, vaultId: 'other' }));
      assert.equal(
        (await f.store.get(borrower.id))!.lessonMap?.statuses.loops,
        'independent',
      );
      assert.equal((await borrower.status('mastered')).ok, false);
    } finally {
      await f.cleanup();
    }
  });

  test('mastery reads canonical facts after restart without reconstructing transcript evidence', async () => {
    const f = await fixture();
    try {
      await master(f);
      value(await f.status('independent'));
      const path = join(f.dir, 'quiz.json');
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      const historyPath = join(
        `${path}.sessions`,
        manifest.sessions[f.id].history,
      );
      const history = JSON.parse(await readFile(historyPath, 'utf8'));
      history.session.transcript = [];
      await writeFile(historyPath, JSON.stringify(history));
      const restarted = new QuizService(new QuizStore(path), () => true);
      const attached = await restarted.attachSession(f.id);
      assert.ok(attached.ok);
      if (!attached.ok) return;
      const result = await restarted.request({
        type: 'lesson-map',
        sessionId: f.id,
        agentToken: attached.value.agentToken,
        expectedRevision: 0,
        idempotencyKey: 'canonical-claim',
        map: { statuses: { loops: 'mastered' } },
      });
      assert.ok(result.ok, JSON.stringify(result));
    } finally {
      await f.cleanup();
    }
  });

  test('deleting a skipped item retains its exposure across restart for test freshness', async () => {
    const f = await fixture();
    try {
      const posed = value(
        await f.agent('pose-question', {
          question: 'Seen but never graded',
          kind: 'short-answer',
          concepts: ['loops'],
          level: 'apply',
        }),
      );
      value(
        await f.agent('skip-question', {
          questionId: posed.currentQuestion!.id,
          text: 'We will return to this.',
        }),
      );
      await f.service.deleteSession(f.id);
      const restarted = new QuizService(
        new QuizStore(join(f.dir, 'quiz.json')),
        () => true,
      );
      const other = await session(restarted);
      value(
        await other.agent('practice-test', {
          action: 'start',
          concepts: ['loops'],
        }),
      );
      const result = await other.agent('pose-question', {
        question: 'Seen but never graded',
        kind: 'short-answer',
        concepts: ['loops'],
        level: 'apply',
      });
      assert.equal(result.ok, false);
      assert.match(
        (result as { message?: string }).message ?? '',
        /already seen this item/,
      );
    } finally {
      await f.cleanup();
    }
  });

  test('deleting a quiz retains its atomically committed attempt facts', async () => {
    const f = await fixture({ learner: true });
    try {
      await f.item('Missed before deletion', { verdict: 'incorrect' });
      const before = await f.learnerStore.attempts(learnerScopeKey(vault));
      await f.service.deleteSession(f.id);
      assert.equal(await f.store.get(f.id), undefined);
      assert.deepEqual(
        await f.learnerStore.attempts(learnerScopeKey(vault)),
        before,
      );
    } finally {
      await f.cleanup();
    }
  });
});
