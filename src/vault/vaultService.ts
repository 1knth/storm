import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { planRenameLinks } from './renameLinks';
import type {
  NoteData,
  SaveNoteRequest,
  SaveNoteResult,
  VaultEntry,
} from '../shared/types';

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

  async listNotes(): Promise<VaultEntry[]> {
    const rootPath = this.selectedVaultPath;
    if (!rootPath) return [];

    const notes: VaultEntry[] = [];
    async function walk(
      directory: string,
      relativeDirectory = '',
    ): Promise<void> {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const relativePath = relativeDirectory
          ? path.join(relativeDirectory, entry.name)
          : entry.name;
        if (entry.isDirectory()) {
          if (!['.obsidian', '.git', 'node_modules'].includes(entry.name)) {
            notes.push({
              path: relativePath,
              name: entry.name,
              kind: 'directory',
              isDirectory: true,
              peek: '',
            });
            await walk(path.join(directory, entry.name), relativePath);
          }
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          let peek = '';
          try {
            peek = firstSentence(
              await readFile(path.join(directory, entry.name), 'utf8'),
            );
          } catch {
            // Keep an unreadable note in the list without a preview.
          }
          notes.push({
            path: relativePath,
            name: entry.name,
            kind: 'note',
            isDirectory: false,
            peek,
          });
        } else if (entry.isFile() && isSupportedImage(entry.name)) {
          notes.push({
            path: relativePath,
            name: entry.name,
            kind: 'image',
            isDirectory: false,
            peek: '',
            mimeType: imageMimeType(entry.name)!,
          });
        } else if (
          entry.isFile() &&
          path.extname(entry.name).toLowerCase() === '.pdf'
        ) {
          notes.push({
            path: relativePath,
            name: entry.name,
            kind: 'pdf',
            isDirectory: false,
            peek: '',
          });
        }
      }
    }

    await walk(rootPath);
    return notes.sort(
      (a, b) =>
        Number(b.isDirectory) - Number(a.isDirectory) ||
        a.path.localeCompare(b.path),
    );
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

    let current = rootReal;
    for (const segment of segments) {
      current = path.join(current, segment);
      const info = await lstat(current);
      if (info.isSymbolicLink())
        throw new Error('Cannot rename through symbolic links');
    }
    const sourceInfo = await lstat(source);
    if (!sourceInfo.isFile() && !sourceInfo.isDirectory())
      throw new Error('Unsupported rename entry');
    const kind = sourceInfo.isDirectory()
      ? 'directory'
      : source.toLowerCase().endsWith('.md')
        ? 'note'
        : isSupportedImage(source)
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
    // Reject invalid requests before scanning unrelated notes for link rewrites.
    const move = await this.validateRenameEntry(relativePath, newBaseName);
    const root = this.selectedVaultPath;
    if (!root) throw new Error('No vault selected');
    if (move.kind === 'pdf') {
      const renamed = await this.renameEntry(
        move.oldPath,
        path.posix.basename(move.newPath),
      );
      return { ...renamed, changedNotes: [] };
    }
    const entries = await this.listNotes();
    const documents: { path: string; content: string; revision: string }[] = [];
    for (const entry of entries) {
      if (entry.kind !== 'note') continue;
      const note = await this.readNote(entry.path);
      documents.push(note);
    }
    // Compute all rewrites before the first mutation.
    const plans = planRenameLinks(documents, move.oldPath, move.newPath);
    const changes = plans.flatMap((plan) => {
      const oldPath =
        plan.path === move.newPath || plan.path.startsWith(`${move.newPath}/`)
          ? move.oldPath + plan.path.slice(move.newPath.length)
          : plan.path;
      const original = documents.find((doc) => doc.path === oldPath);
      return original && original.content !== plan.content
        ? [
            {
              oldPath,
              newPath: plan.path,
              before: original.content,
              after: plan.content,
              revision: original.revision,
            },
          ]
        : [];
    });
    if (move.oldPath === move.newPath) return { ...move, changedNotes: [] };

    // Revalidate every document used for resolution, not just documents being edited.
    for (const doc of documents) {
      const latest = await this.readNote(doc.path);
      if (latest.revision !== doc.revision)
        throw new Error(
          `Rename aborted: note changed during link planning (${doc.path})`,
        );
    }
    await this.renameEntry(move.oldPath, path.posix.basename(move.newPath));
    const written: {
      path: string;
      before: string;
      after: string;
      revision: string;
    }[] = [];
    try {
      for (const change of changes) {
        const current = await this.readNote(change.newPath);
        if (current.revision !== change.revision)
          throw new Error(
            `Rename aborted: note changed before rewrite (${change.newPath})`,
          );
        await this.saveNote({
          vaultPath: root,
          path: change.newPath,
          content: change.after,
          revision: current.revision,
        });
        written.push({
          path: change.newPath,
          before: change.before,
          after: change.after,
          revision: revisionOf(change.after),
        });
      }
    } catch (error) {
      const recovery: string[] = [];
      for (const item of written.reverse()) {
        try {
          const current = await this.readNote(item.path);
          if (current.revision !== item.revision)
            throw new Error('revision changed');
          await this.saveNote({
            vaultPath: root,
            path: item.path,
            content: item.before,
            revision: current.revision,
          });
        } catch {
          recovery.push(item.path);
        }
      }
      if (recovery.length)
        throw new Error(
          `Rename failed; rollback incomplete. Recoverable paths: ${[move.newPath, ...recovery].join(', ')}. Original error: ${String(error)}`,
        );
      try {
        await this.renameEntry(move.newPath, path.posix.basename(move.oldPath));
      } catch {
        throw new Error(
          `Rename failed; rollback incomplete. Recoverable path: ${move.newPath}. Original error: ${String(error)}`,
        );
      }
      throw error;
    }
    const changedNotes = changes.map((change) => ({
      oldPath: change.oldPath,
      newPath: change.newPath,
      oldContent: change.before,
      newContent: change.after,
      oldRevision: change.revision,
      newRevision: revisionOf(change.after),
      path: change.newPath,
      content: change.after,
      revision: revisionOf(change.after),
    }));
    return { ...move, changedNotes };
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

    const root = await realpath(vaultPath);
    const notePath = path.resolve(root, ...segments);
    const relativeToRoot = path.relative(root, notePath);
    if (
      !relativeToRoot ||
      relativeToRoot.startsWith(`..${path.sep}`) ||
      relativeToRoot === '..' ||
      path.isAbsolute(relativeToRoot)
    ) {
      throw new Error('Note path is outside the selected vault');
    }
    const [realNotePath, stat] = await Promise.all([
      realpath(notePath),
      lstat(notePath),
    ]);
    const realRelative = path.relative(root, realNotePath);
    if (
      realRelative.startsWith(`..${path.sep}`) ||
      realRelative === '..' ||
      path.isAbsolute(realRelative)
    ) {
      throw new Error('Note path is outside the selected vault');
    }
    if (!stat.isFile() || !realNotePath.toLowerCase().endsWith('.md'))
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
    if (typeof content !== 'string' || typeof revision !== 'string')
      throw new Error('Invalid save request');
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
  }
}

