import path from 'node:path';
import { lstat, realpath, stat } from 'node:fs/promises';

export function parseVaultRelativePath(
  value: unknown,
  allowRoot = false,
): string[] {
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    path.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value)
  )
    throw new Error('Invalid vault path');
  if (allowRoot && value === '') return [];
  const segments = value.split(/[\\/]/);
  if (
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  )
    throw new Error('Invalid vault path');
  return segments;
}

export function isVaultContained(
  root: string,
  candidate: string,
  allowRoot = false,
): boolean {
  const relative = path.relative(root, candidate);
  return (
    (allowRoot || relative !== '') &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** Resolve an existing entry; callers explicitly choose whether internal symlinks are allowed. */
export async function resolveVaultEntry(
  rootPath: string,
  relativePath: unknown,
  policy: {
    symlinks: 'reject' | 'within-root';
    type: 'file' | 'directory' | 'entry';
    allowRoot?: boolean;
  },
) {
  const segments = parseVaultRelativePath(relativePath, policy.allowRoot);
  const root = await realpath(rootPath);
  const target = path.resolve(root, ...segments);
  if (!isVaultContained(root, target, policy.allowRoot))
    throw new Error('Path is outside the selected vault');
  if (policy.symlinks === 'reject') {
    let current = root;
    for (const segment of segments) {
      current = path.join(current, segment);
      if ((await lstat(current)).isSymbolicLink())
        throw new Error('Symbolic links are not valid vault entries');
    }
  }
  const resolved = await realpath(target);
  if (!isVaultContained(root, resolved, policy.allowRoot))
    throw new Error('Path is outside the selected vault');
  const info = await stat(resolved);
  if (
    (policy.type === 'file' && !info.isFile()) ||
    (policy.type === 'directory' && !info.isDirectory()) ||
    (!info.isFile() && !info.isDirectory())
  )
    throw new Error('Vault entry type changed');
  return { root, target, resolved, info, segments };
}
