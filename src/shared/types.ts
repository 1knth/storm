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

export interface VaultEntry {
  path: string;
  name: string;
  isDirectory: boolean;
  peek: string;
}

declare global {
  interface Window {
    vault: {
      choose: () => Promise<string | null>;
      listNotes: () => Promise<VaultEntry[]>;
      readNote: (relativePath: string) => Promise<NoteData>;
      saveNote: (request: SaveNoteRequest) => Promise<SaveNoteResult>;
      onSettingsOpen: (callback: () => void) => () => void;
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
