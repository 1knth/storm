import path from 'node:path';
import { readdir, realpath } from 'node:fs/promises';

export async function resolveVaultNote(
  vaultPath: string,
  currentNotePath: string,
  target: string,
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
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
        files.push(path.relative(root, file).replace(/\\/g, '/'));
    }
  }
  await walk(root);
  const withExtension = /\.md$/i.test(decoded) ? decoded : `${decoded}.md`;
  const lower = (value: string) => value.toLowerCase();
  const currentDirectory = path.posix.dirname(
    currentNotePath.replace(/\\/g, '/'),
  );
  const relative =
    currentDirectory === '.'
      ? withExtension
      : `${currentDirectory}/${withExtension}`;
  const exact = files.filter((file) => lower(file) === lower(relative));
  const rootMatch = files.filter(
    (file) => lower(file) === lower(withExtension),
  );
  const basename = !withExtension.includes('/')
    ? files.filter(
        (file) => lower(path.posix.basename(file)) === lower(withExtension),
      )
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
