import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bindAgentBrokerIpc,
  registerAgentIpc,
  type AgentIpcEvent,
} from './registerAgentIpc';
import type { AgentRendererRequest } from './agentBroker';

test('renderer dispatch accepts only trusted main-frame responses and cancellation', async () => {
  const handlers = new Map<string, (...args: any[]) => void>();
  const calls: unknown[] = [];
  const window = {
    isDestroyed: () => false,
    webContents: {
      id: 7,
      isDestroyed: () => false,
      send: (_channel: string, ...args: unknown[]) => calls.push(args[0]),
    },
  };
  const ipc = {
    on: (channel: string, listener: (...args: any[]) => void) =>
      handlers.set(channel, listener),
    handle: () => undefined,
    removeHandler: () => undefined,
  };
  const transport = registerAgentIpc(
    ipc,
    () => window,
    () => undefined,
    () => 'http://localhost:5173/',
  );
  const request: AgentRendererRequest = {
    type: 'snapshot',
    requestId: 'r1',
    sessionId: 's',
    absolutePath: '/vault/a.md',
    vaultId: 'v',
    vaultRoot: '/vault',
  };
  const result = transport.dispatch(request);
  const response = {
    ok: true,
    documentVersion: 0,
    diskRevision: 'rev',
    content: 'live',
  };
  const listener = handlers.get('agent:renderer-response')!;
  listener(
    {
      sender: { ...window.webContents, id: 99 },
      senderFrame: { url: 'http://localhost:5173/' },
    },
    'r1',
    response,
  );
  listener(
    { sender: window.webContents, senderFrame: { url: 'http://evil/' } },
    'r1',
    response,
  );
  assert.equal(calls.length, 1);
  listener(
    {
      sender: window.webContents,
      senderFrame: { url: 'http://localhost:5173/', parent: {} },
    },
    'r1',
    response,
  );
  listener(
    {
      sender: window.webContents,
      senderFrame: { url: 'http://localhost:5173/' },
    },
    'r1',
    response,
  );
  assert.deepEqual(await result, response);
  let cancelled = '';
  transport.onCancelled?.((id, reason) => {
    cancelled = `${id}:${reason}`;
  });
  const cancelListener = handlers.get('agent:renderer-cancel')!;
  cancelListener(
    {
      sender: { ...window.webContents, id: 99 },
      senderFrame: { url: 'http://localhost:5173/' },
    },
    's',
    'foreign',
  );
  assert.equal(cancelled, '');
  cancelListener(
    {
      sender: window.webContents,
      senderFrame: { url: 'http://localhost:5173/' },
    },
    's',
    'closed',
  );
  assert.equal(cancelled, 's:closed');
  const unavailable = registerAgentIpc(
    ipc,
    () => undefined,
    () => undefined,
    () => undefined,
  );
  assert.equal((await unavailable.dispatch(request)).ok, false);
});

test('broker invoke rejects foreign and stale-window senders', async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const ipc = {
    on: () => undefined,
    handle: (channel: string, listener: (...args: any[]) => unknown) =>
      handlers.set(channel, listener),
    removeHandler: () => undefined,
  };
  const webContents = {
    id: 3,
    isDestroyed: () => false,
    send: () => undefined,
  };
  let active = { isDestroyed: () => false, webContents };
  const broker = {
    handle: async () => {
      throw new Error('must not reach broker');
    },
  } as any;
  bindAgentBrokerIpc(
    ipc,
    broker,
    () => active,
    () => 'file:///app/index.html',
  );
  const invoke = handlers.get('agent:request')!;
  const foreign: AgentIpcEvent = {
    sender: { ...webContents, id: 4 },
    senderFrame: { url: 'file:///app/index.html' },
  };
  assert.equal(
    ((await invoke(foreign, {})) as any).error.code,
    'INVALID_REQUEST',
  );
  const valid: AgentIpcEvent = {
    sender: webContents,
    senderFrame: { url: 'file:///app/index.html' },
  };
  active = { isDestroyed: () => false, webContents: { ...webContents, id: 5 } };
  assert.equal(
    ((await invoke(valid, {})) as any).error.code,
    'INVALID_REQUEST',
  );
});
