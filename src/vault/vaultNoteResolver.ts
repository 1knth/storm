import { enumerateVault, VaultNoteIndex } from './vaultIndex';
import path from 'node:path';
import { realpath } from 'node:fs/promises';

export async function resolveVaultNote(
  vaultPath: string,
  currentNotePath: string,
  target: string,
  indexedFiles?: readonly string[] | VaultNoteIndex,
): Promise<string> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(target)
      .replace(/\\/g, '/')
      .replace(/^\/+/, '');
  } catch {
    throw new Error('Invalid note link');
  }
  if (!decoded || decoded.split('/').some((part) => part === '..'))
    throw new Error('Invalid note link');
  const root = await realpath(vaultPath);
  const index =
    indexedFiles instanceof VaultNoteIndex
      ? indexedFiles
      : new VaultNoteIndex(
          indexedFiles ??
            (await enumerateVault(root))
              .filter((entry) => entry.kind === 'note')
              .map((entry) => entry.path),
        );
  const withExtension = /\.md$/i.test(decoded) ? decoded : `${decoded}.md`;
  const lower = (value: string) => value.toLowerCase();
  const currentDirectory = path.posix.dirname(
    currentNotePath.replace(/\\/g, '/'),
  );
  const relative =
    currentDirectory === '.'
      ? withExtension
      : `${currentDirectory}/${withExtension}`;
  const exact = index.paths.get(lower(relative)) ?? [];
  const rootMatch = index.paths.get(lower(withExtension)) ?? [];
  const basename = !withExtension.includes('/')
    ? (index.basenames.get(lower(withExtension)) ?? [])
    : [];
  const matches = exact.length
    ? exact
    : rootMatch.length
      ? rootMatch
      : basename;
  if (matches.length !== 1)
    throw new Error(
      matches.length ? 'Note link is ambiguous' : 'Note not found',
    );
  return matches[0];
}
