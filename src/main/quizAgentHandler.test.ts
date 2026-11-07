import { describe, it as test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuizService } from './quizService';
import { QuizStore } from './quizStore';
import { createQuizAgentHandler } from './quizAgentHandler';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'storm-quiz-handler-'));
  const service = new QuizService(
    new QuizStore(join(dir, 'sessions.json')),
    () => true,
  );
  const created = await service.createSession({
    vaultId: 'vault',
    notePath: 'a.md',
    selectedNotePaths: [],
    folderPath: null,
  });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error('session create failed');
  return {
    dir,
    service,
    session: created.value,
    handle: createQuizAgentHandler(service),
  };
}

const request = (
  operation:
    | 'list'
    | 'attach'
    | 'detach'
    | 'snapshot'
    | 'request'
    | 'image-fetch'
    | 'image-release',
  fields = {},
) =>
  ({
    protocol: 1 as const,
    requestId: 'request',
    type: 'quiz' as const,
    operation,
    ...fields,
  }) as never;

describe('quiz agent handler', () => {
  test('fetches only a requested transient image for the authenticated connected quiz agent', async () => {
    const f = await fixture();
    try {
      const attached = await f.handle(
        request('attach', { sessionId: f.session.id, clientId: 'cli' }),
      );
      assert.equal(attached.ok, true);
      if (
        !attached.ok ||
        attached.type !== 'quiz' ||
        attached.operation !== 'attach' ||
        !attached.result.ok
      )
        throw new Error('attach failed');
      const data = Uint8Array.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
      ]);
      const image = await f.service.addImage(f.session.id, {
        mimeType: 'image/png',
        data,
      });
      assert.equal(image.ok, true);
      if (!image.ok) return;
      const fetched = await f.handle(
        request('image-fetch', {
          sessionId: f.session.id,
          agentToken: attached.result.value.agentToken,
          imageId: image.value.id,
        }),
      );
      assert.equal(fetched.ok, true);
      if (
        !fetched.ok ||
        fetched.type !== 'quiz' ||
        fetched.operation !== 'image-fetch' ||
        !fetched.result.ok
      )
        throw new Error('image fetch failed');
      assert.equal(fetched.result.value.size, data.byteLength);
      assert.deepEqual(
        await (
          await import('node:fs/promises')
        ).readFile(fetched.result.value.path),
        Buffer.from(data),
      );
      const released = await f.handle(
        request('image-release', {
          sessionId: f.session.id,
          agentToken: attached.result.value.agentToken,
          imageId: image.value.id,
        }),
      );
      assert.deepEqual(
        released.ok &&
          released.type === 'quiz' &&
          released.operation === 'image-release'
          ? released.result
          : null,
        { ok: true, value: { id: image.value.id, released: true } },
      );
      const unavailable = await f.handle(
        request('image-fetch', {
          sessionId: f.session.id,
          agentToken: attached.result.value.agentToken,
          imageId: image.value.id,
        }),
      );
      assert.deepEqual(
        unavailable.ok &&
          unavailable.type === 'quiz' &&
          unavailable.operation === 'image-fetch'
          ? unavailable.result
          : null,
        { ok: false, error: 'not-found' },
      );
      const denied = await f.handle(
        request('image-release', {
          sessionId: f.session.id,
          agentToken: 'wrong',
          imageId: image.value.id,
        }),
      );
      assert.equal(denied.ok, true);
      if (
        denied.ok &&
        denied.type === 'quiz' &&
        denied.operation === 'image-fetch'
      )
        assert.deepEqual(denied.result, { ok: false, error: 'unauthorized' });
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test('redacts list and snapshot, returns agent token only in attach response', async () => {
    const f = await fixture();
    try {
      const list = await f.handle(request('list'));
      assert.equal(list.ok, true);
      if (
        !list.ok ||
        list.type !== 'quiz' ||
        list.operation !== 'list' ||
        !list.result.ok
      )
        throw new Error('unexpected list response');
      assert.equal(list.result.value.length, 1); // Unsaved draft is machine-visible.
      assert.equal('agentToken' in list.result.value[0], false);
      assert.deepEqual(await f.service.listSessions(), []); // GUI default remains saved-only.

      const attached = await f.handle(
        request('attach', { sessionId: f.session.id, clientId: 'cli' }),
      );
      assert.equal(attached.ok, true);
      if (
        !attached.ok ||
        attached.type !== 'quiz' ||
        attached.operation !== 'attach' ||
        !attached.result.ok
      )
        throw new Error('unexpected attach response');
      const token = attached.result.value.agentToken;
      assert.equal(token, f.session.agentToken);
      assert.equal(
        'agentToken' in attached.result.value.snapshot.session,
        false,
      );

      const snapshot = await f.handle(
        request('snapshot', { sessionId: f.session.id, agentToken: token }),
      );
      assert.equal(snapshot.ok, true);
      if (
        !snapshot.ok ||
        snapshot.type !== 'quiz' ||
        snapshot.operation !== 'snapshot'
      )
        throw new Error('unexpected snapshot response');
      assert.equal(
        snapshot.snapshot && 'agentToken' in snapshot.snapshot.session,
        false,
      );

      const unauthorized = await f.handle(
        request('snapshot', { sessionId: f.session.id, agentToken: 'wrong' }),
      );
      assert.equal(unauthorized.ok, false);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test('detach updates the GUI-visible session state and permits reattach', async () => {
    const f = await fixture();
    try {
      const attached = await f.handle(
        request('attach', { sessionId: f.session.id, clientId: 'cli' }),
      );
      if (
        !attached.ok ||
        attached.type !== 'quiz' ||
        attached.operation !== 'attach' ||
        !attached.result.ok
      )
        throw new Error('unexpected attach response');
      const token = attached.result.value.agentToken;
      const detached = await f.handle(
        request('detach', { sessionId: f.session.id, agentToken: token }),
      );
      assert.equal(detached.ok, true);
      if (
        !detached.ok ||
        detached.type !== 'quiz' ||
        detached.operation !== 'detach'
      )
        throw new Error('unexpected detach response');
      assert.equal(detached.result.ok, true);
      const listed = await f.handle(request('list'));
      if (
        !listed.ok ||
        listed.type !== 'quiz' ||
        listed.operation !== 'list' ||
        !listed.result.ok
      )
        throw new Error('unexpected list response');
      assert.equal(listed.result.value[0]?.status, 'disconnected');
      const reattached = await f.handle(
        request('attach', { sessionId: f.session.id, clientId: 'cli' }),
      );
      assert.equal(reattached.ok, true);
      assert.equal(
        (await f.service.getSnapshot(f.session.id))?.session.status,
        'connected',
      );
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test('poses a question and exposes its pending state and events', async () => {
    const f = await fixture();
    try {
      const attached = await f.handle(
        request('attach', { sessionId: f.session.id, clientId: 'cli' }),
      );
      if (
        !attached.ok ||
        attached.type !== 'quiz' ||
        attached.operation !== 'attach' ||
        !attached.result.ok
      )
        throw new Error('unexpected attach response');
      const { agentToken, snapshot } = attached.result.value;
      const posed = await f.handle(
        request('request', {
          request: {
            type: 'pose-question',
            sessionId: f.session.id,
            agentToken,
            expectedRevision: snapshot.session.revision,
            idempotencyKey: 'question',
            question: 'Why?',
            choices: [
              { id: 'a', text: 'A' },
              { id: 'b', text: 'B' },
            ],
          },
        }),
      );
      assert.equal(posed.ok, true);
      const result = await f.service.getSnapshot(f.session.id);
      assert.equal(result?.session.currentQuestion?.status, 'open');
      assert.equal(result?.session.status, 'connected');
      assert.equal(
        result?.events.some((event) => event.type === 'pose-question'),
        true,
      );
      for (let i = 0; i < 3; i++) {
        const polled = await f.handle(
          request('snapshot', { sessionId: f.session.id, agentToken }),
        );
        assert.equal(polled.ok, true);
        const afterPoll = await f.service.getSnapshot(f.session.id);
        assert.equal(afterPoll?.session.status, 'connected');
        assert.equal(afterPoll?.session.revision, result?.session.revision);
        assert.equal(afterPoll?.session.currentQuestion?.status, 'open');
      }
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
});

test('bounded wait authenticates before waiting and returns the session projection at timeout', async () => {
  const f = await fixture();
  try {
    const attached: any = await f.handle(
      request('attach', { sessionId: f.session.id, clientId: 'cli' }),
    );
    const agentToken = attached.result.value.agentToken;
    const denied = await f.handle({
      protocol: 1,
      requestId: 'denied',
      type: 'quiz',
      operation: 'wait',
      sessionId: f.session.id,
      agentToken: 'wrong',
      waitMs: 20000,
    });
    assert.equal(denied.ok, false);
    const response: any = await f.handle({
      protocol: 1,
      requestId: 'wait',
      type: 'quiz',
      operation: 'wait',
      sessionId: f.session.id,
      agentToken,
      after: 0,
      waitMs: 0,
      compact: true,
    });
    assert.equal(response.ok, true);
    assert.equal(response.operation, 'wait');
    assert.equal(response.snapshot.session.id, f.session.id);
    assert.equal(response.snapshot.session.agentToken, undefined);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
