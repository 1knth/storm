import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  MenuItem,
  shell,
} from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import started from 'electron-squirrel-startup';
import { VaultService } from './vault/vaultService';
import { readLastVault } from './vault/vaultPreferences';
import { VaultRegistry } from './vault/vaultRegistry';

app.setName('Storm');
// Keep the pre-branding lowercase data directory so existing vault settings survive.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', path.join(app.getPath('appData'), 'storm'));
}
import { readVaultAsset, readVaultImage } from './vault/vaultAssets';
import { savePastedImage } from './vault/pasteImage';
import { VaultWriteBarrier } from './vault/writeBarrier';
import { resolveVaultNote } from './vault/vaultNoteResolver';
import { createFolder, createMarkdownNote } from './vault/vaultCreation';
import {
  assertDeletionTargetUnchanged,
  resolveDeletionTarget,
} from './vault/vaultDeletion';
import { confirmQuitAndFlush } from './quitConfirmation';
import { VaultWatcher } from './vault/vaultWatcher';
import { registerVaultRegistryIpc } from './main/registerVaultRegistryIpc';
import { AgentBroker } from './main/agentBroker';
import { runVaultLifecycleExclusive } from './main/vaultLifecycle';
import { bindAgentBrokerIpc, registerAgentIpc } from './main/registerAgentIpc';
import { resolveAgentNoteTarget } from './vault/agentNoteTarget';
import {
  startAgentEndpoint,
  type StartedAgentEndpoint,
} from './main/agentEndpoint';
import {
  installCliShortcut,
  readCliSetupState,
  recordCliChoice,
} from './main/cliSetup';

const vaultService = new VaultService();
const vaultRegistry = new VaultRegistry(app.getPath('userData'));
let shutdownAllowed = false;
let quitConfirmationInFlight = false;
let shutdownInFlight: Promise<boolean> | null = null;
const vaultWriteBarrier = new VaultWriteBarrier();
let activeWatchedVaultId: string | null = null;
const agentVaults = new Map<
  string,
  { service: VaultService; barrier: VaultWriteBarrier; vaultId: string }
>();
const vaultWatcher = new VaultWatcher((vaultId, revision) => {
  const window = BrowserWindow.getAllWindows().find(
    (candidate) => !candidate.isDestroyed(),
  );
  if (window && !window.webContents.isDestroyed())
    window.webContents.send('vault:changed', { vaultId, revision });
});
async function watchSelectedVault(): Promise<string | null> {
  const selectedPath = vaultService.getSelectedVaultPath();
  if (!selectedPath) {
    vaultWatcher.stop();
    activeWatchedVaultId = null;
    return null;
  }
  const { vault } = await vaultRegistry.add(selectedPath);
  await vaultRegistry.setActive(vault.id);
  if (activeWatchedVaultId !== vault.id) {
    activeWatchedVaultId = vault.id;
    vaultWatcher.start(selectedPath, vault.id);
  }
  return vault.id;
}
function invalidateSelectedVault(vaultId: string): void {
  if (vaultId === activeWatchedVaultId) vaultWatcher.invalidate(vaultId);
}
let agentWindow: BrowserWindow | undefined;
let agentAcceptedUrl: string | undefined;
const agentTransport = registerAgentIpc(
  ipcMain,
  () => agentWindow,
  () => undefined,
  () => agentAcceptedUrl,
);
const agentBroker = new AgentBroker({
  resolveTarget: async (notePath) => {
    const { vaults } = await vaultRegistry.list();
    return resolveAgentNoteTarget(notePath, vaults);
  },
  assertTargetRegistered: async (target) => {
    const { vaults } = await vaultRegistry.list();
    if (
      !vaults.some(
        (vault) =>
          vault.path === target.vaultRoot && vault.id === target.vaultId,
      )
    )
      throw new Error('Vault is not registered');
  },
  withVaultLifecycle: runVaultLifecycleExclusive,
  renderer: agentTransport,
});
const removeAgentBrokerIpc = bindAgentBrokerIpc(
  ipcMain,
  agentBroker,
  () => agentWindow,
  () => agentAcceptedUrl,
);
app.on('before-quit', () => removeAgentBrokerIpc());
ipcMain.handle('agent:save-note', async (_event, request: unknown) => {
  if (!request || typeof request !== 'object' || Array.isArray(request))
    throw new Error('Invalid save request');
  const value = request as Record<string, unknown>;
  if (
    typeof value.vaultPath !== 'string' ||
    typeof value.path !== 'string' ||
    typeof value.content !== 'string' ||
    typeof value.revision !== 'string'
  )
    throw new Error('Invalid save request');
  const root = await realpath(value.vaultPath);
  const { vaults } = await vaultRegistry.list();
  const vault = vaults.find((entry) => entry.path === root);
  if (!vault) throw new Error('Vault is not registered');
  let owned = agentVaults.get(root);
  if (!owned) {
    const service = new VaultService();
    await service.selectVault(root);
    owned = { service, barrier: new VaultWriteBarrier(), vaultId: vault.id };
    agentVaults.set(root, owned);
  }
  const result = await owned.barrier.run(() =>
    owned!.service.saveNote({ ...value, vaultPath: root }),
  );
  invalidateSelectedVault(owned.vaultId);
  return result;
});

