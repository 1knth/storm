import { contextBridge, ipcRenderer } from 'electron';
import type { NoteData, VaultEntry } from './shared/types';

contextBridge.exposeInMainWorld('vault', {
  choose: (): Promise<string | null> => ipcRenderer.invoke('vault:choose'),
  listNotes: (): Promise<VaultEntry[]> => ipcRenderer.invoke('vault:list-notes'),
  readNote: (relativePath: string): Promise<NoteData> => ipcRenderer.invoke('vault:read-note', relativePath),
  onSettingsOpen: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on('settings:open', listener);
    return () => ipcRenderer.removeListener('settings:open', listener);
  },
});
