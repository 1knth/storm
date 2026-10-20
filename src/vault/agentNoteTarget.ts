import { createHash } from 'node:crypto';
import { lstat, open, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export interface AgentRegisteredVault {
  id: string;
  path: string;
}

export interface AgentNoteTarget {
  vaultId: string;
  vaultRoot: string;
  absolutePath: string;
  relativePath: string;
  content: string;
  diskRevision: string;
}

export type AgentNoteTargetErrorCode =
  | 'INVALID_PATH'
  | 'INVALID_EXTENSION'
  | 'PATH_OUTSIDE_VAULT'
  | 'UNREGISTERED_VAULT'
  | 'MISSING_PARENT'
  | 'MISSING_NOTE'
  | 'NOT_A_DIRECTORY'
  | 'NOT_A_REGULAR_NOTE'
  | 'READ_ONLY';

export class AgentNoteTargetError extends Error {
  constructor(
    readonly code: AgentNoteTargetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentNoteTargetError';
  }
}

/** Resolve an absolute CLI note path without consulting or changing the selected vault. */
export async function resolveAgentNoteTarget(
  absolutePath: string,
  registeredVaults: readonly AgentRegisteredVault[],
): Promise<AgentNoteTarget> {
  return resolveAgentNoteTargetWithMode(absolutePath, registeredVaults, true);
}

/** Resolve an existing note without creating the note or any parent directories. */
export async function resolveExistingAgentNoteTarget(
  absolutePath: string,
  registeredVaults: readonly AgentRegisteredVault[],
): Promise<AgentNoteTarget> {
  return resolveAgentNoteTargetWithMode(absolutePath, registeredVaults, false);
}

async function resolveAgentNoteTargetWithMode(
  absolutePath: string,
  registeredVaults: readonly AgentRegisteredVault[],
  createMissing: boolean,
): Promise<AgentNoteTarget> {
  if (typeof absolutePath !== 'string' || !path.isAbsolute(absolutePath)) {
    throw new AgentNoteTargetError(
      'INVALID_PATH',
      'An absolute note path is required',
    );
  }
  if (!absolutePath.toLowerCase().endsWith('.md')) {
    throw new AgentNoteTargetError(
      'INVALID_EXTENSION',
      'Only Markdown notes are supported',
    );
  }

  const requestedTarget = path.resolve(absolutePath);
  const identityTarget = await resolveThroughExistingAncestor(requestedTarget);
  const roots: Array<{ id: string; root: string; requestedRoot: string }> = [];
  for (const vault of registeredVaults) {
    try {
      const info = await stat(vault.path);
      if (info.isDirectory())
        roots.push({
          id: vault.id,
          root: await realpath(vault.path),
          requestedRoot: path.resolve(vault.path),
        });
    } catch {
      // A stale registered folder cannot authorize access.
    }
  }
  const matching = roots
    .filter(
      ({ root, requestedRoot }) =>
        isWithin(root, identityTarget) ||
        isWithin(requestedRoot, requestedTarget),
    )
    .sort(
      (a, b) =>
        b.root.length - a.root.length ||
        Number(b.requestedRoot === b.root) - Number(a.requestedRoot === a.root),
    );
  if (!matching.length) {
    throw new AgentNoteTargetError(
      'UNREGISTERED_VAULT',
      'Path is not inside a registered vault',
    );
  }
  const { id: vaultId, root: vaultRoot } = matching[0];
  const relativePath = path.relative(vaultRoot, identityTarget);
  const canonicalTarget = path.join(vaultRoot, relativePath);
  if (
    !relativePath ||
    relativePath.startsWith('..') ||
    path.isAbsolute(relativePath)
  ) {
    throw new AgentNoteTargetError(
      'PATH_OUTSIDE_VAULT',
      'Note path is outside its vault',
    );
  }

  let parentReal: string;
  try {
    parentReal = await realpath(path.dirname(canonicalTarget));
  } catch (error) {
    if (isCode(error, 'ENOENT'))
      throw new AgentNoteTargetError(
        'MISSING_PARENT',
        'Note parent directory does not exist',
      );
    if (isCode(error, 'EACCES'))
      throw new AgentNoteTargetError(
        'READ_ONLY',
        'Note parent directory is not accessible',
      );
    throw error;
  }
  if (!isWithin(vaultRoot, parentReal)) {
    throw new AgentNoteTargetError(
      'PATH_OUTSIDE_VAULT',
      'Note parent resolves outside its vault',
    );
  }
  const parentInfo = await stat(parentReal);
  if (!parentInfo.isDirectory())
    throw new AgentNoteTargetError(
      'NOT_A_DIRECTORY',
      'Note parent is not a directory',
    );

  let content: string;
  try {
    const info = await lstat(canonicalTarget);
    if (info.isSymbolicLink())
      throw new AgentNoteTargetError(
        'PATH_OUTSIDE_VAULT',
        'Symbolic-link note targets are not allowed',
      );
    if (!info.isFile())
      throw new AgentNoteTargetError(
        'NOT_A_REGULAR_NOTE',
        'Target is not a regular Markdown file',
      );
    content = await readFile(canonicalTarget, 'utf8');
  } catch (error) {
    if (error instanceof AgentNoteTargetError) throw error;
    if (!isCode(error, 'ENOENT')) {
      if (isCode(error, 'EACCES') || isCode(error, 'EPERM'))
        throw new AgentNoteTargetError(
          'READ_ONLY',
          'Note cannot be read or created',
        );
      throw error;
    }
    if (!createMissing) {
      throw new AgentNoteTargetError('MISSING_NOTE', 'Note does not exist');
    }
    try {
      const handle = await open(canonicalTarget, 'wx', 0o666);
      await handle.close();
      content = '';
    } catch (createError) {
      if (isCode(createError, 'EEXIST')) {
        // Another connector won creation; validate and read its regular file below.
        const info = await lstat(canonicalTarget);
        if (info.isSymbolicLink() || !info.isFile())
          throw new AgentNoteTargetError(
            'NOT_A_REGULAR_NOTE',
            'Target is not a regular Markdown file',
          );
        content = await readFile(canonicalTarget, 'utf8');
      } else if (
        isCode(createError, 'EACCES') ||
        isCode(createError, 'EPERM')
      ) {
        throw new AgentNoteTargetError('READ_ONLY', 'Note cannot be created');
      } else throw createError;
    }
  }

  return {
    vaultId,
    vaultRoot,
    absolutePath: canonicalTarget,
    relativePath: relativePath.split(path.sep).join('/'),
    content,
    diskRevision: createHash('sha256').update(content).digest('hex'),
  };
}

async function resolveThroughExistingAncestor(target: string): Promise<string> {
  let existing = target;
  const missingSegments: string[] = [];
  while (true) {
    try {
      const canonicalExisting = await realpath(existing);
      return path.join(canonicalExisting, ...missingSegments.reverse());
    } catch (error) {
      if (!isCode(error, 'ENOENT') && !isCode(error, 'ENOTDIR')) throw error;
      const parent = path.dirname(existing);
      if (parent === existing) return target;
      missingSegments.push(path.basename(existing));
      existing = parent;
    }
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