const closeAllowed = new WeakSet<BrowserWindow>();
const shutdownAcks = new Map<string, (succeeded: boolean) => void>();
let openFileMenuItem: Electron.MenuItem | null = null;
let toggleExplorerMenuItem: Electron.MenuItem | null = null;
const sendIndexedShortcut = (
  channel: 'tabs:select-index' | 'vaults:activate-index',
  index: number,
) => {
  BrowserWindow.getFocusedWindow()?.webContents.send(channel, index);
};

ipcMain.on(
  'shortcut:set-enabled',
  (_event, shortcut: unknown, enabled: unknown) => {
    if (typeof enabled !== 'boolean') return;
    if (shortcut === 'openFile' && openFileMenuItem)
      openFileMenuItem.enabled = enabled;
    if (shortcut === 'toggleExplorer' && toggleExplorerMenuItem)
      toggleExplorerMenuItem.enabled = enabled;
  },
);

ipcMain.handle(
  'shutdown:ack',
  (_event, requestId: unknown, succeeded: unknown) => {
    if (typeof requestId === 'string')
      shutdownAcks.get(requestId)?.(succeeded === true);
  },
);

async function flushBeforeQuit(): Promise<boolean> {
  if (shutdownInFlight) return shutdownInFlight;
  shutdownInFlight = (async () => {
    const windows = BrowserWindow.getAllWindows();
    const outcomes = await Promise.all(
      windows.map(
        (window) =>
          new Promise<boolean>((resolve) => {
            const requestId = `${Date.now()}-${Math.random()}`;
            const timeout = setTimeout(() => {
              shutdownAcks.delete(requestId);
              resolve(false);
            }, 5000);
            shutdownAcks.set(requestId, (succeeded) => {
              clearTimeout(timeout);
              shutdownAcks.delete(requestId);
              resolve(succeeded);
            });
            window.webContents.send('shutdown:flush', requestId);
          }),
      ),
    );
    if (outcomes.every(Boolean)) return true;
    const choice = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Keep editing', 'Discard changes and quit'],
      defaultId: 0,
      cancelId: 0,
      message: 'Some changes could not be saved.',
      detail:
        'Keep editing to return to your notes, or explicitly discard changes and quit.',
      noLink: true,
    });
    return choice.response === 1;
  })().finally(() => {
    shutdownInFlight = null;
  });
  return shutdownInFlight;
}

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

