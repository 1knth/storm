import type { GroupColor } from './groupColors';

export interface RegisteredVault {
  id: string;
  name: string;
  path: string;
  groupId?: string | null;
}

export interface VaultGroup {
  id: string;
  name: string;
  collapsed: boolean;
  color?: GroupColor;
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

export interface VaultImageRequest {
  vaultId: string;
  notePath: string;
  imagePath: string;
  kind?: 'markdown' | 'wiki';
}

export interface VaultImageResult {
  mimeType: string;
  base64: string;
}

export interface CreateEntryRequest {
  vaultId: string;
  parentRelativePath: string;
  name: string;
}

export interface VaultEntry {
  path: string;
  name: string;
  isDirectory: boolean;
  peek: string;
}

declare global {
  interface Window {
    vault: {
      registryList: () => Promise<{
        vaults: RegisteredVault[];
        activeVaultId: string | null;
      }>;
      groupsList: () => Promise<VaultGroup[]>;
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
      groupSetCollapsed: (id: string, collapsed: boolean) => Promise<void>;
      groupSetColor: (id: string, color: GroupColor) => Promise<void>;
      registryAdd: (
        directory: string,
      ) => Promise<{ vault: RegisteredVault; created: boolean }>;
      registryActivate: (
        id: string,
      ) => Promise<{ id: string; path: string | null }>;
      registryRemove: (id: string) => Promise<void>;
      choose: () => Promise<{ path: string | null; warning: string | null }>;
      restore: () => Promise<{ path: string | null; error: string | null }>;
      listNotes: () => Promise<VaultEntry[]>;
      createNote: (request: CreateEntryRequest) => Promise<VaultEntry>;
      createFolder: (request: CreateEntryRequest) => Promise<VaultEntry>;
      onCreateEntry: (
        callback: (kind: 'note' | 'folder') => void,
      ) => () => void;
      readNote: (relativePath: string) => Promise<NoteData>;
      saveNote: (request: SaveNoteRequest) => Promise<SaveNoteResult>;
      readImage: (request: VaultImageRequest) => Promise<VaultImageResult>;
      onSettingsOpen: (callback: () => void) => () => void;
      onNewTab: (callback: () => void) => () => void;
      onOpenFile: (callback: () => void) => () => void;
      onToggleExplorer: (callback: () => void) => () => void;
      onTogglePreview: (callback: () => void) => () => void;
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
