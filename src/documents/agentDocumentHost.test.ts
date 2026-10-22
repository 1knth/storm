import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { createAgentDocumentHost } from './agentDocumentHost';

describe('agent document host', () => {
  function makeHost(saveNote = async () => ({ revision: 'r2' })) {
    const published: string[] = [];
    const statuses: string[] = [];
    const statusEvents: Array<{ state: string; activity?: string }> = [];
    const host = createAgentDocumentHost({
      lookupDocument: () => undefined,
      openDocument: async ({ absolutePath }) => ({
        key: 'vault:notes/a.md',
        vaultId: 'vault',
        absolutePath,
        vaultPath: '/vault',
        path: 'notes/a.md',
        state: EditorState.create({ doc: 'start' }),
        revision: 'r1',
      }),
      publishDocument: (document) =>
        published.push(document.state.doc.toString()),
      publishStatus: (event) => {
        statuses.push(event.session.state);
        statusEvents.push(event.session);
      },
      saveNote,
      getAdapterFor: () => undefined,
    });
    return { host, published, statuses, statusEvents };
  }

  it('exposes the adapter lookup used by tab closing for managed and unmanaged notes', () => {
    const adapter = {
      vaultId: 'vault',
      path: 'notes/a.md',
      writing: false,
      onStateChange: () => {},
      flush: async () => true,
    };
    const options = {
      lookupDocument: () => undefined,
      openDocument: async () => ({
        key: 'vault:notes/a.md',
        vaultId: 'vault',
        absolutePath: '/vault/notes/a.md',
        vaultPath: '/vault',
        path: 'notes/a.md',
        state: EditorState.create({ doc: 'start' }),
        revision: 'r1',
      }),
      publishDocument: () => {},
      publishStatus: () => {},
      saveNote: async () => ({ revision: 'r2' }),
      getAdapterFor: (vaultId: string, path: string) =>
        vaultId === 'vault' && path === 'notes/a.md' ? adapter : undefined,
    };
    const host = createAgentDocumentHost(options);
    const closeCaller = {
      getAdapterFor: host.getAdapterFor,
    } satisfies Pick<
      ReturnType<typeof createAgentDocumentHost>,
      'getAdapterFor'
    >;
    assert.equal(closeCaller.getAdapterFor('vault', 'notes/a.md'), adapter);
    assert.equal(
      closeCaller.getAdapterFor('vault', 'notes/ordinary.md'),
      undefined,
    );
    host.dispose();
  });

  it('inspects only an already-open document without creating a session or saving', async () => {
    const document = {
      key: 'vault:notes/a.md',
      vaultId: 'vault',
      absolutePath: '/vault/notes/a.md',
      vaultPath: '/vault',
      path: 'notes/a.md',
      state: EditorState.create({ doc: 'unsaved live text' }),
      revision: 'r1',
    };
    let opened = 0;
    let saved = 0;
    const host = createAgentDocumentHost({
      lookupDocument: () => document,
      openDocument: async () => {
        opened++;
        return document;
      },
      publishDocument: () => {},
      publishStatus: () => {},
      saveNote: async () => {
        saved++;
        return { revision: 'r2' };
      },
      getAdapterFor: () => undefined,
    });
    const result = await host.handleRequest({
      type: 'inspect',
      requestId: 'i',
      vaultId: 'vault',
      path: 'notes/a.md',
      absolutePath: '/vault/notes/a.md',
      vaultRoot: '/vault',
      content: 'disk',
      diskRevision: 'r0',
    } as any);
    assert.deepEqual(result, {
      ok: true,
      inspected: true,
      open: true,
      content: 'unsaved live text',
      documentVersion: 0,
      diskRevision: 'r1',
      saveState: 'saved',
    });
    assert.equal(opened, 0);
    assert.equal(saved, 0);
    assert.equal(
      host.controller.get('vault:notes/a.md')?.state.doc.toString(),
      'unsaved live text',
    );
    host.dispose();
  });

  it('returns a closed-document marker without opening it', async () => {
    const { host } = makeHost();
    const result = await host.handleRequest({
      type: 'inspect',
      requestId: 'i',
      vaultId: 'vault',
      path: 'notes/a.md',
      absolutePath: '/vault/notes/a.md',
      vaultRoot: '/vault',
      content: 'disk text',
      diskRevision: 'r1',
    } as any);
    assert.deepEqual(result, { ok: true, inspected: true, open: false });
    assert.equal(host.controller.get('vault:notes/a.md'), undefined);
    host.dispose();
  });

  it('snapshots document content and binds the session to its opened identity', async () => {
    const { host } = makeHost();
    const result = await host.handleRequest({
      type: 'snapshot',
      requestId: 'connect-request',
      sessionId: 'session-1',
      absolutePath: '/vault/notes/a.md',
      vaultId: 'vault',
      vaultRoot: '/vault',
    });
    assert.deepEqual(result, {
      ok: true,
      content: 'start',
      documentVersion: 0,
      diskRevision: 'r1',
    });
    assert.equal(host.controller.get('vault:notes/a.md')?.path, 'notes/a.md');
    host.dispose();
  });

  it('reconnects after finish with a fresh session while preserving saved content', async () => {
    let savedContent = 'initial';
    const statuses: Array<{
      state: string;
      activity?: string;
      sessionId: string;
    }> = [];
    const host = createAgentDocumentHost({
      lookupDocument: () => undefined,
      openDocument: async ({ absolutePath }) => ({
        key: 'vault:notes/a.md',
        vaultId: 'vault',
        absolutePath,
        vaultPath: '/vault',
        path: 'notes/a.md',
        state: EditorState.create({ doc: savedContent }),
        revision: `r${savedContent.length}`,
      }),
      publishDocument: () => {},
      publishStatus: (event) => statuses.push(event.session),
      saveNote: async ({ content }) => {
        savedContent = content;
        return { revision: `r${content.length}` };
      },
      getAdapterFor: () => undefined,
    });
    const snapshot = (sessionId: string) =>
      host.handleRequest({
        type: 'snapshot',
        requestId: `snapshot-${sessionId}`,
        sessionId,
        absolutePath: '/vault/notes/a.md',
        vaultId: 'vault',
        vaultRoot: '/vault',
      });
    const finish = (sessionId: string) =>
      host.handleRequest({
        type: 'finish',
        requestId: `finish-${sessionId}`,
        sessionId,
      });

    const first = await snapshot('old-session');
    assert.equal(first.ok, true);
    const appended = await host.handleRequest({
      type: 'append',
      requestId: 'append-old',
      sessionId: 'old-session',
      absolutePath: '/vault/notes/a.md',
      operationId: 'append-op',
      sequence: 1,
      text: '\nSaved draft',
    });
    assert.equal(appended.ok, true);
    assert.equal((await finish('old-session')).ok, true);
    assert.equal(savedContent, 'initial\nSaved draft');

    const reconnected = await snapshot('new-session');
    assert.deepEqual(reconnected, {
      ok: true,
      content: 'initial\nSaved draft',
      documentVersion: 0,
      diskRevision: 'r19',
    });
    assert.equal(host.controller.get('vault:notes/a.md')?.status, 'connected');
    assert.equal(host.controller.get('vault:notes/a.md')?.activity, undefined);
    assert.equal(statuses.at(-1)?.sessionId, 'new-session');
    assert.equal(statuses.at(-1)?.state, 'connected');
    assert.equal(
      (
        await host.handleRequest({
          type: 'activity',
          requestId: 'old-activity',
          sessionId: 'old-session',
          activity: 'thinking',
        })
      ).ok,
      false,
    );

    for (const activity of ['thinking', 'drafting'] as const) {
      const result = await host.handleRequest({
        type: 'activity',
        requestId: `activity-${activity}`,
        sessionId: 'new-session',
        activity,
      });
      assert.equal(result.ok, true);
      assert.equal(statuses.at(-1)?.activity, activity);
    }
    const edit = await host.handleRequest({
      type: 'edit-apply',
      requestId: 'edit-new',
      sessionId: 'new-session',
      expectedVersion: 0,
      plan: { type: 'replace', content: 'Revised complete draft' },
    });
    assert.equal(edit.ok, true);
    assert.equal(savedContent, 'Revised complete draft');
    assert.equal((await finish('new-session')).ok, true);
    assert.equal(statuses.at(-1)?.state, 'finished');
    host.dispose();
  });

  it('publishes agent-reported activity and clears it when appending', async () => {
    const { host, statusEvents, published } = makeHost();
    await host.handleRequest({
      type: 'snapshot',
      requestId: 'snapshot',
      sessionId: 'session-1',
      absolutePath: '/vault/notes/a.md',
      vaultId: 'vault',
      vaultRoot: '/vault',
    });
    const documentPublicationsBeforeActivity = published.length;
    await host.handleRequest({
      type: 'activity',
      requestId: 'activity',
      sessionId: 'session-1',
      activity: 'thinking',
    });
    assert.equal(statusEvents.at(-1)?.state, 'connected');
    assert.equal(statusEvents.at(-1)?.activity, 'thinking');
    assert.equal(published.length, documentPublicationsBeforeActivity);
    await host.handleRequest({
      type: 'append',
      requestId: 'append',
      sessionId: 'session-1',
      absolutePath: '/vault/notes/a.md',
      operationId: 'op',
      sequence: 1,
      text: 'new',
    });
    assert.equal(statusEvents.at(-1)?.state, 'connected');
    assert.equal(statusEvents.at(-1)?.activity, undefined);
    host.dispose();
  });

  it('ignores stale and out-of-order activity without changing terminal state', async () => {
    const { host, statusEvents } = makeHost();
    const snapshot = (sessionId: string) =>
      host.handleRequest({
        type: 'snapshot',
        requestId: `snapshot-${sessionId}`,
        sessionId,
        absolutePath: '/vault/notes/a.md',
        vaultId: 'vault',
        vaultRoot: '/vault',
      });
    await snapshot('session-1');
    const append = await host.handleRequest({
      type: 'append',
      requestId: 'append',
      sessionId: 'session-1',
      absolutePath: '/vault/notes/a.md',
      operationId: 'append-op',
      sequence: 1,
      text: 'changed',
    });
    assert.equal(append.ok, true);
    const changedVersion =
      host.controller.get('vault:notes/a.md')!.acceptedVersion;
    assert.equal(changedVersion, 1);

    const sendActivity = (
      requestId: string,
      sessionId: string,
      activitySequence: number,
      documentVersion: number,
    ) =>
      host.handleRequest({
        type: 'activity',
        requestId,
        sessionId,
        activity: 'thinking',
        activitySequence,
        documentVersion,
      } as any);

    await sendActivity('delayed-before-append', 'session-1', 1, 0);
    assert.equal(host.controller.get('vault:notes/a.md')?.activity, undefined);
    await sendActivity('latest', 'session-1', 2, changedVersion);
    assert.equal(host.controller.get('vault:notes/a.md')?.activity, 'thinking');
    await sendActivity('out-of-order', 'session-1', 1, changedVersion);
    assert.equal(host.controller.get('vault:notes/a.md')?.activity, 'thinking');

    await host.handleRequest({
      type: 'finish',
      requestId: 'finish-old-session',
      sessionId: 'session-1',
    });
    await snapshot('session-2');
    assert.equal(host.controller.get('vault:notes/a.md')?.activity, undefined);
    const currentPhase = await sendActivity(
      'current-session-phase',
      'session-2',
      1,
      changedVersion,
    );
    assert.equal(currentPhase.ok, true);
    const oldSessionActivity = await sendActivity(
      'old-session',
      'session-1',
      3,
      changedVersion,
    );
    assert.equal(oldSessionActivity.ok, false);
    await host.handleRequest({
      type: 'finish',
      requestId: 'finish',
      sessionId: 'session-2',
    });
    const terminalStatus = statusEvents.at(-1);
    await sendActivity('after-finish', 'session-2', 1, changedVersion);
    assert.equal(statusEvents.at(-1)?.state, 'finished');
    assert.equal(statusEvents.at(-1)?.activity, terminalStatus?.activity);
    host.dispose();
  });

  it('applies append to the document and publishes its writing status', async () => {
    const { host, published, statuses } = makeHost();
    await host.handleRequest({
      type: 'snapshot',
      requestId: 'connect-request',
      sessionId: 'session-1',
      absolutePath: '/vault/notes/a.md',
      vaultId: 'vault',
      vaultRoot: '/vault',
    });
    const result = await host.handleRequest({
      type: 'append',
      requestId: 'append-1',
      sessionId: 'session-1',
      absolutePath: '/vault/notes/a.md',
      operationId: 'op-1',
      sequence: 1,
      text: '\nagent',
    });
    assert.equal(result.ok, true);
    assert.equal(
      host.controller.get('vault:notes/a.md')?.state.doc.toString(),
      'start\nagent',
    );
    assert.ok(published.includes('start\nagent'));
    assert.ok(statuses.includes('writing'));
    host.dispose();
  });

  it('rejects requests for missing sessions and rejects late appends after cancellation', async () => {
    const { host } = makeHost();
    const missing = await host.handleRequest({
      type: 'append',
      requestId: 'a',
      sessionId: 'missing',
      absolutePath: '/vault/notes/a.md',
      operationId: 'op',
      sequence: 1,
      text: 'x',
    });
    assert.deepEqual(missing, {
      ok: false,
      code: 'SESSION_CLOSED',
      message: 'Session is not open',
    });
    await host.handleRequest({
      type: 'snapshot',
      requestId: 'connect-request',
      sessionId: 'session-1',
      absolutePath: '/vault/notes/a.md',
      vaultId: 'vault',
      vaultRoot: '/vault',
    });
    await host.handleRequest({
      type: 'cancel',
      requestId: 'cancel',
      sessionId: 'session-1',
    });
    const late = await host.handleRequest({
      type: 'append',
      requestId: 'late',
      sessionId: 'session-1',
      absolutePath: '/vault/notes/a.md',
      operationId: 'op',
      sequence: 1,
      text: 'x',
    });
    assert.equal(late.ok, false);
    assert.equal(
      host.controller.get('vault:notes/a.md')?.state.doc.toString(),
      'start',
    );
    host.dispose();
  });

  it('flushes accepted content on finish and reports save failures', async () => {
    const { host } = makeHost(async () => {
      throw new Error('disk conflict');
    });
    await host.handleRequest({
      type: 'snapshot',
      requestId: 'connect-request',
      sessionId: 'session-1',
      absolutePath: '/vault/notes/a.md',
      vaultId: 'vault',
      vaultRoot: '/vault',
    });
    await host.handleRequest({
      type: 'append',
      requestId: 'append-1',
      sessionId: 'session-1',
      absolutePath: '/vault/notes/a.md',
      operationId: 'op-1',
      sequence: 1,
      text: '\nagent',
    });
    const result = await host.handleRequest({
      type: 'finish',
      requestId: 'finish',
      sessionId: 'session-1',
    });
    assert.deepEqual(result, {
      ok: false,
      code: 'SAVE_FAILED',
      message: 'disk conflict',
    });
    assert.equal(
      host.controller.get('vault:notes/a.md')?.state.doc.toString(),
      'start\nagent',
    );
    host.dispose();
  });
});