const createWindow = () => {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    // Keep the native macOS titlebar and traffic lights; a transparent window can
    // suppress the standard titlebar, so translucency comes from vibrancy instead.
    vibrancy: 'hud',
    visualEffectState: 'active',
    frame: true,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  agentWindow = mainWindow;
  mainWindow.on('closed', () => {
    if (agentWindow === mainWindow) agentWindow = undefined;
    vaultWatcher.stop();
    activeWatchedVaultId = null;
  });

  mainWindow.on('close', (event) => {
    if (shutdownAllowed || closeAllowed.has(mainWindow)) return;
    event.preventDefault();
    void flushBeforeQuit().then((proceed) => {
      if (proceed && !mainWindow.isDestroyed()) {
        closeAllowed.add(mainWindow);
        mainWindow.close();
      }
    });
  });

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    agentAcceptedUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL;
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    const htmlPath = path.join(
      __dirname,
      `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`,
    );
    agentAcceptedUrl = pathToFileURL(htmlPath).href;
    mainWindow.loadFile(htmlPath);
  }

  // Open the DevTools.
  // mainWindow.webContents.openDevTools();
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
ipcMain.handle('vault:restore', async () => {
  try {
    const savedPath = await readLastVault(app.getPath('userData'));
    if (!savedPath) return { path: null, error: null };
    await vaultService.selectVault(savedPath);
    await watchSelectedVault();
    return { path: vaultService.getSelectedVaultPath(), error: null };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { path: null, error: null };
    }
    return {
      path: null,
      error: `Could not restore the last vault: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
});

ipcMain.handle('vault:choose', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (result.canceled) return { path: null, warning: null };
  const selectedPath = result.filePaths[0];
  if (!selectedPath) return { path: null, warning: null };
  await vaultService.selectVault(selectedPath);
  const validatedPath = vaultService.getSelectedVaultPath()!;
  try {
    await watchSelectedVault();
    return { path: validatedPath, warning: null };
  } catch (error) {
    return {
      path: validatedPath,
      warning: `Vault opened, but the vault selection could not be saved: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
});

const pendingGroupFolders = new Map<
  string,
  { directory: string; createdAt: number }
>();
const groupFolderCreatesInFlight = new Set<string>();
const GROUP_FOLDER_SELECTION_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_GROUP_FOLDERS = 20;
ipcMain.handle('vault:group-folder-choose', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  const selectionId = randomUUID();
  const now = Date.now();
  for (const [id, selection] of pendingGroupFolders) {
    if (now - selection.createdAt > GROUP_FOLDER_SELECTION_TTL_MS)
      pendingGroupFolders.delete(id);
  }
  while (pendingGroupFolders.size >= MAX_PENDING_GROUP_FOLDERS) {
    const oldestId = pendingGroupFolders.keys().next().value;
    if (!oldestId) break;
    pendingGroupFolders.delete(oldestId);
  }
  pendingGroupFolders.set(selectionId, {
    directory: result.filePaths[0],
    createdAt: now,
  });
  return { selectionId, name: path.basename(result.filePaths[0]) };
});
ipcMain.handle(
  'vault:group-create-from-folder',
  async (_event, selectionId: unknown, name: unknown) => {
    if (typeof selectionId !== 'string' || typeof name !== 'string')
      throw new Error('Invalid folder-based group request');
    const selection = pendingGroupFolders.get(selectionId);
    if (
      !selection ||
      Date.now() - selection.createdAt > GROUP_FOLDER_SELECTION_TTL_MS
    ) {
      pendingGroupFolders.delete(selectionId);
      throw new Error('Folder selection expired; please choose it again');
    }
    if (groupFolderCreatesInFlight.has(selectionId))
      throw new Error('Folder-based group creation is already in progress');
    groupFolderCreatesInFlight.add(selectionId);
    try {
      const result = await vaultRegistry.createGroupFromFolder(
        selection.directory,
        name,
      );
      pendingGroupFolders.delete(selectionId);
      return result;
    } finally {
      groupFolderCreatesInFlight.delete(selectionId);
    }
  },
);

registerVaultRegistryIpc(ipcMain, {
  registry: vaultRegistry,
  service: vaultService,
  writeBarrier: vaultWriteBarrier,
  watchSelectedVault,
  stopWatcher: () => vaultWatcher.stop(),
  clearWatchedVaultId: () => {
    activeWatchedVaultId = null;
  },
  hasWritableAgentSession: (vaultId) =>
    agentBroker.hasWritableSessionForVault(vaultId),
  withVaultLifecycle: runVaultLifecycleExclusive,
});

