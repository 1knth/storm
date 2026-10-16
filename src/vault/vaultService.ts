import path from 'node:path';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import type { NoteData, VaultEntry } from '../shared/types';

export class VaultService {
  private selectedVaultPath: string | null = null;

  selectVault(vaultPath: string | null): void {
    this.selectedVaultPath = vaultPath;
  }

  async listNotes(): Promise<VaultEntry[]> {
    const rootPath = this.selectedVaultPath;
    if (!rootPath) return [];

    const notes: VaultEntry[] = [];
    async function walk(directory: string, relativeDirectory = ''): Promise<void> {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const relativePath = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
        if (entry.isDirectory()) {
          if (!['.obsidian', '.git', 'node_modules'].includes(entry.name)) {
            notes.push({ path: relativePath, name: entry.name, isDirectory: true, peek: '' });
            await walk(path.join(directory, entry.name), relativePath);
          }
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          let peek = '';
          try {
            peek = firstSentence(await readFile(path.join(directory, entry.name), 'utf8'));
          } catch {
            // Keep an unreadable note in the list without a preview.
          }
          notes.push({ path: relativePath, name: entry.name, isDirectory: false, peek });
        }
      }
    }

    await walk(rootPath);
    return notes.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.path.localeCompare(b.path));
  }

  async readNote(relativePath: unknown): Promise<NoteData> {
    const vaultPath = this.selectedVaultPath;
    if (!vaultPath) throw new Error('No vault selected');
    if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) {
      throw new Error('Invalid note path');
    }

    const segments = relativePath.split(/[\\/]+/);
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
      throw new Error('Invalid note path');
    }
    if (!relativePath.toLowerCase().endsWith('.md')) throw new Error('Only Markdown notes can be read');

    const root = await realpath(vaultPath);
    const notePath = path.resolve(root, ...segments);
    const relativeToRoot = path.relative(root, notePath);
    if (!relativeToRoot || relativeToRoot.startsWith(`..${path.sep}`) || relativeToRoot === '..' || path.isAbsolute(relativeToRoot)) {
      throw new Error('Note path is outside the selected vault');
    }
    const [realNotePath, stat] = await Promise.all([realpath(notePath), lstat(notePath)]);
    const realRelative = path.relative(root, realNotePath);
    if (realRelative.startsWith(`..${path.sep}`) || realRelative === '..' || path.isAbsolute(realRelative)) {
      throw new Error('Note path is outside the selected vault');
    }
    if (!stat.isFile() || !realNotePath.toLowerCase().endsWith('.md')) throw new Error('Not a Markdown note');

    return { path: segments.join('/'), content: await readFile(realNotePath, 'utf8') };
  }
}

function firstSentence(markdown: string): string {
  const withoutFrontmatter = markdown.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
  const prose = withoutFrontmatter
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#'));
  if (!prose) return '';

  const text = prose.replace(/^(?:[-*+]\s+|\d+[.)]\s+|>\s*)+/, '').trim();
  const sentenceEnd = text.match(/[.!?](?:[”’"')\]]*)?(?:\s|$)/);
  return sentenceEnd ? text.slice(0, sentenceEnd.index! + sentenceEnd[0].trimEnd().length).trim() : text;
}
