import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isSupportedVaultImagePath } from './vaultAssets';

export type DeletionKind = 'note' | 'folder' | 'image';
export interface DeletionTarget {
  absolutePath: string;
  relativePath: string;
  kind: DeletionKind;
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
}

const PROTECTED = new Set(['.obsidian', '.git', 'node_modules']);

export async function resolveDeletionTarget(
  registryRoot: string,
  relativePath: string,
): Promise<DeletionTarget> {
  if (
    typeof relativePath !== 'string' ||
    !relativePath.trim() ||
    path.isAbsolute(relativePath) ||
    relativePath.includes('\\')
  )
    throw new Error('Invalid deletion path');
  const segments = relativePath.split('/');
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        PROTECTED.has(segment),
    )
  )
    throw new Error('That path cannot be deleted');
  const root = await realpath(registryRoot);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink())
      throw new Error('Cannot delete through a symbolic link');
  }
  const target = await lstat(current);
  if (target.isDirectory()) {
    // Root is deliberately excluded; only descendants may be removed.
  } else if (target.isFile() && /\.md$/i.test(path.basename(current))) {
    // Markdown note.
  } else if (target.isFile() && isSupportedVaultImagePath(current)) {
    // Supported raster image.
  } else {
    throw new Error(
      'Only Markdown notes, supported images and folders can be moved to Trash',
    );
  }
  const canonical = await realpath(current);
  if (!canonical.startsWith(`${root}${path.sep}`))
    throw new Error('Deletion path escapes the vault');
  return {
    absolutePath: current,
    relativePath: segments.join('/'),
    kind: target.isDirectory()
      ? 'folder'
      : isSupportedVaultImagePath(current)
        ? 'image'
        : 'note',
    dev: target.dev,
    ino: target.ino,
    mtimeMs: target.mtimeMs,
    size: target.size,
  };
}

export async function assertDeletionTargetUnchanged(
  target: DeletionTarget,
): Promise<void> {
  const current = await lstat(target.absolutePath);
  if (
    current.isSymbolicLink() ||
    (target.kind === 'folder' ? !current.isDirectory() : !current.isFile()) ||
    current.dev !== target.dev ||
    current.ino !== target.ino ||
    current.mtimeMs !== target.mtimeMs ||
    current.size !== target.size
  )
    throw new Error(
      'The target changed while confirmation was open; nothing was deleted',
    );
}