ipcMain.handle('vault:resolve-note-link', async (_event, request: unknown) => {
  if (!request || typeof request !== 'object' || Array.isArray(request))
    return { ok: false, reason: 'invalid' as const };
  const { vaultId, notePath, target } = request as Record<string, unknown>;
  if (
    typeof vaultId !== 'string' ||
    typeof notePath !== 'string' ||
    typeof target !== 'string'
  )
    return { ok: false, reason: 'invalid' as const };
  const vault = await vaultRegistry.getById(vaultId);
  if (!vault) return { ok: false, reason: 'invalid' as const };
  try {
    const path = await resolveVaultNote(vault.path, notePath, target);
    return { ok: true, path };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const reason = /ambiguous/i.test(message)
      ? 'ambiguous'
      : /not found/i.test(message)
        ? 'missing'
        : 'invalid';
    return { ok: false, reason };
  }
});

ipcMain.handle('vault:paste-image', async (_event, request: unknown) => {
  if (!request || typeof request !== 'object' || Array.isArray(request))
    throw new Error('Invalid paste image request');
  const value = request as Record<string, unknown>;
  if (
    typeof value.vaultId !== 'string' ||
    typeof value.notePath !== 'string' ||
    typeof value.mimeType !== 'string' ||
    typeof value.base64 !== 'string'
  )
    throw new Error('Invalid paste image request');
  const { vaultId, notePath, mimeType, base64 } = value as {
    vaultId: string;
    notePath: string;
    mimeType: string;
    base64: string;
  };
  return vaultWriteBarrier.run(async () => {
    const vault = await vaultRegistry.getById(vaultId);
    if (!vault) throw new Error('Unknown vault');
    const result = await savePastedImage(vault.path, {
      vaultId,
      notePath,
      mimeType,
      base64,
    });
    invalidateSelectedVault(vaultId);
    return result;
  });
});

ipcMain.handle('vault:read-asset', async (_event, request: unknown) => {
  if (!request || typeof request !== 'object' || Array.isArray(request))
    throw new Error('Invalid asset request');
  const { vaultId, relativePath } = request as Record<string, unknown>;
  if (typeof vaultId !== 'string' || typeof relativePath !== 'string')
    throw new Error('Invalid asset request');
  const vault = await vaultRegistry.getById(vaultId);
  if (!vault) throw new Error('Unknown vault');
  try {
    return { ok: true, ...(await readVaultAsset(vault.path, relativePath)) };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const reason = /not found|ENOENT/i.test(message)
      ? 'not-found'
      : /unsupported|content does not match/i.test(message)
        ? 'unsupported'
        : 'unavailable';
    return { ok: false, reason };
  }
});

ipcMain.handle('vault:read-image', async (_event, request: unknown) => {
  if (!request || typeof request !== 'object')
    throw new Error('Invalid image request');
  const { vaultId, notePath, imagePath, kind } = request as Record<
    string,
    unknown
  >;
  if (typeof vaultId !== 'string') throw new Error('Invalid vault ID');
  const vault = await vaultRegistry.getById(vaultId);
  if (!vault) throw new Error('Unknown vault');
  if (typeof notePath !== 'string' || typeof imagePath !== 'string')
    throw new Error('Invalid image request');
  try {
    const image = await readVaultImage(vault.path, {
      notePath,
      imagePath,
      kind: kind as 'markdown' | 'wiki' | undefined,
    });
    return { ok: true, ...image };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const reason = /not found/i.test(message)
      ? 'not-found'
      : /ambiguous/i.test(message)
        ? 'ambiguous'
        : /unsupported|content does not match/i.test(message)
          ? 'unsupported'
          : 'unavailable';
    return { ok: false, reason };
  }
});

