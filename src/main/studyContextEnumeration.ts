import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { QuizScope } from '../shared/quizProtocol';
import type { VaultEntry } from '../shared/types';
import { STUDY_LIMITS } from '../shared/studyContext';

const prefixed = new WeakMap<VaultEntry[], VaultEntry[]>();
const trees = new Map<
  string,
  { entries: VaultEntry[]; stamps: Array<[string, string]> }
>();
const stamp = async (folder: string) => {
  const metadata = await stat(folder);
  return `${metadata.ino}:${metadata.mtimeMs}:${metadata.ctimeMs}`;
};
async function cachedTree(
  folder: string,
  enumerate: (folder: string) => Promise<VaultEntry[]>,
) {
  const cached = trees.get(folder);
  if (cached) {
    try {
      const current = await Promise.all(
        cached.stamps.map(
          async ([directory, revision]) =>
            (await stamp(directory)) === revision,
        ),
      );
      if (current.every(Boolean)) return cached.entries;
    } catch {
      /* Re-enumerate changed namespaces. */
    }
  }
  const before = await stamp(folder);
  const entries = await enumerate(folder);
  const stamps: Array<[string, string]> = [[folder, before]];
  for (const entry of entries)
    if (entry.kind === 'directory') {
      const directory = path.join(folder, entry.path);
      stamps.push([directory, await stamp(directory)]);
    }
  // Never cache a truncated tree: omitted directory changes cannot be observed.
  if (entries.length <= STUDY_LIMITS.entries) {
    trees.set(folder, { entries, stamps });
    while (trees.size > 16) trees.delete(trees.keys().next().value!);
  }
  return entries;
}

/** Enumerate the selected namespace before applying the bounded tree limit. */
export async function enumerateStudyScope(
  root: string,
  scope: QuizScope | undefined,
  enumerate: (folder: string) => Promise<VaultEntry[]>,
): Promise<VaultEntry[]> {
  const validate = async (relative: string) => {
    let target = root;
    for (const segment of relative.split('/')) {
      target = path.join(target, segment);
      if ((await lstat(target)).isSymbolicLink())
        throw new Error('STUDY_INVALID_PATH');
    }
    if ((await realpath(target)) !== target)
      throw new Error('STUDY_INVALID_PATH');
    return target;
  };
  if (!scope) return cachedTree(root, enumerate);
  if (scope.folderPath) {
    if (scope.folderPath === '.') return cachedTree(root, enumerate);
    const folder = await validate(scope.folderPath);
    const entries = await cachedTree(folder, enumerate);
    let result = prefixed.get(entries);
    if (!result) {
      result = entries.map((entry) => ({
        ...entry,
        path: `${scope.folderPath}/${entry.path.replace(/\\/g, '/')}`,
      }));
      prefixed.set(entries, result);
    }
    return result;
  }
  const entries: VaultEntry[] = [];
  for (const relative of scope.notePath
    ? [scope.notePath]
    : scope.selectedNotePaths) {
    try {
      const target = await validate(relative);
      if ((await lstat(target)).isFile())
        entries.push({
          path: relative,
          name: path.basename(relative),
          kind: 'note',
          isDirectory: false,
          peek: '',
        });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (entries.length > STUDY_LIMITS.entries) break;
  }
  return entries;
}
