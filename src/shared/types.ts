import type { GroupColor } from './groupColors';

export interface RegisteredVault {
  id: string;
  name: string;
  path: string;
  groupId?: string | null;
  pinned?: boolean;
}

export interface VaultGroup {
  id: string;
  name: string;
  collapsed: boolean;
  color?: GroupColor;
}

export type SidebarRootRef =
  | { kind: 'vault'; id: string }
  | { kind: 'group'; id: string };

export interface SidebarMoveRequest {
  item: SidebarRootRef;
  before: SidebarRootRef | null;
}

export type SavedTabLayout = {
  version: 1;
  tabs: Array<
    | {
        kind: 'note';
        path: string;
        anchor: number;
        head: number;
        scrollTop: number;
      }
    | { kind: 'image'; path: string }
    | { kind: 'empty'; id: string }
  >;
  activeTab: string | null;
  groups: Array<{
    id: string;
    name: string;
    collapsed: boolean;
    color?: string;
  }>;
  assignments: Record<string, string>;
};

export interface VaultChangeEvent {
  vaultId: string;
  revision: number;
}

export interface NoteData {
  path: string;
  content: string;
  revision: string;
}

export interface SaveNoteRequest {
  vaultPath: string;
  path: string;
  content: string;
  revision: string;
}

export interface SaveNoteResult {
  revision: string;
}

export interface VaultNoteLinkRequest {
  vaultId: string;
  notePath: string;
  target: string;
}

export type VaultNoteLinkResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'missing' | 'ambiguous' | 'invalid' };

export interface PasteImageRequest {
  vaultId: string;
  notePath: string;
  mimeType: string;
  base64: string;
}

export interface PasteImageResult {
  imagePath: string;
}

export interface VaultImageRequest {
  vaultId: string;
  notePath: string;
  imagePath: string;
  kind?: 'markdown' | 'wiki';
}

export type VaultImageResult =
  | { ok: true; mimeType: string; base64: string }
  | {
      ok: false;
      reason: 'not-found' | 'ambiguous' | 'unsupported' | 'unavailable';
    };

export interface CreateEntryRequest {
  vaultId: string;
  parentRelativePath: string;
  name: string;
}

export interface VaultEntry {
  path: string;
  name: string;
  kind: 'note' | 'image' | 'directory';
  isDirectory: boolean;
  peek: string;
  mimeType?: string;
}

export interface VaultAssetRequest {
  vaultId: string;
  relativePath: string;
}

export type VaultAssetResult = VaultImageResult;

export interface DeleteEntryResult {
  deleted: boolean;
  path: string;
  kind: 'note' | 'folder' | 'image';
}

declare global {
  interface Window {
    vault: {
      registryList: () => Promise<{
        vaults: RegisteredVault[];
        activeVaultId: string | null;
        sidebarRootOrder: SidebarRootRef[];
      }>;
      groupsList: () => Promise<VaultGroup[]>;
      sidebarMove: (request: SidebarMoveRequest) => Promise<void>;
      saveTabLayout: (vaultId: string, layout: SavedTabLayout) => Promise<void>;
      getTabLayout: (vaultId: string) => Promise<SavedTabLayout | null>;
      onRestoreTabs: (callback: () => void) => () => void;
      onVaultChanged: (
        listener: (event: VaultChangeEvent) => void,
      ) => () => void;
      groupFolderChoose: () => Promise<{
        selectionId: string;
        name: string;
      } | null>;
      groupCreateFromFolder: (
        selectionId: string,
        name: string,
      ) => Promise<VaultGroup>;
      groupCreate: (name: string) => Promise<VaultGroup>;
      groupRename: (id: string, name: string) => Promise<VaultGroup>;
      groupRemove: (id: string) => Promise<void>;
      groupSetVault: (vaultId: string, groupId: string | null) => Promise<void>;
      vaultSetPlacement: (request: {
        vaultId: string;
        groupId: string | null;
        pinned: boolean;
        beforeVaultId: string | null;
      }) => Promise<void>;
      groupsReorder: (groupIds: string[]) => Promise<void>;
      groupSetCollapsed: (id: string, collapsed: boolean) => Promise<void>;
      groupSetColor: (id: string, color: GroupColor) => Promise<void>;
      registryAdd: (
        directory: string,
      ) => Promise<{ vault: RegisteredVault; created: boolean }>;
      registryActivate: (
        id: string,
      ) => Promise<{ id: string; path: string | null }>;
      registryRemove: (id: string) => Promise<void>;
      registryUnloadVault: (id: string) => Promise<void>;
      registryUnloadAll: () => Promise<void>;
      choose: () => Promise<{ path: string | null; warning: string | null }>;
      restore: () => Promise<{ path: string | null; error: string | null }>;
      listNotes: () => Promise<VaultEntry[]>;
      createNote: (request: CreateEntryRequest) => Promise<VaultEntry>;
      createFolder: (request: CreateEntryRequest) => Promise<VaultEntry>;
      deleteEntry: (request: {
        vaultId: string;
        path: string;
      }) => Promise<DeleteEntryResult>;
      onCreateEntry: (
        callback: (kind: 'note' | 'folder') => void,
      ) => () => void;
      readNote: (relativePath: string) => Promise<NoteData>;
      saveNote: (request: SaveNoteRequest) => Promise<SaveNoteResult>;
      readImage: (request: VaultImageRequest) => Promise<VaultImageResult>;
      readAsset: (request: VaultAssetRequest) => Promise<VaultAssetResult>;
      pasteImage: (request: PasteImageRequest) => Promise<PasteImageResult>;
      resolveNoteLink: (
        request: VaultNoteLinkRequest,
      ) => Promise<VaultNoteLinkResult>;
      onSettingsOpen: (callback: () => void) => () => void;
      onNewTab: (callback: () => void) => () => void;
      onCloseActiveTab: (callback: () => void) => () => void;
      onOpenFile: (callback: () => void) => () => void;
      onToggleExplorer: (callback: () => void) => () => void;
      onFocusPane: (
        callback: (pane: 'vaults' | 'explorer' | 'editor') => void,
      ) => () => void;
      onTogglePreview: (callback: () => void) => () => void;
      onToggleReadMode: (callback: () => void) => () => void;
      onFormat: (callback: (kind: 'bold' | 'italic') => void) => () => void;
      onSelectTabIndex: (callback: (index: number) => void) => () => void;
      onActivateVaultIndex: (callback: (index: number) => void) => () => void;
      setShortcutEnabled: (
        shortcut: 'openFile' | 'toggleExplorer',
        enabled: boolean,
      ) => void;
      onShutdownFlush: (callback: (requestId: string) => void) => () => void;
      acknowledgeShutdownFlush: (
        requestId: string,
        succeeded: boolean,
      ) => Promise<void>;
    };
  }
}

export interface Note {
  id: string;
  title: string;
  content: {
    body: {};
  };
  updatedAt: string; // ISO date string
}
