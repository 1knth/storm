import { mkdir, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { VaultEntry } from '../shared/types';

const protectedNames = new Set(['.obsidian', '.git', 'node_modules']);

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function validateName(name: unknown): asserts name is string {
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.length > 240 ||
    name === '.' ||
    name === '..' ||
    /[\\/]/.test(name) ||
    hasControlCharacter(name) ||
    /[. ]$/.test(name) ||
    /^[. ]/.test(name) ||
    /[<>:"|?*]/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  ) {
    throw new Error('Invalid name. Use a single valid file or folder name.');
  }
}

async function destination(
  root: string,
  parentRelativePath: unknown,
  name: unknown,
): Promise<{ parent: string; name: string }> {
  if (
    typeof parentRelativePath !== 'string' ||
    parentRelativePath.includes('\\') ||
    path.posix.isAbsolute(parentRelativePath) ||
    parentRelativePath.split('/').some((part) => part === '..' || part === '.')
  )
    throw new Error('Invalid parent folder path.');
  validateName(name);
  if (protectedNames.has(name.toLowerCase()))
    throw new Error('That folder name is reserved.');
  const canonicalRoot = await realpath(root);
  const parent = path.resolve(canonicalRoot, parentRelativePath);
  const relative = path.relative(canonicalRoot, parent);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error('Parent folder is outside the vault.');
  const parentReal = await realpath(parent);
  const realRelative = path.relative(canonicalRoot, parentReal);
  if (
    realRelative === '..' ||
    realRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(realRelative)
  )
    throw new Error('Parent folder is outside the vault.');
  if (!(await stat(parentReal)).isDirectory())
    throw new Error('Parent path is not a folder.');
  return { parent: parentReal, name };
}

export async function createMarkdownNote(
  root: string,
  parentRelativePath: string,
  name: string,
): Promise<VaultEntry> {
  const target = await destination(root, parentRelativePath, name);
  const filename = target.name.toLowerCase().endsWith('.md')
    ? target.name
    : `${target.name}.md`;
  const relativePath = path.posix.join(parentRelativePath, filename);
  const handle = await open(path.join(target.parent, filename), 'wx');
  await handle.close();
  return {
    path: relativePath,
    name: filename,
    kind: 'note',
    isDirectory: false,
    peek: '',
  };
}

export async function createFolder(
  root: string,
  parentRelativePath: string,
  name: string,
): Promise<VaultEntry> {
  const target = await destination(root, parentRelativePath, name);
  await mkdir(path.join(target.parent, target.name));
  return {
    path: path.posix.join(parentRelativePath, target.name),
    name: target.name,
    kind: 'directory',
    isDirectory: true,
    peek: '',
  };
}
