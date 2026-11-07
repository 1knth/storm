import { describe, it as test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { QuizService } from './quizService';
import {
  quizFixture,
  quizVariantCases,
  invalidQuizVariantCases,
} from './quizTestFixtures';
import { QuizStore } from './quizStore';

async function fixture() {
  const { dir, store, service, session, driver } = await quizFixture();
  const { id, agentToken } = session;
  const agent = (type: string, revision: number, key: string, fields = {}) =>
    driver.agentInput(
      { type, ...fields },
      { expectedRevision: revision, idempotencyKey: key },
    );
  const learner = (revision: number, key: string, fields = {}) =>
    driver.learnerInput(
      { type: 'answer', ...fields },
      { expectedRevision: revision, idempotencyKey: key },
    );
  return { dir, store, service, id, agentToken, agent, learner, driver };
}

describe('quiz question types', () => {
  test('all four variants complete pose, learner answer, feedback, continue without leaking capability', async () => {
    const cases = quizVariantCases;
    for (const item of cases) {
      const f = await fixture();
      try {
        assert.equal((await f.driver.agent({ type: 'attach' })).ok, true);
        assert.equal((await f.driver.agent(item.pose)).ok, true);
        assert.equal((await f.driver.learner(item.answer)).ok, true);
        const snapshot = await f.service.getSnapshot(f.id);
        assert.equal(snapshot?.session.currentQuestion?.status, 'answered');
        const { type: _type, ...answerData } = item.answer;
        assert.deepEqual(snapshot?.events.at(-1)?.data, answerData);
        assert.equal(
          JSON.stringify(snapshot?.events).includes(f.agentToken),
          false,
        );
        assert.equal(
          (await f.driver.agent({ type: 'feedback', text: 'Review' })).ok,
          true,
        );
        assert.equal((await f.driver.learner({ type: 'continue' })).ok, true);
        assert.equal(
          (await f.service.getSnapshot(f.id))?.session.currentQuestion,
          null,
        );
      } finally {
        await rm(f.dir, { recursive: true, force: true });
      }
    }
  });

  for (const { name, pose } of invalidQuizVariantCases) {
    test(`rejects ${name} without committing a question`, async () => {
      const f = await fixture();
      try {
        await f.driver.agent({ type: 'attach' });
        assert.deepEqual(await f.driver.agentInput(pose), {
          ok: false,
          error: 'invalid-input',
        });
        const snapshot = await f.service.getSnapshot(f.id);
        assert.equal(snapshot?.session.revision, 1);
        assert.equal(snapshot?.session.transcript.length, 0);
      } finally {
        await rm(f.dir, { recursive: true, force: true });
      }
    });
  }

  test('validates choice bounds and exact matching bijection', async () => {
    const f = await fixture();
    try {
      await f.agent('attach', 0, 'a');
      for (const count of [0, 7])
        assert.deepEqual(
          await f.agent('pose-question', 1, `bad-${count}`, {
            question: 'Q',
            choices: Array.from({ length: count }, (_, n) => ({
              id: `${n}`,
              text: 'x',
            })),
          }),
          { ok: false, error: 'invalid-input' },
        );
      for (const count of [1, 6]) {
        const fresh = await fixture();
        try {
          await fresh.agent('attach', 0, 'a');
          assert.equal(
            (
              await fresh.agent('pose-question', 1, `good-${count}`, {
                question: 'Q',
                choices: Array.from({ length: count }, (_, n) => ({
                  id: `${n}`,
                  text: 'x',
                })),
              })
            ).ok,
            true,
          );
        } finally {
          await rm(fresh.dir, { recursive: true, force: true });
        }
      }
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
    const m = await fixture();
    try {
      await m.agent('attach', 0, 'a');
      const pose = {
        kind: 'matching',
        question: 'Q',
        leftItems: [
          { id: 'l1', text: 'L1' },
          { id: 'l2', text: 'L2' },
        ],
        rightItems: [
          { id: 'r1', text: 'R1' },
          { id: 'r2', text: 'R2' },
        ],
      };
      await m.agent('pose-question', 1, 'p', pose);
      for (const matches of [
        { l1: 'r1' },
        { l1: 'r1', l2: 'r1' },
        { l1: 'r1', l2: 'unknown' },
      ])
        assert.deepEqual(
          await m.learner(
            2,
            `bad-${Object.keys(matches).length}-${Object.values(matches).join()}`,
            { matches },
          ),
          { ok: false, error: 'invalid-input' },
        );
      assert.equal(
        (
          await m.learner(2, 'valid', {
            matches: { l1: 'r1', l2: 'r2' },
            reasoning: 'This explains the connection.',
          })
        ).ok,
        true,
      );
    } finally {
      await rm(m.dir, { recursive: true, force: true });
    }
  });

  test('rejects blank text answers and preserves partial drafts through promotion and restart; stale question IDs do not overwrite', async () => {
    const f = await fixture();
    try {
      await f.agent('attach', 0, 'a');
      await f.agent('pose-question', 1, 'p', {
        kind: 'short-answer',
        question: 'Q',
      });
      for (const answer of ['', ' \n\t '])
        assert.deepEqual(
          await f.learner(2, `blank-${answer.length}`, { answer }),
          { ok: false, error: 'invalid-input' },
        );
      const id = (await f.service.getSnapshot(f.id))!.session.currentQuestion!
        .id;
      assert.equal(
        (
          await f.service.saveDraft(f.id, 2, {
            questionId: id,
            selectedChoiceId: null,
            reasoningDraft: '',
            freeChatDraft: '',
            textDraft: 'partial — 🧠\n',
          })
        ).ok,
        true,
      );
      await f.agent('feedback', 3, 'f', { text: 'done' });
      await f.service.learnerRequest({
        type: 'continue',
        sessionId: f.id,
        expectedRevision: 4,
        idempotencyKey: 'c',
      });
      const currentId = id;
      await f.service.saveDraft(f.id, 5, {
        questionId: id,
        selectedChoiceId: null,
        reasoningDraft: '',
        freeChatDraft: '',
        textDraft: 'updated partial',
      });
      assert.equal(
        (await f.service.getSnapshot(f.id))?.session.currentQuestion
          ?.matchesDraft,
        undefined,
      );
      const restarted = new QuizService(
        new QuizStore(join(f.dir, 'quiz.json')),
        () => true,
      );
      const loaded = (await restarted.getSnapshot(f.id))!.session;
      assert.equal(loaded.currentQuestion?.id, currentId);
      assert.equal(loaded.currentQuestion?.kind, 'short-answer');
      assert.equal(loaded.currentQuestion?.textDraft, 'partial — 🧠\n');
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
});
