// Regression coverage for learner control and model input integrity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuizService } from './quizService';
import { QuizStore } from './quizStore';
import { sendAgentRequest } from './agentEndpoint';
import {
  quizAgentSession as modelSession,
  quizAgentEvent,
} from '../shared/quizAgentContext';
import type {
  QuizAgentRequest,
  QuizLearnerRequest,
  QuizResult,
} from '../shared/quizProtocol';

function value<T>(result: QuizResult<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'storm-quality-diagnostic-'));
  const service = new QuizService(
    new QuizStore(join(dir, 'quiz.json')),
    () => true,
  );
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
  return { dir, service, session, send };
}

test('new questions require learner Continue after feedback', async () => {
  const f = await fixture();
  try {
    await f.send('pose-question', {
      question: 'First?',
      choices: [{ id: 'a', text: 'A' }],
    });
    await f.send('answer', { choiceId: 'a', reasoning: '' }, true);
    await f.send('feedback', {
      text: 'Let us explain this.',
      verdict: 'correct',
    });
    await assert.rejects(
      f.send('pose-question', {
        question: 'Second?',
        choices: [{ id: 'b', text: 'B' }],
      }),
      /invalid-state/,
    );
    await f.send('continue', {}, true);
    const second = await f.send('pose-question', {
      question: 'Second?',
      choices: [{ id: 'b', text: 'B' }],
    });
    assert.equal(second.currentQuestion!.prompt, 'Second?');
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('model context excludes unsent answer drafts', async () => {
  const f = await fixture();
  try {
    const posed = await f.send('pose-question', {
      kind: 'long-answer',
      question: 'Explain inertia.',
    });
    const drafted = value(
      await f.service.saveDraft(f.session.id, posed.revision, {
        questionId: posed.currentQuestion!.id,
        selectedChoiceId: null,
        reasoningDraft: '',
        freeChatDraft: '',
        textDraft: 'Unsubmitted thought: heavier objects fall faster.',
      }),
    );
    assert.equal('textDraft' in modelSession(drafted).currentQuestion, false);
    await f.send(
      'message',
      { text: 'Can you define the question term?' },
      true,
    );
    const snapshot = (await f.service.getSnapshot(f.session.id))!;
    assert.equal(snapshot.events.at(-1)!.type, 'message');
    assert.equal(
      JSON.stringify(modelSession(snapshot.session)).includes(
        'Unsubmitted thought',
      ),
      false,
    );
    assert.equal(
      snapshot.events.some((item) => item.type === 'answer'),
      false,
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('matching answers preserve learner-defined IDs through store and model projections', async () => {
  const f = await fixture();
  try {
    await f.send('pose-question', {
      kind: 'matching',
      question: 'Match the concepts.',
      leftItems: [
        { id: 'author', text: 'Author' },
        { id: 'token', text: 'Token' },
      ],
      rightItems: [
        { id: 'writer', text: 'Writer' },
        { id: 'symbol', text: 'Symbol' },
      ],
    });
    const answered = await f.send(
      'answer',
      { matches: { author: 'writer', token: 'symbol' } },
      true,
    );
    assert.deepEqual(answered.currentQuestion!.matchesDraft, {
      author: 'writer',
      token: 'symbol',
    });
    const snapshot = (await f.service.getSnapshot(f.session.id))!;
    assert.deepEqual(snapshot.events.at(-1)!.data, {
      matches: { author: 'writer', token: 'symbol' },
    });
    assert.deepEqual(
      modelSession(snapshot.session).currentQuestion.matchesDraft,
      { author: 'writer', token: 'symbol' },
    );
    assert.deepEqual(quizAgentEvent(snapshot.events.at(-1)!).data.matches, {
      author: 'writer',
      token: 'symbol',
    });
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('socket response decoding preserves Unicode across chunk boundaries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'storm-unicode-diagnostic-'));
  const socketPath = join(dir, 'endpoint.sock');
  const bytes = Buffer.from(
    JSON.stringify({ ok: true, text: 'café 🧠' }) + '\n',
  );
  const split = bytes.indexOf(Buffer.from('é')) + 1;
  const server = createServer((socket) => {
    socket.once('data', () => {
      socket.write(bytes.subarray(0, split));
      setTimeout(() => socket.end(bytes.subarray(split)), 20);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const response = (await sendAgentRequest(
      { endpoint: socketPath, token: 'synthetic' },
      {
        protocol: 1,
        requestId: 'unicode-diagnostic',
        type: 'context',
      },
    )) as { text: string };
    assert.equal(response.text, 'café 🧠');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
