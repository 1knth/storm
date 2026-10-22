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
  const event: AgentIpcEvent = {
    sender: window.webContents,
    senderFrame: { url: 'http://localhost:5173/' },
  };
  handlers.get('agent:renderer-ready')!(event);
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

test('renderer lifecycle fences navigation, crashes, destruction, and untrusted readiness', async () => {
  const ipcHandlers = new Map<string, (...args: any[]) => void>();
  const lifecycle = new Map<string, (...args: any[]) => void>();
  const removedLifecycle: string[] = [];
  const sent: string[] = [];
  const webContents = {
    id: 11,
    isDestroyed: () => false,
    send: (channel: string) => sent.push(channel),
    on: (name: string, listener: (...args: any[]) => void) =>
      lifecycle.set(name, listener),
    removeListener: (name: string) => removedLifecycle.push(name),
  };
  const window = { isDestroyed: () => false, webContents };
  const states: boolean[] = [];
  const ipc = {
    on: (channel: string, listener: (...args: any[]) => void) =>
      ipcHandlers.set(channel, listener),
    removeListener: (channel: string) => ipcHandlers.delete(channel),
    handle: () => undefined,
    removeHandler: () => undefined,
  };
  const transport = registerAgentIpc(
    ipc,
    () => window,
    () => undefined,
    () => 'http://localhost:5173/',
    (ready) => states.push(ready),
  );
  const request: AgentRendererRequest = {
    type: 'snapshot',
    requestId: 'reload',
    sessionId: 's',
    absolutePath: '/vault/a.md',
    vaultId: 'v',
    vaultRoot: '/vault',
  };
  const ready = (
    senderFrame: AgentIpcEvent['senderFrame'] = {
      url: 'http://localhost:5173/',
    },
  ) =>
    ipcHandlers.get('agent:renderer-ready')!({
      sender: webContents,
      senderFrame,
    });

  ready({ url: 'http://localhost:5173/', parent: {} });
  ready({ url: 'http://evil/' });
  ipcHandlers.get('agent:renderer-ready')!({
    sender: { ...webContents, id: 12 },
    senderFrame: { url: 'http://localhost:5173/' },
  });
  assert.deepEqual(states, []);
  assert.equal((await transport.dispatch(request)).ok, false);

  ready();
  assert.deepEqual(states, [true]);
  const navigationRequest = transport.dispatch({
    ...request,
    requestId: 'navigation',
  });
  lifecycle.get('did-start-navigation')!(
    {},
    'http://localhost:5173/',
    true,
    true,
  );
  const navigationResult = await navigationRequest;
  assert.equal(navigationResult.ok, false);
  if (!navigationResult.ok)
    assert.equal(navigationResult.code, 'RENDERER_UNAVAILABLE');
  assert.deepEqual(states, [true, false]);
  assert.equal(sent.length, 1);
  // Same-document navigation does not tear down the renderer; process loss does.
  ready();
  lifecycle.get('did-start-navigation')!(
    {},
    'http://localhost:5173/#section',
    true,
    false,
  );
  assert.deepEqual(states, [true, false, true]);
  const crashRequest = transport.dispatch({ ...request, requestId: 'crash' });
  lifecycle.get('render-process-gone')!();
  const crashResult = await crashRequest;
  assert.equal(crashResult.ok, false);
  if (!crashResult.ok) assert.equal(crashResult.code, 'RENDERER_UNAVAILABLE');
  assert.deepEqual(states, [true, false, true, false]);

  ready();
  const destroyedRequest = transport.dispatch({
    ...request,
    requestId: 'destroyed',
  });
  lifecycle.get('destroyed')!();
  const destroyedResult = await destroyedRequest;
  assert.equal(destroyedResult.ok, false);
  if (!destroyedResult.ok)
    assert.equal(destroyedResult.code, 'RENDERER_UNAVAILABLE');
  assert.deepEqual(states, [true, false, true, false, true, false]);
  transport.dispose?.();
  assert.deepEqual(removedLifecycle, [
    'did-start-navigation',
    'render-process-gone',
    'destroyed',
  ]);
  assert.equal(ipcHandlers.size, 0);
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
