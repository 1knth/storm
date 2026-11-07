import { shell, type BrowserWindow } from 'electron';
import { isAcceptedUrl } from './rendererSecurity';
export function configureWindowSecurity(
  mainWindow: BrowserWindow,
  acceptedUrl: () => string | undefined,
): void {
  const contents = mainWindow.webContents;
  const guardNavigation = (event: Electron.Event, url: string) => {
    if (!acceptedUrl() || !isAcceptedUrl(url, acceptedUrl()!))
      event.preventDefault();
  };
  contents.on('will-navigate', guardNavigation);
  contents.on('will-frame-navigate', (event) => {
    if (
      !event.isMainFrame ||
      !acceptedUrl() ||
      !isAcceptedUrl(event.url, acceptedUrl()!)
    )
      event.preventDefault();
  });
  contents.on('will-redirect', guardNavigation);
  contents.on('will-attach-webview', (event) => event.preventDefault());
  const allowClipboardWrite = (
    requester: Electron.WebContents | null,
    permission: string,
    details: { isMainFrame: boolean; requestingUrl?: string },
  ) =>
    requester === contents &&
    permission === 'clipboard-sanitized-write' &&
    details.isMainFrame &&
    !!details.requestingUrl &&
    !!acceptedUrl() &&
    isAcceptedUrl(details.requestingUrl, acceptedUrl()!);
  contents.session.setPermissionRequestHandler(
    (requester, permission, callback, details) =>
      callback(allowClipboardWrite(requester, permission, details)),
  );
  contents.session.setPermissionCheckHandler(
    (requester, permission, _origin, details) =>
      allowClipboardWrite(requester, permission, details),
  );

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        void shell.openExternal(parsed.href).catch((error) => {
          console.error('Failed to open external link', error);
        });
      }
    } catch {
      // Reject malformed URLs and unsupported schemes.
    }
    return { action: 'deny' };
  });
}
