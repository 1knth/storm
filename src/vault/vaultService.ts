import { resolveVaultEntry } from './vaultPaths';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { enumerateVault } from './vaultIndex';
import { isSupportedVaultImagePath } from './vaultImageTypes';
import { executeVaultRename } from './vaultRenameTransaction';
import { KeyedQueue } from '../shared/asyncQueue';
import type {
  NoteData,
  SaveNoteRequest,
  SaveNoteResult,
  VaultEntry,
} from '../shared/types';

const noteWrites = new KeyedQueue();

export class VaultService {
  private selectedVaultPath: string | null = null;

  async selectVault(vaultPath: string): Promise<void> {
    const info = await stat(vaultPath);
    if (!info.isDirectory()) throw new Error('Selected vault is not a folder');
    this.selectedVaultPath = await realpath(vaultPath);
  }

  getSelectedVaultPath(): string | null {
    return this.selectedVaultPath;
  }

  clearSelectedVault(): void {
    this.selectedVaultPath = null;
  }

  async listNotes(
    options: { previews?: boolean; limit?: number } = {},
  ): Promise<VaultEntry[]> {
    const rootPath = this.selectedVaultPath;
    if (!rootPath) return [];

    return enumerateVault(rootPath, options);
  }

  async renameEntry(
    relativePath: unknown,
    newBaseName: unknown,
  ): Promise<{
    oldPath: string;
    newPath: string;
    kind: 'note' | 'image' | 'pdf' | 'directory';
  }> {
    const move = await this.validateRenameEntry(relativePath, newBaseName);
    if (move.oldPath !== move.newPath)
      await rename(move.source, move.destination);
    return { oldPath: move.oldPath, newPath: move.newPath, kind: move.kind };
  }

  async validateRenameEntry(
    relativePath: unknown,
    newBaseName: unknown,
  ): Promise<{
    oldPath: string;
    newPath: string;
    kind: 'note' | 'image' | 'pdf' | 'directory';
    source: string;
    destination: string;
  }> {
    const root = this.selectedVaultPath;
    if (!root) throw new Error('No vault selected');
    if (
      typeof relativePath !== 'string' ||
      !relativePath ||
      path.isAbsolute(relativePath) ||
      typeof newBaseName !== 'string' ||
      !newBaseName ||
      newBaseName === '.' ||
      newBaseName === '..' ||
      /[\\/\\0]/.test(newBaseName)
    )
      throw new Error('Invalid rename path or name');

    const segments = relativePath.split(/[\\/]+/);
    if (
      segments.some(
        (segment) => !segment || segment === '.' || segment === '..',
      )
    )
      throw new Error('Invalid rename path');
    const rootReal = await realpath(root);
    const source = path.resolve(rootReal, ...segments);
    const withinRoot = (candidate: string) => {
      const relative = path.relative(rootReal, candidate);
      return (
        relative !== '' &&
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
      );
    };
    if (!withinRoot(source))
      throw new Error('Cannot rename vault root or escape the selected vault');

    const { info: sourceInfo } = await resolveVaultEntry(
      rootReal,
      relativePath,
      { symlinks: 'reject', type: 'entry' },
    );
    if (!sourceInfo.isFile() && !sourceInfo.isDirectory())
      throw new Error('Unsupported rename entry');
    const kind = sourceInfo.isDirectory()
      ? 'directory'
      : source.toLowerCase().endsWith('.md')
        ? 'note'
        : isSupportedVaultImagePath(source)
          ? 'image'
          : path.extname(source).toLowerCase() === '.pdf'
            ? 'pdf'
            : null;
    if (!kind) throw new Error('Unsupported rename entry');
    if (kind === 'pdf' && path.extname(newBaseName) !== path.extname(source))
      throw new Error('PDF file extension must be preserved');
    const destination = path.join(path.dirname(source), newBaseName);
    if (!withinRoot(destination)) throw new Error('Invalid rename destination');
    const newPath = path
      .relative(rootReal, destination)
      .split(path.sep)
      .join('/');
    const oldPath = segments.join('/');
    if (newPath === oldPath)
      return { oldPath, newPath, kind, source, destination };
    try {
      await lstat(destination);
      throw new Error('Rename destination already exists');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (this.selectedVaultPath !== root)
      throw new Error('Selected vault changed; rename cancelled');
    return { oldPath, newPath, kind, source, destination };
  }

  async renameEntryAndUpdateLinks(
    relativePath: unknown,
    newBaseName: unknown,
  ): Promise<{
    oldPath: string;
    newPath: string;
    kind: 'note' | 'image' | 'pdf' | 'directory';
    changedNotes: { path: string; content: string; revision: string }[];
  }> {
    return executeVaultRename(this, relativePath, newBaseName);
  }

  async readNote(relativePath: unknown): Promise<NoteData> {
    const vaultPath = this.selectedVaultPath;
    if (!vaultPath) throw new Error('No vault selected');
    if (
      typeof relativePath !== 'string' ||
      !relativePath ||
      path.isAbsolute(relativePath)
    ) {
      throw new Error('Invalid note path');
    }

    const segments = relativePath.split(/[\\/]+/);
    if (
      segments.some(
        (segment) => !segment || segment === '.' || segment === '..',
      )
    ) {
      throw new Error('Invalid note path');
    }
    if (!relativePath.toLowerCase().endsWith('.md'))
      throw new Error('Only Markdown notes can be read');

    const { resolved: realNotePath } = await resolveVaultEntry(
      vaultPath,
      relativePath,
      { symlinks: 'reject', type: 'file' },
    );
    if (!realNotePath.toLowerCase().endsWith('.md'))
      throw new Error('Not a Markdown note');
    const content = await readFile(realNotePath, 'utf8');
    return { path: segments.join('/'), content, revision: revisionOf(content) };
  }

  async saveNote(request: unknown): Promise<SaveNoteResult> {
    if (!request || typeof request !== 'object')
      throw new Error('Invalid save request');
    const {
      vaultPath,
      path: relativePath,
      content,
      revision,
    } = request as SaveNoteRequest;
    const root = this.selectedVaultPath;
    if (!root || vaultPath !== root)
      throw new Error('Selected vault changed; save cancelled');
    if (
      typeof relativePath !== 'string' ||
      typeof content !== 'string' ||
      typeof revision !== 'string'
    )
      throw new Error('Invalid save request');
    const identity = await realpath(
      path.resolve(root, ...relativePath.split(/[\\/]+/)),
    );
    return noteWrites.run(identity, async () => {
      if (this.selectedVaultPath !== root)
        throw new Error('Selected vault changed; save cancelled');
      const current = await this.readNote(relativePath);
      if (current.revision !== revision)
        throw new Error('Note changed outside Storm; reload before saving');
      const rootReal = await realpath(root);
      const target = path.resolve(rootReal, ...current.path.split('/'));
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error('Not a regular Markdown note');
      const temp = path.join(
        path.dirname(target),
        `.${path.basename(target)}.${randomUUID()}.tmp`,
      );
      try {
        await writeFile(temp, content, { flag: 'wx', mode: info.mode });
        await chmod(temp, info.mode);
        if (this.selectedVaultPath !== root)
          throw new Error('Selected vault changed; save cancelled');
        const latest = await readFile(target, 'utf8');
        if (revisionOf(latest) !== revision)
          throw new Error('Note changed outside Storm; reload before saving');
        await rename(temp, target);
      } finally {
        await unlink(temp).catch(() => {});
      }
      return { revision: revisionOf(content) };
    });
  }
}

function revisionOf(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
