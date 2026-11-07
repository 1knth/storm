import path from 'node:path';
import { open, readdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import type { VaultEntry } from '../shared/types';
import {
  isSupportedVaultImagePath,
  vaultImageMimeType,
} from './vaultImageTypes';

export async function enumerateVault(
  rootPath: string,
  options: {
    previews?: boolean;
    limit?: number;
    maxVisited?: number;
    maxDepth?: number;
  } = {},
): Promise<VaultEntry[]> {
  const notes: VaultEntry[] = [];
  let visited = 0;
  async function walk(
    directory: string,
    relativeDirectory = '',
    depth = 0,
  ): Promise<void> {
    if (depth > (options.maxDepth ?? Infinity)) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (++visited > (options.maxVisited ?? Infinity))
        throw new Error('Image lookup exceeded its scan limit');
      if (notes.length >= (options.limit ?? Infinity)) return;
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
          await walk(path.join(directory, entry.name), relativePath, depth + 1);
        }
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        let peek = '';
        if (options.previews === true) {
          let file;
          try {
            file = await open(
              path.join(directory, entry.name),
              fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
            );
            const buffer = Buffer.alloc(16 * 1024);
            const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
            peek = firstSentence(buffer.toString('utf8', 0, bytesRead)).slice(
              0,
              300,
            );
          } catch {
            // Keep an unreadable note in the list without a preview.
          } finally {
            await file?.close().catch(() => {});
          }
        }
        notes.push({
          path: relativePath,
          name: entry.name,
          kind: 'note',
          isDirectory: false,
          peek,
        });
      } else if (entry.isFile() && isSupportedVaultImagePath(entry.name)) {
        notes.push({
          path: relativePath,
          name: entry.name,
          kind: 'image',
          isDirectory: false,
          peek: '',
          mimeType: vaultImageMimeType(entry.name)!,
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

export class VaultNoteIndex {
  readonly paths = new Map<string, string[]>();
  readonly basenames = new Map<string, string[]>();
  constructor(files: readonly string[]) {
    for (const file of files) {
      for (const [map, key] of [
        [this.paths, file.toLowerCase()],
        [this.basenames, path.posix.basename(file).toLowerCase()],
      ] as const) {
        const values = map.get(key) ?? [];
        values.push(file);
        map.set(key, values);
      }
    }
  }
}
