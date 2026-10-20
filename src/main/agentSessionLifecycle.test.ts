import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentDocumentController } from '../documents/agentDocumentController';
import { AgentBroker, type AgentRendererRequest } from './agentBroker';
import { EditorState } from '@codemirror/state';

const request = (type: string, values: object = {}) => ({
  protocol: 1,
  requestId: type,
  type,
  ...values,
});

describe('agent session finish lifecycle', () => {
  it('finishes a connect-only renderer document', () => {
    const controller = new AgentDocumentController();
    const document = controller.attach(
      'doc',
      '/vault',
      'note.md',
      EditorState.create(),
      'rev',
    );
    controller.finish(document);
    assert.equal(document.status, 'finished');
  });

  it('preserves renderer SESSION_CLOSED on append and reconciles broker status to failed', async () => {
    const broker = new AgentBroker({
      resolveTarget: async (absolutePath) => ({
        absolutePath,
        vaultId: 'v',
        vaultRoot: '/v',
        relativePath: 'note.md',
        content: '',
        diskRevision: 'rev',
      }),
      renderer: {
        dispatch: async (call) =>
          call.type === 'snapshot'
            ? { ok: true, content: '', documentVersion: 0, diskRevision: 'rev' }
            : {
                ok: false,
                code: 'SESSION_CLOSED',
                message: 'Session is not open',
              },
      },
    });
    const connected = (await broker.handle(
      request('connect', { absolutePath: '/v/note.md' }),
    )) as any;
    const sessionId = connected.session.sessionId;
    const append = (await broker.handle(
      request('append', {
        sessionId,
        operationId: 'op',
        sequence: 1,
        text: 'x',
      }),
    )) as any;
    assert.equal(append.error.code, 'SESSION_CLOSED');
    const status = (await broker.handle(
      request('status', { sessionId }),
    )) as any;
    assert.equal(status.sessions[0].state, 'failed');
    assert.equal(status.sessions[0].pendingOperations, 0);
    const finish = (await broker.handle(
      request('finish', { sessionId }),
    )) as any;
    assert.equal(finish.ok, false);
    assert.equal(finish.error.code, 'SESSION_CLOSED');
    assert.equal(finish.error.message, 'Session is failed');
    assert.deepEqual(
      ((await broker.handle(request('status', { sessionId }))) as any)
        .sessions[0],
      status.sessions[0],
    );
  });

  it('finishes a broker connect-only session and reports stable terminal status on repeat', async () => {
    const calls: AgentRendererRequest[] = [];
    const broker = new AgentBroker({
      resolveTarget: async (absolutePath) => ({
        absolutePath,
        vaultId: 'v',
        vaultRoot: '/v',
        relativePath: 'note.md',
        content: '',
        diskRevision: 'rev',
      }),
      renderer: {
        dispatch: async (call) => {
          calls.push(call);
          return call.type === 'snapshot'
            ? { ok: true, content: '', documentVersion: 0, diskRevision: 'rev' }
            : { ok: true, documentVersion: 0, diskRevision: 'rev' };
        },
      },
    });
    const connected = (await broker.handle(
      request('connect', { absolutePath: '/v/note.md' }),
    )) as any;
    const sessionId = connected.session.sessionId;
    assert.equal(
      ((await broker.handle(request('status'))) as any).sessions[0].state,
      'connected',
    );
    const finished = (await broker.handle(
      request('finish', { sessionId }),
    )) as any;
    assert.equal(finished.ok, true);
    assert.equal(finished.session.state, 'finished');
    const repeated = (await broker.handle(
      request('finish', { sessionId }),
    )) as any;
    assert.equal(repeated.ok, true);
    assert.equal(repeated.session.state, 'finished');
    assert.deepEqual(
      calls.map((call) => call.type),
      ['snapshot', 'finish'],
    );
  });
});
