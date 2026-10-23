import path from 'node:path';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { VaultService } from '../vault/vaultService';
import { resolveVaultNote } from '../vault/vaultNoteResolver';

export type LinkIssueReason = 'missing' | 'ambiguous' | 'invalid';
export type DiscoveryIssue = {
  sourcePath: string;
  target: string;
  reason: LinkIssueReason;
};
export type LinkResolution = {
  sourcePath: string;
  target: string;
  path?: string;
  reason?: LinkIssueReason;
};

export async function resolveVaultLink(
  listVaults: () => Promise<{ vaults: Array<{ id: string; path: string }> }>,
  vaultId: string,
  sourcePath: string,
  target: string,
): Promise<LinkResolution> {
  const { vaults } = await listVaults();
  const vault = vaults.find((entry) => entry.id === vaultId);
  if (!vault) throw new Error('Vault is not registered');
  const root = await realpath(vault.path);
  if (root !== vault.path) throw new Error('Vault root changed');
  const service = new VaultService();
  await service.selectVault(root);
  const paths = new Set(
    (await service.listNotes())
      .filter((entry) => entry.kind === 'note')
      .map((entry) => entry.path),
  );
  if (!paths.has(sourcePath)) throw new Error('Source note not found');
  try {
    const resolved = await resolveVaultNote(root, sourcePath, target, [
      ...paths,
    ]);
    return paths.has(resolved)
      ? { sourcePath, target, path: resolved }
      : { sourcePath, target, reason: 'missing' };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (error.message === 'Note link is ambiguous')
      return { sourcePath, target, reason: 'ambiguous' };
    if (error.message === 'Note not found')
      return { sourcePath, target, reason: 'missing' };
    if (error.message === 'Invalid note link')
      return { sourcePath, target, reason: 'invalid' };
    throw error;
  }
}
export type DiscoveryResult = {
  results: Array<{ path: string; name: string; excerpt?: string }>;
  unresolved: DiscoveryIssue[];
  truncated?: boolean;
};

export async function discoverVaultNotes(
  listVaults: () => Promise<{ vaults: Array<{ id: string; path: string }> }>,
  vaultId: string,
  query: string | undefined,
  limit: number,
  options?: { sourcePath?: string; depth?: number; includeSource?: boolean },
): Promise<DiscoveryResult> {
  const { vaults } = await listVaults();
  const vault = vaults.find((entry) => entry.id === vaultId);
  if (!vault) throw new Error('Vault is not registered');
  const root = await realpath(vault.path);
  if (root !== vault.path) throw new Error('Vault root changed');
  const service = new VaultService();
  await service.selectVault(root);
  const needle = query?.toLocaleLowerCase();
  const entries = (await service.listNotes()).filter(
    (entry) => entry.kind === 'note',
  );
  const paths = new Set(entries.map((entry) => entry.path));
  const unresolved: DiscoveryIssue[] = [];
  let truncated = false;
  let candidates = entries;
  if (options?.sourcePath) {
    if (!paths.has(options.sourcePath))
      throw new Error('Source note not found');
    const depth = Math.max(0, Math.min(5, Math.floor(options.depth ?? 1)));
    const found = new Set<string>();
    const visited = new Set<string>();
    const queue: Array<{ path: string; level: number }> = [
      { path: options.sourcePath, level: 0 },
    ];
    const maxVisited = 1000;
    const maxLinks = 10000;
    let linksVisited = 0;
    while (queue.length) {
      if (visited.size >= maxVisited || linksVisited >= maxLinks) {
        truncated = true;
        break;
      }
      const current = queue.shift()!;
      if (visited.has(current.path) || current.level >= depth) continue;
      visited.add(current.path);
      const absolute = path.resolve(root, current.path);
      if (!absolute.startsWith(root + path.sep)) continue;
      const info = await lstat(absolute);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      const contents = await readFile(absolute, 'utf8');
      const links = [
        ...contents.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g),
      ];
      for (const link of links) {
        if (++linksVisited > maxLinks) {
          truncated = true;
          break;
        }
        const target = link[1].trim();
        try {
          const resolved = await resolveVaultNote(root, current.path, target, [
            ...paths,
          ]);
          if (paths.has(resolved) && !visited.has(resolved)) {
            found.add(resolved);
            queue.push({ path: resolved, level: current.level + 1 });
          }
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          const reason =
            error.message === 'Note link is ambiguous'
              ? 'ambiguous'
              : error.message === 'Note not found'
                ? 'missing'
                : error.message === 'Invalid note link'
                  ? 'invalid'
                  : undefined;
          if (!reason) throw error;
          unresolved.push({ sourcePath: current.path, target, reason });
        }
      }
    }
    if (options.includeSource) found.add(options.sourcePath);
    candidates = entries.filter((entry) => found.has(entry.path));
  }
  const results: DiscoveryResult['results'] = [];
  for (const entry of candidates) {
    const absolute = path.resolve(root, entry.path);
    if (!absolute.startsWith(root + path.sep)) continue;
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) continue;
    const contents = await readFile(absolute, 'utf8');
    const lowered = contents.toLocaleLowerCase();
    if (
      needle &&
      !entry.name.toLocaleLowerCase().includes(needle) &&
      !lowered.includes(needle)
    )
      continue;
    const index = needle ? lowered.indexOf(needle) : -1;
    const excerpt =
      index >= 0
        ? contents
            .slice(
              Math.max(0, index - 80),
              Math.min(contents.length, index + needle!.length + 160),
            )
            .replace(/\s+/g, ' ')
        : undefined;
    results.push({
      path: entry.path,
      name: entry.name,
      ...(excerpt ? { excerpt } : {}),
    });
    if (results.length >= limit) break;
  }
  return { results, unresolved, ...(truncated ? { truncated: true } : {}) };
}
