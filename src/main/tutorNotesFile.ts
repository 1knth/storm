import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type { QuizScope } from '../shared/quizProtocol';

/** Tutor handoff notes live in the vault, beside the material they cover. */
export type TutorNotesFile = {
  /** Writes the notes and returns their vault-relative path. */
  write(scope: QuizScope, sessionId: string, text: string): Promise<string>;
  /** Reads saved notes; null when the vault or file is unavailable. */
  read(vaultId: string, relativePath: string): Promise<string | null>;
};

type Ports = {
  vaults: () => Promise<Array<{ id: string; path: string }>>;
  exclusive: <T>(root: string, operation: () => Promise<T>) => Promise<T>;
};

/** The `storm` folder inside the selected folder, or beside the selected note. */
export function tutorNotesPath(scope: QuizScope, sessionId: string): string {
  const note = scope.notePath ?? scope.selectedNotePaths[0] ?? null;
  const base =
    scope.folderPath !== null
      ? scope.folderPath
      : note !== null
        ? path.posix.dirname(note)
        : '.';
  const name = `tutor-notes-${sessionId.replace(/[^A-Za-z0-9_-]/g, '-')}.md`;
  return path.posix.normalize(path.posix.join(base, 'storm', name));
}

export function createTutorNotesFile(ports: Ports): TutorNotesFile {
  const root = async (vaultId: string) => {
    const vault = (await ports.vaults()).find((entry) => entry.id === vaultId);
    if (!vault) throw new Error('Vault is not registered');
    return realpath(vault.path);
  };
  // Refuse paths that escape the vault, including through symlinks.
  const contained = (vaultRoot: string, absolute: string) =>
    absolute === vaultRoot || absolute.startsWith(vaultRoot + path.sep);

  return {
    async write(scope, sessionId, text) {
      const vaultRoot = await root(scope.vaultId);
      const relative = tutorNotesPath(scope, sessionId);
      if (relative.startsWith('..') || path.posix.isAbsolute(relative))
        throw new Error('Notes path escapes the vault');
      return ports.exclusive(vaultRoot, async () => {
        const target = path.join(vaultRoot, relative);
        await mkdir(path.dirname(target), { recursive: true });
        const folder = await realpath(path.dirname(target));
        if (!contained(vaultRoot, folder))
          throw new Error('Notes path escapes the vault');
        const destination = path.join(folder, path.basename(target));
        const temporary = path.join(folder, `.${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, `${text}\n`, { flag: 'wx' });
          await rename(temporary, destination);
        } finally {
          await rm(temporary, { force: true });
        }
        return relative;
      });
    },
    async read(vaultId, relativePath) {
      try {
        const vaultRoot = await root(vaultId);
        const file = await realpath(path.join(vaultRoot, relativePath));
        if (!contained(vaultRoot, file)) return null;
        const text = (await readFile(file, 'utf8')).trim();
        return text || null;
      } catch {
        return null;
      }
    },
  };
}
