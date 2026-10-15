import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('vault', {
  choose: (): Promise<string | null> => ipcRenderer.invoke('vault:choose'),
});