function imageMimeType(filename: string): string | null {
  const extension = path.extname(filename).toLowerCase();
  return (
    {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.avif': 'image/avif',
    }[extension] ?? null
  );
}

function isSupportedImage(filename: string): boolean {
  return imageMimeType(filename) !== null;
}

function revisionOf(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function firstSentence(markdown: string): string {
  const withoutFrontmatter = markdown.replace(
    /^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,
    '',
  );
  let fence: { character: string; length: number } | null = null;
  const prose = withoutFrontmatter
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => {
      if (fence) {
        const closingFence = line.match(/^(`+|~+)\s*$/);
        if (
          closingFence &&
          closingFence[1][0] === fence.character &&
          closingFence[1].length >= fence.length
        ) {
          fence = null;
          return false;
        }
        return Boolean(line);
      }

      const openingFence = line.match(/^(`{3,}|~{3,})(.*)$/);
      if (
        openingFence &&
        !(/`/.test(openingFence[2]) && openingFence[1][0] === '`')
      ) {
        fence = {
          character: openingFence[1][0],
          length: openingFence[1].length,
        };
        return false;
      }
      return line && !line.startsWith('#');
    });
  if (!prose) return '';

  const text = prose.replace(/^(?:[-*+]\s+|\d+[.)]\s+|>\s*)+/, '').trim();
  const sentenceEnd = text.match(/[.!?](?:[”’"')\]]*)?(?:\s|$)/);
  return sentenceEnd
    ? text.slice(0, sentenceEnd.index! + sentenceEnd[0].trimEnd().length).trim()
    : text;
}
