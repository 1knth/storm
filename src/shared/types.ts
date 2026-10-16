export interface NoteData {
  path: string;
  content: string;
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
      onSettingsOpen: (callback: () => void) => () => void;
    };
  }
}

export interface Note {
	id: string;
	title: string;
	content: {
		body: {}
	};
	updatedAt: string; // ISO date string
}
