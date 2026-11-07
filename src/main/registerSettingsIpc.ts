import {
  app,
  BrowserWindow,
  dialog,
  MenuItem,
  shell,
  type Menu,
  type IpcMain,
} from 'electron';
import path from 'node:path';
import {
  installCliShortcut,
  isCliShortcutInstalled,
  removeCliShortcut,
  readCliSetupState,
  recordCliChoice,
} from './cliSetup';
export function registerSettingsIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  menu: Menu,
): void {
  ipcMain.handle(
    'cli:available',
    () => process.platform === 'darwin' && app.isPackaged,
  );
  ipcMain.handle('cli:installed', () =>
    isCliShortcutInstalled(process.resourcesPath),
  );
  ipcMain.handle(
    'settings:canOpenFilesAndFolders',
    () => process.platform === 'darwin',
  );
  ipcMain.handle('settings:openFilesAndFolders', async () => {
    if (process.platform !== 'darwin') return false;
    await shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders',
    );
    return true;
  });
  ipcMain.handle('cli:disable', async () => {
    const result = await removeCliShortcut(process.resourcesPath);
    if (!result.removed && result.message) {
      await dialog.showMessageBox({
        type: 'warning',
        buttons: ['OK'],
        message: 'Could not disable the Storm CLI shortcut',
        detail: result.message,
      });
    }
    return result.removed;
  });
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
  if (process.platform === 'darwin' && app.isPackaged) {
    ipcMain.handle('cli:enable', () => enableCli(true));
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
}
