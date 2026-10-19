import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentBroker, type AgentRendererRequest } from './agentBroker';

function setup() {
  const calls: AgentRendererRequest[] = [];
  const broker = new AgentBroker({
    resolveTarget: async (absolutePath) => ({
      absolutePath,
      vaultId: 'fixture',
      vaultRoot: '/private/fixture',
      relativePath: 'note.md',
      content: '',
      diskRevision: 'rev',
    }),
    renderer: {
      dispatch: async (request) => {
        calls.push(request);
        return {
          ok: true,
          content: '',
          documentVersion: calls.length,
          diskRevision: 'rev',
          saveState: 'saved',
        };
      },
    },
  });
  return { broker, calls };
}
const req = (type: string, values: object = {}) => ({
  protocol: 1,
  requestId: Math.random().toString(),
  type,
  ...values,
});

describe('AgentBroker', () => {
  it('accepts ordinary names containing r or n and rejects control characters', async () => {
    const { broker } = setup();
    for (const name of ['OpenAI', 'Danny', 'ordinary r and n']) {
      const result = await broker.handle(
        req('connect', { absolutePath: '/private/fixture/note.md', name }),
      );
      assert.equal((result as any).ok, true, name);
    }
    for (const name of ['bad\nname', 'bad\rname', 'bad\u0000name']) {
      const result = await broker.handle(
        req('connect', { absolutePath: '/private/fixture/note.md', name }),
      );
      assert.equal((result as any).ok, false, name);
      assert.equal((result as any).error.code, 'INVALID_REQUEST');
    }
  });

  it('keeps the session writing between acknowledged chunks until finish', async () => {
    const { broker } = setup();
    const connected = (await broker.handle(
      req('connect', { absolutePath: '/private/fixture/note.md' }),
    )) as any;
    const sid = connected.session.sessionId;

    for (const [sequence, text] of [
      [1, 'first'],
      [2, 'second'],
    ] as const) {
      const appended = (await broker.handle(
        req('append', {
          sessionId: sid,
          operationId: `op-${sequence}`,
          sequence,
          text,
        }),
      )) as any;
      assert.equal(appended.ok, true);

      const status = (await broker.handle(
        req('status', { sessionId: sid }),
      )) as any;
      assert.equal(status.sessions[0].state, 'writing');
      assert.equal(status.sessions[0].pendingOperations, 0);
    }

    const finished = (await broker.handle(
      req('finish', { sessionId: sid }),
    )) as any;
    assert.equal(finished.session.state, 'finished');
    const status = (await broker.handle(
      req('status', { sessionId: sid }),
    )) as any;
    assert.equal(status.sessions[0].state, 'finished');
  });

  it('replays duplicate operation acknowledgements without applying twice and enforces append sequence', async () => {
    const { broker, calls } = setup();
    const connected = (await broker.handle(
      req('connect', { absolutePath: '/private/fixture/note.md' }),
    )) as any;
    const sid = connected.session.sessionId;
    const snapshot = calls.find((call) => call.type === 'snapshot');
    assert.equal(
      snapshot?.type === 'snapshot' ? snapshot.sessionId : null,
      sid,
    );
    const first = req('append', {
      sessionId: sid,
      operationId: 'op-1',
      sequence: 1,
      text: 'alpha',
    });
    const ack = await broker.handle(first);
    const replay = await broker.handle({ ...first, requestId: 'replay' });
    assert.deepEqual(replay, { ...ack, requestId: 'replay' });
    assert.equal(calls.filter((call) => call.type === 'append').length, 1);
    const invalid = (await broker.handle(
      req('append', {
        sessionId: sid,
        operationId: 'op-2',
        sequence: 3,
        text: 'skip',
      }),
    )) as any;
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error.code, 'INVALID_SEQUENCE');
    assert.equal(calls.filter((call) => call.type === 'append').length, 1);
  });

  it('serializes concurrent appends, deduplicates in-flight retries, and rejects changed replay', async () => {
    let release!: () => void;
    const calls: AgentRendererRequest[] = [];
    const broker = new AgentBroker({
      resolveTarget: async (absolutePath) => ({
        absolutePath,
        vaultId: 'v',
        vaultRoot: '/v',
        relativePath: 'n.md',
        content: '',
        diskRevision: 'r',
      }),
      renderer: {
        dispatch: async (request) => {
          calls.push(request);
          if (request.type === 'append' && request.operationId === 'first')
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          return { ok: true, documentVersion: calls.length, diskRevision: 'r' };
        },
      },
    });
    const connected = (await broker.handle(
      req('connect', { absolutePath: '/v/n.md' }),
    )) as any;
    const sid = connected.session.sessionId;
    const firstRequest = req('append', {
      sessionId: sid,
      operationId: 'first',
      sequence: 1,
      text: 'a',
    });
    const first = broker.handle(firstRequest);
    await Promise.resolve();
    await Promise.resolve();
    const duplicate = broker.handle({ ...firstRequest, requestId: 'retry' });
    const changed = (await broker.handle({
      ...firstRequest,
      requestId: 'changed',
      text: 'different',
    })) as any;
    assert.equal(changed.error.code, 'DUPLICATE_OPERATION');
    const second = broker.handle(
      req('append', {
        sessionId: sid,
        operationId: 'second',
        sequence: 1,
        text: 'b',
      }),
    );
    release();
    assert.equal(((await first) as any).ok, true);
    assert.equal(((await duplicate) as any).ok, true);
    assert.equal(((await second) as any).error.code, 'INVALID_SEQUENCE');
    assert.equal(calls.filter((call) => call.type === 'append').length, 1);
  });

  it('finish drains accepted append; cancellation immediately fences queued appends', async () => {
    let release!: () => void;
    const calls: AgentRendererRequest[] = [];
    const broker = new AgentBroker({
      resolveTarget: async (absolutePath) => ({
        absolutePath,
        vaultId: 'v',
        vaultRoot: '/v',
        relativePath: 'n.md',
        content: '',
        diskRevision: 'r',
      }),
      renderer: {
        dispatch: async (request) => {
          calls.push(request);
          if (request.type === 'append')
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          return { ok: true, documentVersion: calls.length, diskRevision: 'r' };
        },
      },
    });
    const connected = (await broker.handle(
      req('connect', { absolutePath: '/v/n.md' }),
    )) as any;
    const sid = connected.session.sessionId;
    const append = broker.handle(
      req('append', {
        sessionId: sid,
        operationId: 'a',
        sequence: 1,
        text: 'x',
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    const finish = broker.handle(req('finish', { sessionId: sid }));
    release();
    await append;
    assert.equal(((await finish) as any).session.state, 'finished');
    assert.deepEqual(
      calls
        .filter((call) => call.type === 'append' || call.type === 'finish')
        .map((call) => call.type),
      ['append', 'finish'],
    );

    const other = (await broker.handle(
      req('connect', { absolutePath: '/v/n.md' }),
    )) as any;
    const sid2 = other.session.sessionId;
    let releaseBlocked!: () => void;
    const original = (broker as any).options.renderer.dispatch;
    (broker as any).options.renderer.dispatch = async (
      request: AgentRendererRequest,
    ) => {
      calls.push(request);
      if (request.type === 'append' && request.sessionId === sid2)
        await new Promise<void>((resolve) => {
          releaseBlocked = resolve;
        });
      return { ok: true, documentVersion: calls.length, diskRevision: 'r' };
    };
    const blocked = broker.handle(
      req('append', {
        sessionId: sid2,
        operationId: 'b',
        sequence: 1,
        text: 'x',
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    const queued = broker.handle(
      req('append', {
        sessionId: sid2,
        operationId: 'c',
        sequence: 2,
        text: 'y',
      }),
    );
    const cancel = (await broker.handle(
      req('cancel', { sessionId: sid2 }),
    )) as any;
    assert.equal(cancel.ok, true);
    assert.equal(((await queued) as any).error.code, 'SESSION_CLOSED');
    releaseBlocked();
    await blocked;
    assert.equal(
      calls.filter((call) => call.type === 'append' && call.sessionId === sid2)
        .length,
      1,
    );
    (broker as any).options.renderer.dispatch = original;
  });

  it('disconnect fences queued appends and settles callers before a blocked renderer ACK', async () => {
    let release!: () => void;
    const calls: AgentRendererRequest[] = [];
    const broker = new AgentBroker({
      resolveTarget: async (absolutePath) => ({
        absolutePath,
        vaultId: 'v',
        vaultRoot: '/v',
        relativePath: 'n.md',
        content: '',
        diskRevision: 'r',
      }),
      renderer: {
        dispatch: async (request) => {
          calls.push(request);
          if (request.type === 'append')
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          return { ok: true, documentVersion: calls.length, diskRevision: 'r' };
        },
      },
    });
    const connected = (await broker.handle(
      req('connect', { absolutePath: '/v/n.md' }),
    )) as any;
    const sid = connected.session.sessionId;
    const first = broker.handle(
      req('append', {
        sessionId: sid,
        operationId: 'first',
        sequence: 1,
        text: 'accepted by renderer',
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    const second = broker.handle(
      req('append', {
        sessionId: sid,
        operationId: 'second',
        sequence: 2,
        text: 'queued',
      }),
    );
    const disconnected = (await broker.handle(
      req('disconnect', { sessionId: sid }),
    )) as any;
    assert.equal(disconnected.session.state, 'disconnected');

    const [firstResult, secondResult] = (await Promise.all([
      first,
      second,
    ])) as any[];
    assert.equal(firstResult.error.code, 'SESSION_CLOSED');
    assert.equal(secondResult.error.code, 'SESSION_CLOSED');
    let status = (await broker.handle(
      req('status', { sessionId: sid }),
    )) as any;
    assert.equal(status.sessions[0].state, 'disconnected');
    assert.equal(status.sessions[0].pendingOperations, 0);
    assert.equal(calls.filter((call) => call.type === 'append').length, 1);

    release();
    await Promise.resolve();
    await Promise.resolve();
    status = (await broker.handle(req('status', { sessionId: sid }))) as any;
    assert.equal(status.sessions[0].state, 'disconnected');
    assert.equal(
      status.sessions[0].documentVersion,
      connected.session.documentVersion,
    );
    assert.equal(status.sessions[0].pendingOperations, 0);
    assert.equal(calls.filter((call) => call.type === 'append').length, 1);
  });

  it('rejects append after cancellation', async () => {
    const { broker, calls } = setup();
    const connected = (await broker.handle(
      req('connect', { absolutePath: '/private/fixture/note.md' }),
    )) as any;
    const sid = connected.session.sessionId;
    const cancelled = (await broker.handle(
      req('cancel', { sessionId: sid }),
    )) as any;
    assert.equal(cancelled.ok, true);
    const result = (await broker.handle(
      req('append', {
        sessionId: sid,
        operationId: 'later',
        sequence: 1,
        text: 'must not apply',
      }),
    )) as any;
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'SESSION_CLOSED');
    assert.equal(calls.filter((call) => call.type === 'append').length, 0);
  });
});
