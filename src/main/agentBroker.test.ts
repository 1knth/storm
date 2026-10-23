import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentBroker,
  type AgentRendererRequest,
  type AgentRendererResult,
} from './agentBroker';
import { runVaultLifecycleExclusive } from './vaultLifecycle';

function setup() {
  const calls: AgentRendererRequest[] = [];
  const broker = new AgentBroker({
    resolveExistingTarget: async (absolutePath) => ({
      absolutePath,
      vaultId: 'fixture',
      vaultRoot: '/private/fixture',
      relativePath: 'note.md',
      content: 'disk text',
      diskRevision: 'rev',
    }),
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
        if (request.type === 'inspect')
          return {
            ok: true,
            inspected: true,
            open: true,
            content: 'live text',
            documentVersion: 1,
            diskRevision: 'rev',
            saveState: 'saved',
          };
        if (request.type === 'snapshot')
          return {
            ok: true,
            content: '',
            documentVersion: calls.length,
            diskRevision: 'rev',
            saveState: 'saved',
          };
        if (request.type === 'activity')
          return {
            ok: true,
            documentVersion: calls.length,
            diskRevision: 'rev',
          };
        if (request.type === 'append')
          return {
            ok: true,
            documentVersion: calls.length,
            diskRevision: 'rev',
          };
        if (request.type === 'finish' || request.type === 'cancel')
          return {
            ok: true,
            documentVersion: calls.length,
            diskRevision: 'rev',
          };
        return { ok: true, inspected: true, open: false };
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

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function brokerWithRenderer(
  dispatch: (request: AgentRendererRequest) => Promise<AgentRendererResult>,
) {
  return new AgentBroker({
    resolveTarget: async (absolutePath) => ({
      absolutePath,
      vaultId: 'outcome',
      vaultRoot: '/outcome',
      relativePath: 'note.md',
      content: '',
      diskRevision: 'r0',
    }),
    renderer: { dispatch },
  });
}

describe('agent context', () => {
  const makeBroker = (getContext?: () => Promise<any>) =>
    new AgentBroker({
      resolveTarget: async () => {
        throw new Error('not used');
      },
      renderer: {
        dispatch: async () => ({ ok: true, inspected: true, open: false }),
      },
      ...(getContext ? { getContext } : {}),
    });

  it('returns provider context without a session or renderer dispatch', async () => {
    const calls: AgentRendererRequest[] = [];
    const context = {
      registeredVaults: [
        { id: 'fixture', name: 'Fixture', path: '/private/fixture' },
      ],
      activeVaultId: 'fixture',
      activeNote: {
        vaultId: 'fixture',
        path: '/private/fixture/note.md',
        relativePath: 'note.md',
      },
      openNotes: [
        {
          vaultId: 'fixture',
          path: '/private/fixture/note.md',
          relativePath: 'note.md',
        },
      ],
    };
    const broker = new AgentBroker({
      resolveTarget: async () => {
        throw new Error('not used');
      },
      renderer: {
        dispatch: async (request) => {
          calls.push(request);
          return { ok: true, inspected: true, open: false };
        },
      },
      getContext: async () => context,
    });
    const request = req('context');
    assert.deepEqual(await broker.handle(request), {
      protocol: 1,
      requestId: request.requestId,
      ok: true,
      type: 'context',
      context,
    });
    assert.equal(calls.length, 0);
  });

  it('returns empty context, rejects unavailable context, and reports provider errors', async () => {
    const empty = {
      registeredVaults: [],
      activeVaultId: null,
      activeNote: null,
      openNotes: [],
    };
    const response = (await makeBroker(async () => empty).handle(
      req('context'),
    )) as any;
    assert.equal(response.type, 'context');
    assert.deepEqual(response.context, empty);
    const unavailable = (await makeBroker().handle(req('context'))) as any;
    assert.equal(unavailable.error.code, 'CONTEXT_UNAVAILABLE');
    const failed = (await makeBroker(async () => {
      throw new Error('provider failed');
    }).handle(req('context'))) as any;
    assert.equal(failed.ok, false);
    assert.equal(failed.error.code, 'INTERNAL');
    assert.equal(failed.error.message, 'provider failed');
    const invalid = (await makeBroker(async () => empty).handle({
      protocol: 1,
      type: 'context',
    })) as any;
    assert.equal(invalid.error.code, 'INVALID_REQUEST');
  });
});

describe('discovery request validation', () => {
  it('accepts valid discovery options and rejects malformed fields without dispatching', async () => {
    const calls: unknown[] = [];
    const broker = new AgentBroker({
      resolveTarget: async () => {
        throw new Error('not used');
      },
      renderer: {
        dispatch: async () => ({ ok: true, inspected: true, open: false }),
      },
      discover: async (...args) => {
        calls.push(args);
        return { results: [], unresolved: [] };
      },
      resolveLink: async (vaultId, sourcePath, target) => ({
        sourcePath,
        target,
      }),
    });
    const good = await broker.handle(
      req('discover', {
        vaultId: 'v',
        sourcePath: 'a.md',
        depth: 0,
        includeSource: false,
        limit: 100,
      }),
    );
    assert.equal(good.ok, true);
    assert.equal(calls.length, 1);
    const badInputs = [
      { depth: -1, sourcePath: 'a.md' },
      { depth: 6, sourcePath: 'a.md' },
      { depth: 1.5, sourcePath: 'a.md' },
      { depth: 1 },
      { includeSource: true },
      { includeSource: 'yes', sourcePath: 'a.md' },
      { sourcePath: '' },
      { limit: 0 },
      { limit: 101 },
      { limit: 1.2 },
    ];
    for (const fields of badInputs) {
      const response = await broker.handle(
        req('discover', { vaultId: 'v', ...fields }),
      );
      assert.equal(response.ok, false, JSON.stringify(fields));
      assert.equal(response.error.code, 'INVALID_REQUEST');
    }
    for (const fields of [
      { sourcePath: '' },
      { sourcePath: 'a.md', target: '' },
      { sourcePath: 'a.md', target: 'x'.repeat(513) },
    ]) {
      const response = await broker.handle(
        req('resolve-link', { vaultId: 'v', target: 'x', ...fields }),
      );
      assert.equal(response.ok, false);
      assert.equal(response.error.code, 'INVALID_REQUEST');
    }
    assert.equal(calls.length, 1);
  });
});

describe('renderer reload lifecycle', () => {
  it('keeps an in-flight append uncertain if an old renderer replies after reload', async () => {
    const response = deferred<AgentRendererResult>();
    const broker = brokerWithRenderer(async (request) => {
      if (request.type === 'snapshot')
        return { ok: true, documentVersion: 0, diskRevision: 'r0' };
      if (request.type === 'append') return response.promise;
      return { ok: true, documentVersion: 1, diskRevision: 'r1' };
    });
    const connected = (await broker.handle(
      req('connect', { absolutePath: '/outcome/note.md' }),
    )) as any;
    const sessionId = connected.session.sessionId;
    const append = broker.handle(
      req('append', {
        sessionId,
        operationId: 'reload-append',
        sequence: 1,
        text: 'accepted by old renderer',
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    broker.rendererUnavailable();
    response.resolve({ ok: true, documentVersion: 1, diskRevision: 'r1' });
    const result = (await append) as any;
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'SESSION_CLOSED');
    const status = (await broker.handle(req('status', { sessionId }))) as any;
    assert.equal(status.sessions[0].state, 'disconnected');
    assert.equal(status.sessions[0].outcomeUncertain, true);
  });

  it('disconnects old sessions, rejects stale mutations, and permits a fresh generation after readiness', async () => {
    const { broker } = setup();
    const connected = (await broker.handle(
      req('connect', { absolutePath: '/note.md' }),
    )) as any;
    const oldId = connected.session.sessionId;
    broker.rendererUnavailable();
    const status = (await broker.handle(
      req('status', { sessionId: oldId }),
    )) as any;
    assert.equal(status.sessions[0].state, 'disconnected');
    const stale = (await broker.handle(
      req('append', {
        sessionId: oldId,
        operationId: 'old-op',
        sequence: 1,
        text: 'stale',
      }),
    )) as any;
    assert.equal(stale.error.code, 'SESSION_CLOSED');
    const blocked = (await broker.handle(
      req('connect', { absolutePath: '/note.md' }),
    )) as any;
    assert.equal(blocked.ok, false);
    broker.rendererReady();
    const fresh = (await broker.handle(
      req('connect', { absolutePath: '/note.md' }),
    )) as any;
    assert.equal(fresh.ok, true);
    assert.notEqual(fresh.session.sessionId, oldId);
  });
});

describe('reported activity', () => {
  it('acknowledges activity without waiting for telemetry and keeps writes independent of delivery failure', async () => {
    const activityDelivery = deferred<AgentRendererResult>();
    const calls: AgentRendererRequest[] = [];
    const broker = brokerWithRenderer(async (request) => {
      calls.push(request);
      if (request.type === 'snapshot')
        return { ok: true, documentVersion: 0, diskRevision: 'r0' };
      if (request.type === 'activity') return activityDelivery.promise;
      if (request.type === 'append')
        return { ok: true, documentVersion: 1, diskRevision: 'r1' };
      return { ok: true, documentVersion: 1, diskRevision: 'r1' };
    });
    const connected = (await broker.handle(
      req('connect', { absolutePath: '/outcome/note.md' }),
    )) as any;
    const sessionId = connected.session.sessionId;

    const activity = (await broker.handle(
      req('activity', { sessionId, activity: 'thinking' }),
    )) as any;
    assert.equal(activity.ok, true);
    assert.equal(activity.session.activity, 'thinking');
    const activityRequest = calls.at(-1);
    assert.equal(activityRequest?.type, 'activity');
    if (activityRequest?.type === 'activity') {
      assert.equal(activityRequest.activitySequence, 1);
      assert.equal(activityRequest.documentVersion, 0);
    }
    assert.deepEqual(
      calls.map((call) => call.type),
      ['snapshot', 'activity'],
    );

    const write = (await broker.handle(
      req('append', {
        sessionId,
        operationId: 'write-1',
        sequence: 1,
        text: 'saved content',
      }),
    )) as any;
    assert.equal(write.ok, true);
    assert.equal(write.type, 'accepted');
    assert.equal(calls.at(-1)?.type, 'append');

    activityDelivery.resolve({
      ok: false,
      code: 'SESSION_CLOSED',
      message: 'Renderer unavailable',
    });
    await Promise.resolve();
    const status = (await broker.handle(req('status', { sessionId }))) as any;
    assert.equal(status.sessions[0].state, 'connected');
    assert.equal(status.sessions[0].documentVersion, 1);
  });

  it('dispatches validated activity best-effort and clears it on writes and terminal states', async () => {
    const { broker, calls } = setup();
    const connected = (await broker.handle(
      req('connect', { absolutePath: '/vault/note.md' }),
    )) as any;
    const sessionId = connected.session.sessionId;
    const thinking = (await broker.handle(
      req('activity', { sessionId, activity: 'thinking' }),
    )) as any;
    assert.equal(thinking.session.activity, 'thinking');
    assert.equal(calls.at(-1)?.type, 'activity');
    const invalid = (await broker.handle(
      req('activity', { sessionId, activity: 'guessing' }),
    )) as any;
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error.code, 'INVALID_REQUEST');
    await broker.handle(req('activity', { sessionId, activity: 'drafting' }));
    await broker.handle(
      req('append', { sessionId, operationId: 'op', sequence: 1, text: 'hi' }),
    );
    const status = (await broker.handle(req('status', { sessionId }))) as any;
    assert.equal(status.sessions[0].state, 'connected');
    assert.equal(status.sessions[0].activity, undefined);
    await broker.handle(req('activity', { sessionId, activity: 'thinking' }));
    const closed = (await broker.handle(req('finish', { sessionId }))) as any;
    assert.equal(closed.session.state, 'finished');
    assert.equal(closed.session.activity, undefined);
    const stale = (await broker.handle(
      req('activity', { sessionId, activity: 'drafting' }),
    )) as any;
    assert.equal(stale.ok, false);
    assert.equal(stale.error.code, 'SESSION_CLOSED');
  });
});

describe('uncertain write outcomes', () => {
  for (const type of ['append', 'edit-apply'] as const) {
    it(`reconciles a saved ${type} after timeout without reopening a cancelled session`, async () => {
      const calls: string[] = [];
      const broker = brokerWithRenderer(async (request) => {
        calls.push(request.type);
        if (request.type === 'snapshot')
          return { ok: true, documentVersion: 0, diskRevision: 'r0' };
        if (request.type === 'cancel')
          return { ok: true, documentVersion: 1, diskRevision: 'r1' };
        return {
          ok: false,
          code: 'RENDERER_TIMEOUT',
          message: 'Reply lost after save',
        };
      });
      const {
        session: { sessionId },
      } = (await broker.handle(
        req('connect', { absolutePath: '/outcome/note.md' }),
      )) as any;
      const write = {
        sessionId,
        operationId: 'one',
        expectedVersion: 0,
        plan: { type: 'replace', content: 'saved' },
        sequence: 1,
        text: 'saved',
      };
      const failed = (await broker.handle(req(type, write))) as any;
      assert.equal(failed.ok, false);
      assert.equal(failed.error.code, 'RENDERER_TIMEOUT');
      const uncertain = (await broker.handle(
        req('status', { sessionId }),
      )) as any;
      assert.equal(uncertain.sessions[0].outcomeUncertain, true);
      assert.equal(uncertain.sessions[0].pendingOperations, 0);
      const cancelled = (await broker.handle(
        req('cancel', { sessionId }),
      )) as any;
      assert.equal(cancelled.session.state, 'cancelled');
      assert.equal(cancelled.session.documentVersion, 1);
      assert.equal(cancelled.session.diskRevision, 'r1');
      assert.equal(cancelled.session.outcomeUncertain, undefined);
      const denied = (await broker.handle(
        req(type, { ...write, operationId: 'two' }),
      )) as any;
      assert.equal(denied.error.code, 'SESSION_CLOSED');
      assert.deepEqual(calls, ['snapshot', type, 'cancel']);
    });
  }

  for (const cancellation of ['timeout', 'throw'] as const) {
    it(`retains uncertainty when cancellation confirmation is lost (${cancellation})`, async () => {
      const broker = brokerWithRenderer(async (request) => {
        if (request.type === 'snapshot')
          return { ok: true, documentVersion: 0, diskRevision: 'r0' };
        if (request.type === 'cancel' && cancellation === 'throw')
          throw new Error('Connection lost');
        return { ok: false, code: 'RENDERER_TIMEOUT', message: 'No reply' };
      });
      const connected = (await broker.handle(
        req('connect', { absolutePath: '/outcome/note.md' }),
      )) as any;
      const sessionId = connected.session.sessionId;
      await broker.handle(
        req('edit-apply', {
          sessionId,
          operationId: 'one',
          expectedVersion: 0,
          plan: { type: 'replace', content: 'saved maybe' },
        }),
      );
      await broker.handle(req('cancel', { sessionId }));
      const status = (await broker.handle(req('status', { sessionId }))) as any;
      assert.equal(status.sessions[0].state, 'cancelled');
      assert.equal(status.sessions[0].outcomeUncertain, true);
      assert.equal(status.sessions[0].documentVersion, 0);
      assert.equal(status.sessions[0].diskRevision, 'r0');
    });
  }

  it('fences queued edits and never regresses a cancellation save from a late edit response', async () => {
    const entered = deferred();
    const held = deferred<AgentRendererResult>();
    let writes = 0;
    const broker = brokerWithRenderer(async (request) => {
      if (request.type === 'snapshot')
        return { ok: true, documentVersion: 0, diskRevision: 'r0' };
      if (request.type === 'cancel')
        return { ok: true, documentVersion: 2, diskRevision: 'r2' };
      writes++;
      entered.resolve();
      return held.promise;
    });
    const connected = (await broker.handle(
      req('connect', { absolutePath: '/outcome/note.md' }),
    )) as any;
    const sessionId = connected.session.sessionId;
    const edit = {
      sessionId,
      expectedVersion: 0,
      plan: { type: 'replace', content: 'first' },
    };
    const first = broker.handle(
      req('edit-apply', { ...edit, operationId: 'one' }),
    );
    await entered.promise;
    const second = broker.handle(
      req('edit-apply', { ...edit, operationId: 'two' }),
    );
    const cancelled = (await broker.handle(
      req('cancel', { sessionId }),
    )) as any;
    assert.equal(cancelled.session.state, 'cancelled');
    held.resolve({
      ok: true,
      edited: true,
      content: 'first',
      documentVersion: 1,
      diskRevision: 'r1',
    });
    for (const response of (await Promise.all([first, second])) as any[]) {
      assert.equal(response.ok, false);
      assert.equal(response.error.code, 'SESSION_CLOSED');
    }
    assert.equal(writes, 1);
    const status = (await broker.handle(req('status', { sessionId }))) as any;
    assert.equal(status.sessions[0].state, 'cancelled');
    assert.equal(status.sessions[0].documentVersion, 2);
    assert.equal(status.sessions[0].diskRevision, 'r2');
    assert.equal(status.sessions[0].pendingOperations, 0);
    assert.equal(status.sessions[0].outcomeUncertain, undefined);
  });
});

describe('AgentBroker', () => {
  it('inspects existing notes without creating sessions and returns disk content when closed', async () => {
    const { broker, calls } = setup();
    const result = (await broker.handle(
      req('inspect', { absolutePath: '/private/fixture/note.md' }),
    )) as any;
    assert.deepEqual(result, {
      protocol: 1,
      requestId: (result as any).requestId,
      ok: true,
      type: 'inspected',
      open: true,
      source: 'live',
      content: 'live text',
      documentVersion: 1,
      diskRevision: 'rev',
      saveState: 'saved',
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.type, 'inspect');
    assert.equal(broker.hasWritableSessionForVault('fixture'), false);
  });
  it('maps preview and apply renderer actions and returns saved confirmation only after apply', async () => {
    const calls: AgentRendererRequest[] = [];
    const broker = new AgentBroker({
      resolveTarget: async (absolutePath) => ({
        absolutePath,
        vaultId: 'v',
        vaultRoot: '/v',
        relativePath: 'n.md',
        content: '',
        diskRevision: 'r0',
      }),
      renderer: {
        dispatch: async (request) => {
          calls.push(request);
          if (request.type === 'snapshot')
            return { ok: true, documentVersion: 2, diskRevision: 'r0' };
          if (request.type === 'edit-preview')
            return {
              ok: true,
              preview: true,
              content: 'draft',
              changed: true,
              documentVersion: 2,
              diskRevision: 'r0',
            };
          if (request.type === 'edit-apply')
            return {
              ok: true,
              edited: true,
              content: 'saved',
              documentVersion: 3,
              diskRevision: 'r1',
            };
          return { ok: true, inspected: true, open: false };
        },
      },
    });
    const connected = (await broker.handle(
      req('connect', { absolutePath: '/v/n.md' }),
    )) as any;
    const sessionId = connected.session.sessionId;
    const plan = { type: 'replace', content: 'saved' };
    const preview = (await broker.handle(
      req('edit-preview', {
        sessionId,
        expectedVersion: 2,
        operationId: 'preview',
        plan,
      }),
    )) as any;
    const applied = (await broker.handle(
      req('edit-apply', {
        sessionId,
        expectedVersion: 2,
        operationId: 'apply',
        plan,
      }),
    )) as any;
    assert.equal(preview.type, 'preview');
    assert.equal('saveState' in preview, false);
    assert.equal(applied.type, 'edited');
    assert.equal(applied.saveState, 'saved');
    assert.deepEqual(
      calls
        .filter(
          (call) => call.type === 'edit-preview' || call.type === 'edit-apply',
        )
        .map((call) =>
          call.type === 'edit-preview' || call.type === 'edit-apply'
            ? [call.type, call.expectedVersion, call.plan]
            : null,
        ),
      [
        ['edit-preview', 2, plan],
        ['edit-apply', 2, plan],
      ],
    );
  });

  it('replays the original edit apply outcome for identical operation IDs and rejects changed payloads', async () => {
    let applyCalls = 0;
    const broker = new AgentBroker({
      resolveTarget: async (absolutePath) => ({
        absolutePath,
        vaultId: 'v',
        vaultRoot: '/v',
        relativePath: 'n.md',
        content: '',
        diskRevision: 'r0',
      }),
      renderer: {
        dispatch: async (request) => {
          if (request.type === 'snapshot')
            return { ok: true, documentVersion: 1, diskRevision: 'r0' };
          if (request.type === 'edit-apply') {
            applyCalls++;
            return {
              ok: true,
              edited: true,
              content: 'saved once',
              documentVersion: 2,
              diskRevision: 'r1',
              saveState: 'saved',
            };
          }
          return { ok: false, code: 'INTERNAL', message: 'unexpected request' };
        },
      },
    });
    const connected = (await broker.handle(
      req('connect', { absolutePath: '/v/n.md' }),
    )) as any;
    const sessionId = connected.session.sessionId;
    const payload = {
      sessionId,
      operationId: 'once',
      expectedVersion: 1,
      plan: { type: 'replace', content: 'x' },
    };
    const first = (await broker.handle(req('edit-apply', payload))) as any;
    const replay = (await broker.handle(req('edit-apply', payload))) as any;
    const conflict = (await broker.handle(
      req('edit-apply', {
        ...payload,
        plan: { type: 'replace', content: 'different' },
      }),
    )) as any;
    assert.deepEqual({ ...replay, requestId: first.requestId }, first);
    assert.equal(applyCalls, 1);
    assert.equal(conflict.error.code, 'DUPLICATE_OPERATION');
  });

  it('returns stale and save errors without claiming an edit was saved', async () => {
    for (const [message, code] of [
      ['stale document version', 'STALE_VERSION'],
      ['save failed', 'SAVE_FAILED'],
    ] as const) {
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
          dispatch: async (request) =>
            request.type === 'snapshot'
              ? { ok: true, documentVersion: 4, diskRevision: 'r' }
              : { ok: false, code, message },
        },
      });
      const connected = (await broker.handle(
        req('connect', { absolutePath: '/v/n.md' }),
      )) as any;
      const response = (await broker.handle(
        req('edit-apply', {
          sessionId: connected.session.sessionId,
          expectedVersion: 3,
          operationId: 'edit',
          plan: { type: 'replace', content: 'x' },
        }),
      )) as any;
      assert.equal(response.ok, false);
      assert.equal(response.error.code, code);
      assert.equal('saveState' in response, false);
    }
  });

  it('serializes concurrent edit requests through the renderer queue', async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const order: string[] = [];
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
          if (request.type === 'snapshot')
            return { ok: true, documentVersion: 1, diskRevision: 'r' };
          if (request.type === 'edit-preview') {
            order.push('first-start');
            started.resolve();
            await release.promise;
            order.push('first-end');
            return {
              ok: true,
              preview: true,
              content: '',
              changed: false,
              documentVersion: 1,
              diskRevision: 'r',
            };
          }
          if (request.type === 'edit-apply') {
            order.push('second');
            return {
              ok: true,
              edited: true,
              content: 'x',
              documentVersion: 2,
              diskRevision: 'r2',
            };
          }
          return { ok: true, inspected: true, open: false };
        },
      },
    });
    const connected = (await broker.handle(
      req('connect', { absolutePath: '/v/n.md' }),
    )) as any;
    const sessionId = connected.session.sessionId;
    const first = broker.handle(
      req('edit-preview', {
        sessionId,
        expectedVersion: 1,
        operationId: 'p',
        plan: { type: 'replace', content: 'x' },
      }),
    );
    await started.promise;
    const second = broker.handle(
      req('edit-apply', {
        sessionId,
        expectedVersion: 1,
        operationId: 'a',
        plan: { type: 'replace', content: 'x' },
      }),
    );
    release.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['first-start', 'first-end', 'second']);
  });

  it('serializes connect snapshot against unload and rejects unload once session exists', async () => {
    const snapshot = deferred<void>();
    const started = deferred<void>();
    let registered = true;
    let removed = false;
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
      assertTargetRegistered: async () => {
        if (!registered) throw new Error('Vault is not registered');
      },
      withVaultLifecycle: runVaultLifecycleExclusive,
      renderer: {
        dispatch: async (request) => {
          calls.push(request);
          if (request.type === 'snapshot') {
            started.resolve();
            await snapshot.promise;
          }
          return { ok: true, documentVersion: 1, diskRevision: 'r' };
        },
      },
    });
    const connect = broker.handle(req('connect', { absolutePath: '/v/n.md' }));
    await started.promise;
    const unload = runVaultLifecycleExclusive('/v', async () => {
      if (broker.hasWritableSessionForVault('v'))
        throw new Error('active agent session');
      removed = true;
    });
    snapshot.resolve();
    assert.equal(((await connect) as any).ok, true);
    await assert.rejects(unload, /active agent session/);
    assert.equal(removed, false);
    assert.equal(calls.filter((call) => call.type === 'snapshot').length, 1);
  });

  it('rechecks registration under lifecycle lock when unload wins the race', async () => {
    const entered = deferred<void>();
    const finishUnload = deferred<void>();
    let registered = true;
    let snapshots = 0;
    const broker = new AgentBroker({
      resolveTarget: async (absolutePath) => ({
        absolutePath,
        vaultId: 'v',
        vaultRoot: '/v',
        relativePath: 'n.md',
        content: '',
        diskRevision: 'r',
      }),
      assertTargetRegistered: async () => {
        if (!registered) throw new Error('Vault is not registered');
      },
      withVaultLifecycle: runVaultLifecycleExclusive,
      renderer: {
        dispatch: async () => {
          snapshots++;
          return { ok: true, documentVersion: 1, diskRevision: 'r' };
        },
      },
    });
    const unload = runVaultLifecycleExclusive('/v', async () => {
      entered.resolve();
      await finishUnload.promise;
      registered = false;
    });
    await entered.promise;
    const connect = broker.handle(req('connect', { absolutePath: '/v/n.md' }));
    finishUnload.resolve();
    await unload;
    const result = (await connect) as any;
    assert.equal(result.ok, false);
    assert.match(result.error.message, /not registered/);
    assert.equal(snapshots, 0);
  });
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

  it('returns to connected between acknowledged chunks and finishes cleanly', async () => {
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
      assert.equal(status.sessions[0].state, 'connected');
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

  it('disconnect fences callers but observes late document state without reopening', async () => {
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
    assert.equal(status.sessions[0].outcomeUncertain, true);
    assert.equal(calls.filter((call) => call.type === 'append').length, 1);

    release();
    await Promise.resolve();
    await Promise.resolve();
    status = (await broker.handle(req('status', { sessionId: sid }))) as any;
    assert.equal(status.sessions[0].state, 'disconnected');
    assert.equal(
      status.sessions[0].documentVersion,
      connected.session.documentVersion + 1,
    );
    assert.equal(status.sessions[0].outcomeUncertain, undefined);
    assert.equal(status.sessions[0].pendingOperations, 0);
    assert.equal(calls.filter((call) => call.type === 'append').length, 1);
  });

  it('fences rename leases against connects already resolving targets', async () => {
    const target = deferred<any>();
    const resolved = deferred<void>();
    const broker = new AgentBroker({
      resolveTarget: async (absolutePath) => {
        resolved.resolve();
        return target.promise.then((value) => ({ ...value, absolutePath }));
      },
      renderer: {
        dispatch: async () => ({
          ok: true,
          documentVersion: 1,
          diskRevision: 'r',
        }),
      },
    });
    const connecting = broker.handle(
      req('connect', { absolutePath: '/v/n.md' }),
    );
    await resolved.promise;
    assert.equal(broker.acquireMaintenanceLease('v'), null);
    target.resolve({
      vaultId: 'v',
      vaultRoot: '/v',
      relativePath: 'n.md',
      content: '',
      diskRevision: 'r',
    });
    const connected = (await connecting) as any;
    assert.equal(connected.ok, true);
    assert.equal(broker.acquireMaintenanceLease('v'), null);
    await broker.handle(
      req('finish', { sessionId: connected.session.sessionId }),
    );
    const release = broker.acquireMaintenanceLease('v');
    assert.equal(typeof release, 'function');
    assert.equal(broker.isMaintenanceLeased('v'), true);
    release?.();
    assert.equal(broker.isMaintenanceLeased('v'), false);
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
