import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { VaultService } from './vault/vaultService';

const vaultService = new VaultService();

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

const createWindow = () => {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
	transparent: true,
	backgroundColor: '#00000000',
	vibrancy: 'under-window',
	visualEffectState: 'active',
	frame: true,
	titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  // Open the DevTools.
  // mainWindow.webContents.openDevTools();
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
ipcMain.handle('vault:choose', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (result.canceled) return null;
  const selectedPath = result.filePaths[0] ?? null;
  vaultService.selectVault(selectedPath);
  return selectedPath;
});

ipcMain.handle('vault:list-notes', async () => vaultService.listNotes());

ipcMain.handle('vault:read-note', async (_event, relativePath: unknown) => vaultService.readNote(relativePath));

app.whenReady().then(() => {
  const menu = Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { label: 'Settings', accelerator: 'CommandOrControl+,', click: () => {
          const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
          window?.webContents.send('settings:open');
        } },
        { type: 'separator' },
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] },
  ]);
  app.applicationMenu = menu;
  createWindow();

  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit the app when its last window is closed on every platform.
app.on('window-all-closed', () => {
  app.quit();
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
