export type OptimisticRename = {
  oldPath: string;
  newPath: string;
  committed: boolean;
};

export function reconcileOptimisticRename(
  rename: OptimisticRename | null,
  paths: string[],
): OptimisticRename | null {
  if (!rename?.committed) return rename;
  const normalized = new Set(paths.map((path) => path.split('\\').join('/')));
  return normalized.has(rename.newPath) && !normalized.has(rename.oldPath)
    ? null
    : rename;
}

export function actualPathForOptimisticRename(
  path: string,
  rename: OptimisticRename | null,
): string {
  if (!rename) return path;
  const normalized = path.split('\\\\').join('/');
  const from = rename.newPath;
  const to = rename.committed ? rename.newPath : rename.oldPath;
  if (normalized !== from && !normalized.startsWith(`${from}/`)) return path;
  return `${to}${normalized.slice(from.length)}`;
}

export function remapOptimisticPath(
  path: string,
  rename: OptimisticRename,
): string {
  const normalized = path.split('\\').join('/');
  if (
    normalized !== rename.oldPath &&
    !normalized.startsWith(`${rename.oldPath}/`)
  )
    return path;
  return `${rename.newPath}${normalized.slice(rename.oldPath.length)}`;
}
