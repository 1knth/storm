import { mkdtemp, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuizStore } from '../../src/main/quizStore.ts';
const dir = await mkdtemp(join(tmpdir(), 'storm-limits-'));
const text = (n: number) =>
  'Recall the mechanism and explain why the alternative is incorrect. '
    .repeat(Math.ceil(n / 66))
    .slice(0, n);
const timestamp = '2026-10-26T00:00:00.000Z';
async function timing(fn: () => Promise<any>) {
  const t = performance.now();
  await fn();
  return +(performance.now() - t).toFixed(1);
}
try {
  for (const count of [10, 100, 500]) {
    const db: any = { version: 1, sessions: [], events: {}, idempotency: {} };
    for (let s = 0; s < count; s++) {
      const id = `session-${s}`,
        transcript: any[] = [],
        events: any[] = [];
      for (let q = 0; q < 50; q++) {
        const question = {
          id: `q-${s}-${q}`,
          kind: 'multiple-choice',
          prompt: text(400),
          choices: [
            { id: 'a', text: text(80) },
            { id: 'b', text: text(80) },
          ],
          studyBasis: 'a'.repeat(64),
        };
        transcript.push(
          {
            id: `p-${q}`,
            role: 'agent',
            text: question.prompt,
            createdAt: timestamp,
            kind: 'question',
            question,
          },
          {
            id: `a-${q}`,
            role: 'learner',
            text: text(200),
            createdAt: timestamp,
            kind: 'answer',
          },
          {
            id: `f-${q}`,
            role: 'agent',
            text: text(800),
            createdAt: timestamp,
            question: {
              ...question,
              verdict: q % 3 ? 'correct' : 'incorrect',
              answerLabel: 'a',
            },
          },
        );
        for (const [type, data] of [
          ['pose-question', { question }],
          ['answer', { choiceId: 'a', reasoning: text(200) }],
          ['feedback', { text: text(800), verdict: 'incorrect' }],
          ['continue', {}],
        ] as const) {
          const cursor = events.length + 1;
          events.push({
            cursor,
            revision: cursor,
            type,
            data,
            createdAt: timestamp,
          });
          db.idempotency[`${id}-${cursor}`] = {
            fingerprint: 'b'.repeat(64),
            sessionId: id,
            revision: cursor,
          };
        }
      }
      db.sessions.push({
        id,
        agentToken: 'test-only',
        revision: 200,
        eventCursor: 200,
        status: 'connected',
        transcript,
        currentQuestion: null,
        freeChatDraft: '',
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      db.events[id] = events;
    }
    const file = join(dir, `quiz-${count}.json`);
    await writeFile(file, JSON.stringify(db));
    const store = new QuizStore(file);
    const cold = await timing(() => store.listSummaries());
    const warm = await timing(() => store.listSummaries());
    let session = (await store.get('session-0'))!;
    const draftTimes: number[] = [],
      activityTimes: number[] = [];
    for (let i = 0; i < 5; i++) {
      session = { ...session, freeChatDraft: `draft-${i}` };
      draftTimes.push(
        await timing(() =>
          store.updateDraft(session.id, 200, (current) => ({
            ...current,
            freeChatDraft: session.freeChatDraft,
          })),
        ),
      );
      activityTimes.push(
        await timing(() =>
          store.updateActivity('session-0', 'test-only', {
            state: 'thinking',
            updatedAt: timestamp,
          }),
        ),
      );
    }
    const mean = (a: number[]) =>
      +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1);
    console.log(
      JSON.stringify({
        sessions: count,
        questions: count * 50,
        MiB: +((await stat(file)).size / 1048576).toFixed(2),
        coldSummaryMs: cold,
        warmSummaryMs: warm,
        meanDraftWriteMs: mean(draftTimes),
        meanActivityWriteMs: mean(activityTimes),
        draftWriteRangeMs: [Math.min(...draftTimes), Math.max(...draftTimes)],
      }),
    );
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
