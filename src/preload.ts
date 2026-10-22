import { contextBridge, ipcRenderer } from 'electron';
import type {
  NoteData,
  SaveNoteRequest,
  SaveNoteResult,
  VaultEntry,
  RegisteredVault,
  VaultImageRequest,
  VaultImageResult,
  VaultAssetRequest,
  VaultAssetResult,
  PasteImageRequest,
  PasteImageResult,
  VaultNoteLinkRequest,
  VaultNoteLinkResult,
  SidebarMoveRequest,
  SidebarRootRef,
  CreateEntryRequest,
  VaultGroup,
  SavedTabLayout,
  DeleteEntryResult,
  VaultChangeEvent,
} from './shared/types';
import type { GroupColor } from './shared/groupColors';
import { isAgentEditPlan } from './shared/agentEditValidation';
import type {
  AgentBridgeRequest,
  AgentBridgeResult,
  AgentBridgeStatusEvent,
  StormAgentBridge,
} from './shared/agentBridge';

const stormAgent: StormAgentBridge = {
  onRequest(callback) {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (isAgentRequest(value)) callback(value);
    };
    ipcRenderer.on('agent:renderer-request', listener);
    ipcRenderer.send('agent:renderer-ready');
    return () => {
      ipcRenderer.removeListener('agent:renderer-request', listener);
    };
  },
  respond(requestId, result) {
    if (
      typeof requestId === 'string' &&
      requestId.length <= 128 &&
      isAgentResult(result)
    )
      ipcRenderer.send('agent:renderer-response', requestId, result);
  },
  onStatus(callback) {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (isAgentStatus(value)) callback(value);
    };
    ipcRenderer.on('agent:status', listener);
    return () => ipcRenderer.removeListener('agent:status', listener);
  },
  cancel(sessionId, reason) {
    if (
      typeof sessionId === 'string' &&
      sessionId.length > 0 &&
      sessionId.length <= 128
    )
      ipcRenderer.send(
        'agent:renderer-cancel',
        sessionId,
        typeof reason === 'string' ? reason.slice(0, 500) : undefined,
      );
  },
  saveNote(request) {
    return ipcRenderer.invoke('agent:save-note', request);
  },
};
contextBridge.exposeInMainWorld('stormAgent', stormAgent);

function isAgentRequest(value: unknown): value is AgentBridgeRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (typeof item.requestId !== 'string' || item.requestId.length > 128)
    return false;
  if (item.type === 'inspect')
    return typeof item.vaultId === 'string' && typeof item.path === 'string';
  if (item.type === 'snapshot')
    return (
      typeof item.absolutePath === 'string' &&
      typeof item.vaultId === 'string' &&
      typeof item.vaultRoot === 'string'
    );
  if (item.type === 'activity')
    return (
      typeof item.sessionId === 'string' &&
      (item.activity === null ||
        item.activity === 'thinking' ||
        item.activity === 'drafting')
    );
  if (item.type === 'append')
    return (
      typeof item.sessionId === 'string' &&
      typeof item.absolutePath === 'string' &&
      typeof item.operationId === 'string' &&
      Number.isSafeInteger(item.sequence) &&
      typeof item.text === 'string' &&
      new TextEncoder().encode(item.text).byteLength <= 262144
    );
  if (item.type === 'edit-preview' || item.type === 'edit-apply')
    return (
      typeof item.sessionId === 'string' &&
      Number.isSafeInteger(item.expectedVersion) &&
      Number(item.expectedVersion) >= 0 &&
      isAgentEditPlan(item.plan)
    );
  return (
    (item.type === 'finish' || item.type === 'cancel') &&
    typeof item.sessionId === 'string'
  );
}
function isAgentResult(value: unknown): value is AgentBridgeResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (item.ok === false)
    return typeof item.code === 'string' && typeof item.message === 'string';
  if (item.ok === true && item.preview === true)
    return (
      typeof item.content === 'string' &&
      typeof item.changed === 'boolean' &&
      Number.isSafeInteger(item.documentVersion) &&
      Number(item.documentVersion) >= 0 &&
      typeof item.diskRevision === 'string'
    );
  if (item.ok === true && item.edited === true)
    return (
      typeof item.content === 'string' &&
      Number.isSafeInteger(item.documentVersion) &&
      Number(item.documentVersion) >= 0 &&
      typeof item.diskRevision === 'string' &&
      item.saveState === 'saved'
    );
  if (item.ok === true && item.inspected === true)
    return (
      item.open === false ||
      (item.open === true &&
        typeof item.content === 'string' &&
        Number.isSafeInteger(item.documentVersion) &&
        typeof item.diskRevision === 'string' &&
        ['pending', 'saved', 'failed'].includes(String(item.saveState)))
    );
  return (
    item.ok === true &&
    Number.isSafeInteger(item.documentVersion) &&
    typeof item.diskRevision === 'string' &&
    (item.content === undefined || typeof item.content === 'string') &&
    (item.saveState === undefined ||
      item.saveState === 'pending' ||
      item.saveState === 'saved' ||
      item.saveState === 'failed')
  );
}
function isAgentStatus(value: unknown): value is AgentBridgeStatusEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  const session = event.session;
  if (!session || typeof session !== 'object' || Array.isArray(session))
    return false;
  const status = session as Record<string, unknown>;
  return (
    typeof status.sessionId === 'string' &&
    typeof status.absolutePath === 'string' &&
    [
      'connected',
      'writing',
      'finished',
      'cancelled',
      'disconnected',
      'failed',
    ].includes(String(status.state)) &&
    Number.isSafeInteger(status.documentVersion) &&
    typeof status.diskRevision === 'string' &&
    Number.isSafeInteger(status.pendingOperations) &&
    (status.activity === undefined ||
      status.activity === 'thinking' ||
      status.activity === 'drafting') &&
    (event.reason === undefined || typeof event.reason === 'string')
  );
}

