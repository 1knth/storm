import { contextBridge, ipcRenderer } from 'electron';
import type {
  NoteData,
  SaveNoteRequest,
  SaveNoteResult,
  VaultEntry,
  RegisteredVault,
  VaultImageRequest,
  VaultImageResult,
  CreateEntryRequest,
  VaultGroup,
  SavedTabLayout,
  DeleteEntryResult,
} from './shared/types';
import type { GroupColor } from './shared/groupColors';

contextBridge.exposeInMainWorld('vault', {
  registryList: (): Promise<{
    vaults: RegisteredVault[];
    activeVaultId: string | null;
  }> => ipcRenderer.invoke('vault:registry-list'),
  groupsList: (): Promise<VaultGroup[]> =>
    ipcRenderer.invoke('vault:groups-list'),
  saveTabLayout: (vaultId: string, layout: SavedTabLayout): Promise<void> =>
    ipcRenderer.invoke('vault:tab-layout-save', vaultId, layout),
  getTabLayout: (vaultId: string): Promise<SavedTabLayout | null> =>
    ipcRenderer.invoke('vault:tab-layout-get', vaultId),
  onRestoreTabs: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on('tabs:restore-saved', listener);
    return () => ipcRenderer.removeListener('tabs:restore-saved', listener);
  },
  groupFolderChoose: (): Promise<{
    selectionId: string;
    name: string;
  } | null> => ipcRenderer.invoke('vault:group-folder-choose'),
  groupCreateFromFolder: (
    selectionId: string,
    name: string,
  ): Promise<VaultGroup> =>
    ipcRenderer.invoke('vault:group-create-from-folder', selectionId, name),
  groupCreate: (name: string): Promise<VaultGroup> =>
    ipcRenderer.invoke('vault:group-create', name),
  groupRename: (id: string, name: string): Promise<VaultGroup> =>
    ipcRenderer.invoke('vault:group-rename', id, name),
  groupRemove: (id: string): Promise<void> =>
    ipcRenderer.invoke('vault:group-remove', id),
  groupSetVault: (vaultId: string, groupId: string | null): Promise<void> =>
    ipcRenderer.invoke('vault:group-set-vault', vaultId, groupId),
  groupSetCollapsed: (id: string, collapsed: boolean): Promise<void> =>
    ipcRenderer.invoke('vault:group-set-collapsed', id, collapsed),
  groupSetColor: (id: string, color: GroupColor): Promise<void> =>
    ipcRenderer.invoke('vault:group-set-color', id, color),
  registryAdd: (
    directory: string,
  ): Promise<{ vault: RegisteredVault; created: boolean }> =>
    ipcRenderer.invoke('vault:registry-add', directory),
  registryActivate: (
    id: string,
  ): Promise<{ id: string; path: string | null }> =>
    ipcRenderer.invoke('vault:registry-activate', id),
  registryRemove: (id: string): Promise<void> =>
    ipcRenderer.invoke('vault:registry-remove', id),
  choose: (): Promise<{ path: string | null; warning: string | null }> =>
    ipcRenderer.invoke('vault:choose'),
  restore: (): Promise<{ path: string | null; error: string | null }> =>
    ipcRenderer.invoke('vault:restore'),
  listNotes: (): Promise<VaultEntry[]> =>
    ipcRenderer.invoke('vault:list-notes'),
  createNote: (request: CreateEntryRequest): Promise<VaultEntry> =>
    ipcRenderer.invoke('vault:create-note', request),
  createFolder: (request: CreateEntryRequest): Promise<VaultEntry> =>
    ipcRenderer.invoke('vault:create-folder', request),
  deleteEntry: (request: {
    vaultId: string;
    path: string;
  }): Promise<DeleteEntryResult> =>
    ipcRenderer.invoke('vault:delete-entry', request),
  onCreateEntry: (
    callback: (kind: 'note' | 'folder') => void,
  ): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, kind: unknown) => {
      if (kind === 'note' || kind === 'folder') callback(kind);
    };
    ipcRenderer.on('entry:create', listener);
    return () => ipcRenderer.removeListener('entry:create', listener);
  },
  readNote: (relativePath: string): Promise<NoteData> =>
    ipcRenderer.invoke('vault:read-note', relativePath),
  saveNote: (request: SaveNoteRequest): Promise<SaveNoteResult> =>
    ipcRenderer.invoke('vault:save-note', request),
  readImage: (request: VaultImageRequest): Promise<VaultImageResult> =>
    ipcRenderer.invoke('vault:read-image', request),
  onSettingsOpen: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on('settings:open', listener);
    return () => ipcRenderer.removeListener('settings:open', listener);
  },
  onNewTab: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on('tabs:new', listener);
    return () => ipcRenderer.removeListener('tabs:new', listener);
  },
  onCloseActiveTab: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on('tabs:close-active', listener);
    return () => ipcRenderer.removeListener('tabs:close-active', listener);
  },
  onOpenFile: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on('file:open', listener);
    return () => ipcRenderer.removeListener('file:open', listener);
  },
  onToggleExplorer: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on('explorer:toggle', listener);
    return () => ipcRenderer.removeListener('explorer:toggle', listener);
  },
  onSelectTabIndex: (callback: (index: number) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, index: number) => {
      if (Number.isInteger(index) && index >= 0 && index < 9) callback(index);
    };
    ipcRenderer.on('tabs:select-index', listener);
    return () => ipcRenderer.removeListener('tabs:select-index', listener);
  },
  onActivateVaultIndex: (callback: (index: number) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, index: number) => {
      if (Number.isInteger(index) && index >= 0 && index < 9) callback(index);
    };
    ipcRenderer.on('vaults:activate-index', listener);
    return () => ipcRenderer.removeListener('vaults:activate-index', listener);
  },
  onFocusPane: (
    callback: (pane: 'vaults' | 'explorer' | 'editor') => void,
  ): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, pane: unknown) => {
      if (pane === 'vaults' || pane === 'explorer' || pane === 'editor')
        callback(pane);
    };
    ipcRenderer.on('pane:focus', listener);
    return () => ipcRenderer.removeListener('pane:focus', listener);
  },
  onFormat: (callback: (kind: 'bold' | 'italic') => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, kind: unknown) => {
      if (kind === 'bold' || kind === 'italic') callback(kind);
    };
    ipcRenderer.on('editor:format', listener);
    return () => ipcRenderer.removeListener('editor:format', listener);
  },
  onToggleReadMode: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on('reading-mode:toggle', listener);
    return () => ipcRenderer.removeListener('reading-mode:toggle', listener);
  },
  onTogglePreview: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on('preview:toggle', listener);
    return () => ipcRenderer.removeListener('preview:toggle', listener);
  },
  setShortcutEnabled: (
    shortcut: 'openFile' | 'toggleExplorer',
    enabled: boolean,
  ): void => ipcRenderer.send('shortcut:set-enabled', shortcut, enabled),
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
