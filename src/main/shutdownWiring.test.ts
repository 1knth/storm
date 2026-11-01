import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('agent IPC remains active through before-quit and is removed at will-quit', () => {
  const mainPath = fileURLToPath(new URL('../main.ts', import.meta.url));
  const script = `
    import assert from 'node:assert/strict';
    import { EventEmitter } from 'node:events';
    import { mkdtempSync, rmSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import path from 'node:path';
    import { mock } from 'bun:test';

    const userData = mkdtempSync(path.join(tmpdir(), 'storm-shutdown-wiring-'));
    const app = new EventEmitter();
    app.setName = () => {};
    app.setPath = () => {};
    app.commandLine = { hasSwitch: () => false };
    app.getPath = (name) => name === 'userData' ? userData : tmpdir();
    app.whenReady = () => new Promise(() => {});
    app.quit = () => {};

    const ipcMain = new EventEmitter();
    const handlers = new Map();
    ipcMain.handle = (channel, handler) => handlers.set(channel, handler);
    ipcMain.removeHandler = (channel) => handlers.delete(channel);
    const contents = new EventEmitter();
    contents.isDestroyed = () => false;
    contents.send = () => {};
    const window = { webContents: contents, isDestroyed: () => false };
    const BrowserWindow = {
      getAllWindows: () => [window],
      getFocusedWindow: () => window,
      fromWebContents: () => window,
    };
    const electron = {
      app,
      ipcMain,
      BrowserWindow,
      dialog: {
        showMessageBox: async () => ({ response: 0 }),
        showErrorBox: () => {},
      },
      Menu: { buildFromTemplate: () => ({ getMenuItemById: () => null }) },
      MenuItem: class {},
      shell: { openExternal: async () => {}, openPath: async () => '', showItemInFolder: () => {}, trashItem: async () => {} },
    };
    mock.module('electron', () => electron);
    mock.module('electron-squirrel-startup', () => ({ default: false }));

    try {
      await import(${JSON.stringify(mainPath)});
      assert.equal(handlers.has('agent:request'), true, 'agent request handler is registered');
      const responseListenersBefore = ipcMain.listenerCount('agent:renderer-response');
      assert.ok(responseListenersBefore > 0, 'renderer response listener is registered');

      let quitPrevented = false;
      app.emit('before-quit', { preventDefault() { quitPrevented = true; } });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(quitPrevented, true, 'quit confirmation prevents the initial quit');
      assert.equal(handlers.has('agent:request'), true, 'agent request handler survives before-quit');
      assert.equal(
        ipcMain.listenerCount('agent:renderer-response'),
        responseListenersBefore,
        'renderer response listener survives before-quit',
      );

      app.emit('will-quit');
      assert.equal(handlers.has('agent:request'), false, 'agent request handler is removed at will-quit');
      assert.equal(
        ipcMain.listenerCount('agent:renderer-response'),
        0,
        'renderer response listener is removed at will-quit',
      );
    } finally {
      rmSync(userData, { recursive: true, force: true });
    }
  `;

  execFileSync(process.execPath, ['-e', script], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
    stdio: 'pipe',
  });
});
