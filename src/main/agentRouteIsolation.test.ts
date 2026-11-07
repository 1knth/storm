import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentBroker, type AgentRendererRequest } from './agentBroker';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('AgentBroker route isolation', () => {
  it('keeps concurrent quiz/context/preview/apply traffic on its own route', async () => {
    const rendererCalls: AgentRendererRequest[] = [];
    const quizCalls: unknown[] = [];
    const quizStarted = deferred<void>();
    const finishQuiz = deferred<any>();
    const plan = {
      type: 'replace' as const,
      content:
        '“naïve” — exact bytes; falsehood: the moon is made of cheese.\n',
    };
    const broker = new AgentBroker({
      resolveTarget: async (absolutePath) => ({
        absolutePath,
        vaultId: 'fixture',
        vaultRoot: '/fixture',
        relativePath: 'note.md',
        content: '',
        diskRevision: 'r0',
      }),
      getContext: async () => ({
        registeredVaults: [],
        activeVaultId: null,
        activeNote: null,
        openNotes: [],
      }),
      renderer: {
        dispatch: async (request) => {
          rendererCalls.push(request);
          if (request.type === 'snapshot')
            return {
              kind: 'document',
              ok: true,
              content: '',
              documentVersion: 4,
              diskRevision: 'r0',
              saveState: 'saved',
            };
          if (request.type === 'edit-preview')
            return {
              ok: true,
              kind: 'preview',
              content: plan.content,
              changed: true,
              documentVersion: 4,
              diskRevision: 'r0',
            };
          if (request.type === 'edit-apply')
            return {
              ok: true,
              kind: 'edited',
              saveState: 'saved',
              content: plan.content,
              documentVersion: 5,
              diskRevision: 'r1',
            };
          return { ok: true, kind: 'inspect', open: false };
        },
      },
      quiz: async (request) => {
        quizCalls.push(request);
        quizStarted.resolve();
        return finishQuiz.promise;
      },
    });
    const request = (requestId: string, type: string, extra: object = {}) => ({
      protocol: 1,
      requestId,
      type,
      ...extra,
    });

    const quizPromise = broker.handle(
      request('quiz-request', 'quiz', {
        operation: 'list',
        sessionId: 'quiz-session',
      }),
    );
    await quizStarted.promise;
    const contextPromise = broker.handle(request('context-request', 'context'));
    const connected = (await broker.handle(
      request('note-connect', 'connect', { absolutePath: '/fixture/note.md' }),
    )) as any;
    const sessionId = connected.session.sessionId;
    const previewPromise = broker.handle(
      request('note-preview', 'edit-preview', {
        sessionId,
        operationId: 'preview-op',
        expectedVersion: 4,
        plan,
      }),
    );
    const applyPromise = broker.handle(
      request('note-apply', 'edit-apply', {
        sessionId,
        operationId: 'apply-op',
        expectedVersion: 4,
        plan,
      }),
    );

    const [context, preview, applied] = (await Promise.all([
      contextPromise,
      previewPromise,
      applyPromise,
    ])) as any[];
    assert.equal(context.requestId, 'context-request');
    assert.equal(context.type, 'context');
    assert.equal(preview.requestId, 'note-preview');
    assert.equal(preview.type, 'preview');
    assert.equal(preview.content, plan.content);
    assert.equal(applied.requestId, 'note-apply');
    assert.equal(applied.type, 'edited');
    assert.equal(applied.content, plan.content);
    assert.equal(applied.saveState, 'saved');
    assert.equal(quizCalls.length, 1);
    assert.equal(
      quizCalls.some((call: any) => call.requestId?.startsWith('note-')),
      false,
    );

    finishQuiz.resolve({
      protocol: 1,
      requestId: 'quiz-request',
      ok: true,
      type: 'quiz',
      operation: 'list',
      result: { ok: true, value: [] },
    });
    const quiz = (await quizPromise) as any;
    assert.equal(quiz.requestId, 'quiz-request');
    assert.equal(quiz.type, 'quiz');
    assert.deepEqual(
      rendererCalls
        .filter(
          (call) => call.type === 'edit-preview' || call.type === 'edit-apply',
        )
        .map((call) => call.requestId),
      ['note-preview', 'note-apply'],
    );
  });
});
