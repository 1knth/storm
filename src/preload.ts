import { contextBridge, ipcRenderer } from 'electron';
import type {
  NoteData,
  SaveNoteRequest,
  SaveNoteResult,
  VaultEntry,
} from './shared/types';

contextBridge.exposeInMainWorld('vault', {
  choose: (): Promise<string | null> => ipcRenderer.invoke('vault:choose'),
  listNotes: (): Promise<VaultEntry[]> =>
    ipcRenderer.invoke('vault:list-notes'),
  readNote: (relativePath: string): Promise<NoteData> =>
    ipcRenderer.invoke('vault:read-note', relativePath),
  saveNote: (request: SaveNoteRequest): Promise<SaveNoteResult> =>
    ipcRenderer.invoke('vault:save-note', request),
  onSettingsOpen: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on('settings:open', listener);
    return () => ipcRenderer.removeListener('settings:open', listener);
  },
  onShutdownFlush: (callback: (requestId: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, requestId: string) =>
      callback(requestId);
    ipcRenderer.on('shutdown:flush', listener);
    return () => ipcRenderer.removeListener('shutdown:flush', listener);
  },
  acknowledgeShutdownFlush: (
    requestId: string,
    succeeded: boolean,
  ): Promise<void> => ipcRenderer.invoke('shutdown:ack', requestId, succeeded),
});
