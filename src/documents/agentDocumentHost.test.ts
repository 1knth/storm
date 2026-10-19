import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { createAgentDocumentHost } from './agentDocumentHost';

describe('agent document host', () => {
  function makeHost(saveNote = async () => ({ revision: 'r2' })) {
    const published: string[] = [];
    const statuses: string[] = [];
    const host = createAgentDocumentHost({
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
      publishStatus: (event) => statuses.push(event.session.state),
      saveNote,
      getAdapterFor: () => undefined,
    });
    return { host, published, statuses };
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
