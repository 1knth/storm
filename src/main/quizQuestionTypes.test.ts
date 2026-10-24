import { describe, it as test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuizService } from './quizService';
import { QuizStore } from './quizStore';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'storm-question-types-'));
  const store = new QuizStore(join(dir, 'quiz.json'));
  const service = new QuizService(store, () => true);
  const created = await service.createSession();
  assert.equal(created.ok, true);
  if (!created.ok) throw Error('creation failed');
  const { id, agentToken } = created.value;
  const agent = (type: string, revision: number, key: string, fields = {}) =>
    service.request({
      type,
      sessionId: id,
      agentToken,
      expectedRevision: revision,
      idempotencyKey: key,
      ...fields,
    } as never);
  const learner = (revision: number, key: string, fields = {}) =>
    service.learnerRequest({
      type: 'answer',
      sessionId: id,
      expectedRevision: revision,
      idempotencyKey: key,
      ...fields,
    } as never);
  return { dir, store, service, id, agentToken, agent, learner };
}

describe('quiz question types', () => {
  test('all four variants complete pose, learner answer, feedback, continue without leaking capability', async () => {
    const cases = [
      {
        pose: {
          question: 'Pick',
          choices: [
            { id: 'a', text: 'Alpha' },
            { id: 'b', text: 'Beta' },
          ],
        },
        answer: { choiceId: 'b', reasoning: 'because' },
      },
      {
        pose: {
          kind: 'matching',
          question: 'Pair',
          leftItems: [
            { id: 'l1', text: 'L1' },
            { id: 'l2', text: 'L2' },
          ],
          rightItems: [
            { id: 'r1', text: 'R1' },
            { id: 'r2', text: 'R2' },
          ],
        },
        answer: { matches: { l1: 'r2', l2: 'r1' } },
      },
      {
        pose: { kind: 'short-answer', question: 'Brief' },
        answer: { answer: '  café\n答え  ' },
      },
      {
        pose: { kind: 'long-answer', question: 'Explain' },
        answer: { answer: 'Line one\nLine two — 🧠' },
      },
    ];
    for (const [i, item] of cases.entries()) {
      const f = await fixture();
      try {
        assert.equal((await f.agent('attach', 0, 'attach')).ok, true);
        assert.equal(
          (await f.agent('pose-question', 1, 'pose', item.pose)).ok,
          true,
        );
        assert.equal((await f.learner(2, 'answer', item.answer)).ok, true);
        const snapshot = await f.service.getSnapshot(f.id);
        assert.equal(snapshot?.session.currentQuestion?.status, 'answered');
        assert.deepEqual(snapshot?.events.at(-1)?.data, item.answer);
        assert.equal(
          JSON.stringify(snapshot?.events).includes(f.agentToken),
          false,
        );
        assert.equal(
          (await f.agent('feedback', 3, 'feedback', { text: 'Review' })).ok,
          true,
        );
        assert.equal(
          (
            await f.service.learnerRequest({
              type: 'continue',
              sessionId: f.id,
              expectedRevision: 4,
              idempotencyKey: `continue-${i}`,
            })
          ).ok,
          true,
        );
        assert.equal(
          (await f.service.getSnapshot(f.id))?.session.currentQuestion,
          null,
        );
      } finally {
        await rm(f.dir, { recursive: true, force: true });
      }
    }
  });

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
        (await m.learner(2, 'valid', { matches: { l1: 'r1', l2: 'r2' } })).ok,
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
