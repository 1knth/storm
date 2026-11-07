import { BrowserWindow, dialog, type IpcMain } from 'electron';
export function registerShutdownTracking(
  ipcMain: Pick<IpcMain, 'handle'>,
): () => Promise<boolean> {
  let shutdownInFlight: Promise<boolean> | null = null;
  const shutdownAcks = new Map<string, (succeeded: boolean) => void>();
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

  return flushBeforeQuit;
}