ipcMain.handle('vault:create-note', async (_event, request: unknown) => {
  if (!request || typeof request !== 'object' || Array.isArray(request))
    throw new Error('Invalid creation request');
  const { vaultId, parentRelativePath, name } = request as Record<
    string,
    unknown
  >;
  if (
    typeof vaultId !== 'string' ||
    typeof parentRelativePath !== 'string' ||
    typeof name !== 'string'
  )
    throw new Error('Invalid creation request');
  const vault = await vaultRegistry.getById(vaultId);
  if (!vault) throw new Error('Unknown vault');
  const entry = await createMarkdownNote(vault.path, parentRelativePath, name);
  invalidateSelectedVault(vaultId);
  return entry;
});
ipcMain.handle('vault:create-folder', async (_event, request: unknown) => {
  if (!request || typeof request !== 'object' || Array.isArray(request))
    throw new Error('Invalid creation request');
  const { vaultId, parentRelativePath, name } = request as Record<
    string,
    unknown
  >;
  if (
    typeof vaultId !== 'string' ||
    typeof parentRelativePath !== 'string' ||
    typeof name !== 'string'
  )
    throw new Error('Invalid creation request');
  const vault = await vaultRegistry.getById(vaultId);
  if (!vault) throw new Error('Unknown vault');
  const entry = await createFolder(vault.path, parentRelativePath, name);
  invalidateSelectedVault(vaultId);
  return entry;
});

ipcMain.handle('vault:delete-entry', async (event, request: unknown) => {
  if (!request || typeof request !== 'object' || Array.isArray(request))
    throw new Error('Invalid deletion request');
  const { vaultId, path: relativePath } = request as Record<string, unknown>;
  if (typeof vaultId !== 'string' || typeof relativePath !== 'string')
    throw new Error('Invalid deletion request');
  const vault = await vaultRegistry.getById(vaultId);
  if (!vault) throw new Error('Unknown vault');
  const target = await resolveDeletionTarget(vault.path, relativePath);
  const window = BrowserWindow.fromWebContents(event.sender);
  const description =
    target.kind === 'folder'
      ? 'Folder.'
      : target.kind === 'image'
        ? 'Image.'
        : 'Markdown note.';
  const contains =
    target.kind === 'folder' ? ' Its entire contents will be moved.' : '';
  const choice = await dialog.showMessageBox(
    window ?? BrowserWindow.getFocusedWindow()!,
    {
      type: 'warning',
      buttons: ['Cancel', 'Move to Trash'],
      defaultId: 0,
      cancelId: 0,
      message: `Move “${target.relativePath}” to Trash?`,
      detail: `${description}${contains}`,
      noLink: true,
    },
  );
  if (choice.response !== 1)
    return { deleted: false, path: target.relativePath, kind: target.kind };
  await assertDeletionTargetUnchanged(target);
  await shell.trashItem(target.absolutePath);
  invalidateSelectedVault(vaultId);
  return { deleted: true, path: target.relativePath, kind: target.kind };
});

ipcMain.handle('vault:list-notes', async () => vaultService.listNotes());

ipcMain.handle('vault:read-note', async (_event, relativePath: unknown) =>
  vaultService.readNote(relativePath),
);
ipcMain.handle('vault:save-note', async (_event, request: unknown) =>
  vaultWriteBarrier.run(async () => {
    const result = await vaultService.saveNote(request);
    if (request && typeof request === 'object') {
      const value = request as Record<string, unknown>;
      if (
        typeof value.vaultPath === 'string' &&
        typeof value.path === 'string'
      ) {
        const { vaults } = await vaultRegistry.list();
        const vaultId = vaults.find(
          (vault) => vault.path === value.vaultPath,
        )?.id;
        if (vaultId) invalidateSelectedVault(vaultId);
      }
    }
    return result;
  }),
);