contextBridge.exposeInMainWorld('vault', {
  cliAvailable: (): Promise<boolean> => ipcRenderer.invoke('cli:available'),
  canOpenFilesAndFoldersSettings: (): Promise<boolean> =>
    ipcRenderer.invoke('settings:canOpenFilesAndFolders'),
  openFilesAndFoldersSettings: (): Promise<boolean> =>
    ipcRenderer.invoke('settings:openFilesAndFolders'),
  cliInstalled: (): Promise<boolean> => ipcRenderer.invoke('cli:installed'),
  enableCli: (): Promise<boolean> => ipcRenderer.invoke('cli:enable'),
  disableCli: (): Promise<boolean> => ipcRenderer.invoke('cli:disable'),
  openDirectory: (): Promise<void> =>
    ipcRenderer.invoke('vault:open-directory'),
  openLocation: (
    relativePath: string,
    kind: 'note' | 'image' | 'folder',
  ): Promise<void> =>
    ipcRenderer.invoke('vault:open-location', relativePath, kind),
  registryList: (): Promise<{
    vaults: RegisteredVault[];
    activeVaultId: string | null;
    sidebarRootOrder: SidebarRootRef[];
  }> => ipcRenderer.invoke('vault:registry-list'),
  groupsList: (): Promise<VaultGroup[]> =>
    ipcRenderer.invoke('vault:groups-list'),
  sidebarMove: (request: SidebarMoveRequest): Promise<void> =>
    ipcRenderer.invoke('vault:sidebar-move', request),
  saveTabLayout: (vaultId: string, layout: SavedTabLayout): Promise<void> =>
    ipcRenderer.invoke('vault:tab-layout-save', vaultId, layout),
  getTabLayout: (vaultId: string): Promise<SavedTabLayout | null> =>
    ipcRenderer.invoke('vault:tab-layout-get', vaultId),
  onVaultChanged: (
    callback: (event: VaultChangeEvent) => void,
  ): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      if (!payload || typeof payload !== 'object') return;
      const value = payload as Partial<VaultChangeEvent>;
      if (
        typeof value.vaultId === 'string' &&
        typeof value.revision === 'number'
      )
        callback({ vaultId: value.vaultId, revision: value.revision });
    };
    ipcRenderer.on('vault:changed', listener);
    return () => ipcRenderer.removeListener('vault:changed', listener);
  },
  onRestoreTabs: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on('tabs:restore-saved', listener);
    return () => ipcRenderer.removeListener('tabs:restore-saved', listener);
  },
  onReopenClosedTab: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on('tabs:reopen-closed', listener);
    return () => ipcRenderer.removeListener('tabs:reopen-closed', listener);
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
  vaultSetPlacement: (request: {
    vaultId: string;
    groupId: string | null;
    pinned: boolean;
    beforeVaultId: string | null;
  }): Promise<void> => ipcRenderer.invoke('vault:placement-set', request),
  groupsReorder: (groupIds: string[]): Promise<void> =>
    ipcRenderer.invoke('vault:groups-reorder', groupIds),
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
  registryUnloadVault: (id: string): Promise<void> =>
    ipcRenderer.invoke('vault:registry-unload-one', id),
  registryUnloadAll: (): Promise<void> =>
    ipcRenderer.invoke('vault:registry-unload-all'),
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
  renameEntry: (request: { path: string; newName: string }) =>
    ipcRenderer.invoke('vault:rename-entry', request),
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
  readAsset: (request: VaultAssetRequest): Promise<VaultAssetResult> =>
    ipcRenderer.invoke('vault:read-asset', request),
  readPdf: (vaultId: string, relativePath: string): Promise<Uint8Array> =>
    ipcRenderer.invoke('vault:read-pdf', { vaultId, relativePath }),
  pasteImage: (request: PasteImageRequest): Promise<PasteImageResult> =>
    ipcRenderer.invoke('vault:paste-image', request),
  resolveNoteLink: (
    request: VaultNoteLinkRequest,
  ): Promise<VaultNoteLinkResult> =>
    ipcRenderer.invoke('vault:resolve-note-link', request),
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
