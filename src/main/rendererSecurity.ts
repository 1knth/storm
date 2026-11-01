import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron';

type RendererEvent = {
  sender: { id: number };
  senderFrame?: { url: string; parent?: unknown } | null;
};
type RendererWindow = {
  isDestroyed(): boolean;
  webContents: {
    id: number;
    isDestroyed(): boolean;
    mainFrame?: unknown;
  };
};

export function isAcceptedUrl(actual: string, expected: string): boolean {
  try {
    const a = new URL(actual);
    const e = new URL(expected);
    return (
      a.protocol === e.protocol &&
      a.host === e.host &&
      a.username === e.username &&
      a.password === e.password &&
      a.origin === e.origin &&
      a.pathname === e.pathname &&
      a.search === e.search &&
      (!e.hash || a.hash === e.hash)
    );
  } catch {
    return false;
  }
}

export function rendererAuthorizer(
  getWindow: () => RendererWindow | undefined,
  getUrl: () => string | undefined,
) {
  return (event: RendererEvent): boolean => {
    const window = getWindow();
    const url = getUrl();
    const frame = event.senderFrame;
    return (
      !!window &&
      !window.isDestroyed() &&
      !window.webContents.isDestroyed() &&
      event.sender === window.webContents &&
      !!frame &&
      !frame.parent &&
      (!window.webContents.mainFrame ||
        frame === window.webContents.mainFrame) &&
      !!url &&
      isAcceptedUrl(frame.url, url)
    );
  };
}

/** Every application IPC handler crosses the same renderer/frame boundary. */
export function trustedIpc(
  ipc: Pick<IpcMain, 'handle' | 'on'>,
  authorize: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean,
) {
  return {
    handle(channel: string, listener: Parameters<IpcMain['handle']>[1]) {
      ipc.handle(channel, (event, ...args) => {
        if (!authorize(event)) throw new Error('Untrusted IPC sender');
        return listener(event, ...args);
      });
    },
    on(channel: string, listener: Parameters<IpcMain['on']>[1]) {
      ipc.on(channel, (event, ...args) => {
        if (authorize(event)) listener(event, ...args);
      });
    },
  };
}