let agentEndpoint: StartedAgentEndpoint | undefined;
app.whenReady().then(async () => {
  agentEndpoint = await startAgentEndpoint({
    broker: agentBroker,
    userDataPath: app.getPath('userData'),
  });
  const menu = Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        {
          label: 'Settings',
          accelerator: 'CommandOrControl+,',
          click: () => {
            const window =
              BrowserWindow.getFocusedWindow() ??
              BrowserWindow.getAllWindows()[0];
            window?.webContents.send('settings:open');
          },
        },
        {
          label: 'New Note',
          accelerator: 'CommandOrControl+N',
          click: () =>
            BrowserWindow.getFocusedWindow()?.webContents.send(
              'entry:create',
              'note',
            ),
        },
        {
          label: 'New Folder',
          accelerator: 'CommandOrControl+Shift+N',
          click: () =>
            BrowserWindow.getFocusedWindow()?.webContents.send(
              'entry:create',
              'folder',
            ),
        },
        {
          label: 'Close Tab',
          accelerator: undefined,
          click: () =>
            BrowserWindow.getFocusedWindow()?.webContents.send(
              'tabs:close-active',
            ),
        },
        {
          label: 'New Tab',
          accelerator: 'CommandOrControl+T',
          click: () => {
            BrowserWindow.getFocusedWindow()?.webContents.send('tabs:new');
          },
        },
        {
          id: 'open-file-shortcut',
          label: 'Open File…',
          accelerator: 'CommandOrControl+P',
          click: () => {
            const window =
              BrowserWindow.getFocusedWindow() ??
              BrowserWindow.getAllWindows()[0];
            window?.webContents.send('file:open');
          },
        },
        {
          label: 'Toggle Reading Mode',
          accelerator: 'CommandOrControl+E',
          click: () => {
            BrowserWindow.getFocusedWindow()?.webContents.send(
              'reading-mode:toggle',
            );
          },
        },
        {
          label: 'Toggle Markdown Preview',
          accelerator: 'CommandOrControl+Shift+M',
          click: () => {
            const window =
              BrowserWindow.getFocusedWindow() ??
              BrowserWindow.getAllWindows()[0];
            window?.webContents.send('preview:toggle');
          },
        },
        {
          id: 'toggle-explorer-shortcut',
          label: 'Toggle File Explorer',
          accelerator: 'CommandOrControl+S',
          click: () => {
            const window =
              BrowserWindow.getFocusedWindow() ??
              BrowserWindow.getAllWindows()[0];
            window?.webContents.send('explorer:toggle');
          },
        },
        { type: 'separator' },
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        {
          label: 'Quit',
          accelerator: process.platform === 'darwin' ? 'Command+Q' : undefined,
          click: () => app.quit(),
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Bold',
          accelerator: 'CommandOrControl+B',
          click: () =>
            BrowserWindow.getFocusedWindow()?.webContents.send(
              'editor:format',
              'bold',
            ),
        },
        {
          label: 'Italic',
          accelerator: 'CommandOrControl+I',
          click: () =>
            BrowserWindow.getFocusedWindow()?.webContents.send(
              'editor:format',
              'italic',
            ),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        ...(['Vaults', 'File Explorer', 'Editor'] as const).map(
          (label, index) => ({
            label: `Focus ${label}`,
            accelerator:
              process.platform === 'darwin'
                ? `Control+${index + 1}`
                : `Alt+${index + 1}`,
            click: () =>
              BrowserWindow.getFocusedWindow()?.webContents.send(
                'pane:focus',
                ['vaults', 'explorer', 'editor'][index],
              ),
          }),
        ),
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Tabs',
      submenu: [
        {
          label: 'Restore Saved Tabs',
          accelerator: 'CommandOrControl+Shift+T',
          click: () =>
            BrowserWindow.getFocusedWindow()?.webContents.send(
              'tabs:restore-saved',
            ),
        },
        { type: 'separator' },
        ...Array.from({ length: 9 }, (_, index) => ({
          label: `Select Tab ${index + 1}`,
          accelerator: `CommandOrControl+${index + 1}`,
          click: () => sendIndexedShortcut('tabs:select-index', index),
        })),
      ],
    },
    {
      label: 'Vaults',
      submenu: Array.from({ length: 9 }, (_, index) => ({
        label: `Activate Vault ${index + 1}`,
        accelerator: `Control+Shift+${index + 1}`,
        click: () => sendIndexedShortcut('vaults:activate-index', index),
      })),
    },
    {
      role: 'window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ]);
  if (process.platform === 'darwin' && app.isPackaged) {
    const enableCli = async (interactive: boolean) => {
      let result: { installed: boolean; message?: string };
      try {
        result = await installCliShortcut({
          resourcesPath: process.resourcesPath,
        });
      } catch (error) {
        result = {
          installed: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      await recordCliChoice(
        app.getPath('userData'),
        result.installed ? 'enabled' : 'failed',
      );
      if (interactive && result.message) {
        await dialog.showMessageBox({
          type: 'warning',
          buttons: ['OK'],
          message: 'Could not enable the Storm CLI shortcut',
          detail: result.message,
        });
      }
      return result.installed;
    };
    const appMenu = menu.items[0]?.submenu;
    appMenu?.append(
      new MenuItem({
        label: 'Enable CLI…',
        click: () => {
          void enableCli(true).catch((error: unknown) =>
            dialog.showErrorBox('Storm CLI setup failed', String(error)),
          );
        },
      }),
    );
    const firstWindow = BrowserWindow.getAllWindows()[0];
    if (firstWindow) {
      let promptStarted = false;
      firstWindow.webContents.once('did-finish-load', () => {
        if (promptStarted) return;
        promptStarted = true;
        setTimeout(() => {
          void (async () => {
            const state = await readCliSetupState(
              path.join(app.getPath('userData'), 'cli-setup.json'),
            );
            if (state) return;
            const choice = await dialog.showMessageBox(firstWindow, {
              type: 'question',
              buttons: ['Enable CLI', 'Not now'],
              defaultId: 0,
              cancelId: 1,
              message: 'Enable Storm CLI?',
              detail:
                'Create a terminal command shortcut for the CLI bundled with this app. Storm will not change your shell configuration. If administrator authorization is needed, macOS will ask after you choose Enable CLI.',
            });
            if (choice.response === 0) {
              const result = await enableCli(true);
              if (!result)
                await recordCliChoice(app.getPath('userData'), 'failed');
            } else await recordCliChoice(app.getPath('userData'), 'declined');
          })().catch((error: unknown) =>
            dialog.showErrorBox('Storm CLI setup failed', String(error)),
          );
        }, 0);
      });
    }
  }
  app.applicationMenu = menu;
  openFileMenuItem = menu.getMenuItemById('open-file-shortcut');
  toggleExplorerMenuItem = menu.getMenuItemById('toggle-explorer-shortcut');
  createWindow();

  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', (event) => {
  if (shutdownAllowed) {
    if (agentEndpoint) {
      const endpoint = agentEndpoint;
      agentEndpoint = undefined;
      void endpoint.close();
    }
    return;
  }
  // Closing the final window is already guarded by its close handler. Don't
  // show a second quit confirmation after that window has been destroyed.
  if (BrowserWindow.getAllWindows().length === 0) {
    shutdownAllowed = true;
    if (agentEndpoint) {
      const endpoint = agentEndpoint;
      agentEndpoint = undefined;
      void endpoint.close();
    }
    return;
  }
  event.preventDefault();
  if (quitConfirmationInFlight) return;
  quitConfirmationInFlight = true;
  void (async () => {
    try {
      const proceed = await confirmQuitAndFlush(async () => {
        const choice = await dialog.showMessageBox({
          ...(BrowserWindow.getFocusedWindow()
            ? { window: BrowserWindow.getFocusedWindow()! }
            : {}),
          type: 'question',
          buttons: ['Cancel', 'Quit'],
          defaultId: 0,
          cancelId: 0,
          message: 'Are you sure you want to quit Storm?',
          noLink: true,
        });
        return choice.response === 1;
      }, flushBeforeQuit);
      if (!proceed) return;
      shutdownAllowed = true;
      if (agentEndpoint) {
        const endpoint = agentEndpoint;
        agentEndpoint = undefined;
        await endpoint.close();
      }
      app.quit();
    } catch (error) {
      console.error('Unable to confirm or prepare application quit', error);
    } finally {
      quitConfirmationInFlight = false;
    }
  })();
});

// Quit the app when its last window is closed on every platform.
app.on('window-all-closed', () => {
  app.quit();
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
