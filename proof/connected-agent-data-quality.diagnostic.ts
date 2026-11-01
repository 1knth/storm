// Investigation diagnostics: passing assertions demonstrate current defects.
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuizService } from '../src/main/quizService';
import { QuizStore } from '../src/main/quizStore';
import { sendAgentRequest } from '../src/main/agentEndpoint';
import {
  learnerNotification,
  modelSession,
} from '../extensions/storm-quiz-runtime';
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

test('new question is accepted immediately after feedback without a learner Continue', async () => {
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
    const second = await f.send('pose-question', {
      question: 'Second?',
      choices: [{ id: 'b', text: 'B' }],
    });
    expect(second.currentQuestion!.prompt).toBe('Second?');
    const snapshot = (await f.service.getSnapshot(f.session.id))!;
    expect(snapshot.events.some((event) => event.type === 'continue')).toBe(
      false,
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('model status and unrelated chat notifications expose unsent answer drafts', async () => {
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
    expect(modelSession(drafted).currentQuestion).toMatchObject({
      status: 'open',
      textDraft: 'Unsubmitted thought: heavier objects fall faster.',
    });
    await f.send(
      'message',
      { text: 'Can you define the question term?' },
      true,
    );
    const snapshot = (await f.service.getSnapshot(f.session.id))!;
    const event = snapshot.events.at(-1)!;
    expect(event.type).toBe('message');
    expect(
      learnerNotification([event], snapshot.session.currentQuestion),
    ).toContain('Unsubmitted thought');
    expect(snapshot.events.some((item) => item.type === 'answer')).toBe(false);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('secret-key filtering removes legitimate matching answers with natural item IDs', async () => {
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
    expect(answered.currentQuestion!.matchesDraft).toEqual({
      author: 'writer',
      token: 'symbol',
    });
    const snapshot = (await f.service.getSnapshot(f.session.id))!;
    // The store strips token; the adapter's broader /auth/ rule also strips author.
    expect(snapshot.events.at(-1)!.data).toEqual({
      matches: { author: 'writer' },
    });
    expect(
      (modelSession(snapshot.session).currentQuestion as any).matchesDraft,
    ).toEqual({});
    const notification = learnerNotification(
      [snapshot.events.at(-1)!],
      snapshot.session.currentQuestion,
    );
    expect(notification).toContain('"matches":{}');
    expect(notification).toContain('"matchesDraft":{}');
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('socket response decoding corrupts Unicode when a character crosses chunk boundaries', async () => {
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
    expect(response.text).not.toBe('café 🧠');
    expect(response.text).toBe('caf�� 🧠');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
