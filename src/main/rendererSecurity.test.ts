import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAcceptedUrl,
  rendererAuthorizer,
  trustedIpc,
} from './rendererSecurity';
import type { IpcMain } from 'electron';

test('app URL matching rejects other file authorities and schemes', () => {
  assert.equal(
    isAcceptedUrl('file://server/app/index.html', 'file:///app/index.html'),
    false,
  );
  assert.equal(
    isAcceptedUrl('data:/app/index.html', 'file:///app/index.html'),
    false,
  );
  assert.equal(
    isAcceptedUrl(
      'https://app.test/index.html?changed',
      'https://app.test/index.html',
    ),
    false,
  );
});

test('renderer authorization binds the live window, main frame, and exact app page', () => {
  const frame = { url: 'file:///app/index.html#note' };
  const contents = { id: 1, mainFrame: frame, isDestroyed: () => false };
  const window = { webContents: contents, isDestroyed: () => false };
  const authorize = rendererAuthorizer(
    () => window,
    () => 'file:///app/index.html',
  );
  assert.equal(authorize({ sender: contents, senderFrame: frame }), true);
  assert.equal(
    authorize({ sender: { ...contents }, senderFrame: frame }),
    false,
  );
  assert.equal(
    authorize({ sender: contents, senderFrame: { ...frame } }),
    false,
  );
  frame.url = 'https://evil.test/index.html';
  assert.equal(authorize({ sender: contents, senderFrame: frame }), false);
  frame.url = 'file:///app/other.html';
  assert.equal(authorize({ sender: contents, senderFrame: frame }), false);
  frame.url = 'file:///app/index.html';
  contents.isDestroyed = () => true;
  assert.equal(authorize({ sender: contents, senderFrame: frame }), false);
});

test('privileged handlers reject untrusted calls before reading or mutating state', async () => {
  const handles = new Map<string, (...args: any[]) => any>();
  const listeners = new Map<string, (...args: any[]) => any>();
  let effects = 0;
  const native = {
    handle: (channel: string, callback: (...args: any[]) => any) =>
      handles.set(channel, callback),
    on: (channel: string, callback: (...args: any[]) => any) =>
      listeners.set(channel, callback),
  } as unknown as IpcMain;
  const event = {};
  const ipc = trustedIpc(native, (candidate) => candidate === event);
  ipc.handle('save', async (_event, value) => {
    effects++;
    return value;
  });
  ipc.on('shortcut', () => {
    effects++;
  });
  await assert.rejects(
    async () => handles.get('save')!({}, 'secret'),
    /Untrusted IPC sender/,
  );
  listeners.get('shortcut')!({});
  assert.equal(effects, 0);
  assert.equal(await handles.get('save')!(event, 'saved'), 'saved');
  listeners.get('shortcut')!(event);
  assert.equal(effects, 2);
});
