import path from 'node:path';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';

export type VaultImageKind = 'markdown' | 'wiki';
export interface VaultImageRequest {
  vaultId: string;
  notePath: string;
  imagePath: string;
  kind?: VaultImageKind;
}
export interface VaultImageResult {
  mimeType: string;
  base64: string;
}

const MAX_BYTES = 10 * 1024 * 1024;
export const MAX_PDF_BYTES = 100 * 1024 * 1024;
const MAX_SCAN_ENTRIES = 5000;
const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
};

export async function readVaultPdf(
  rootPath: string,
  relativePath: unknown,
): Promise<Uint8Array> {
  const root = await realpath(rootPath);
  if (
    typeof relativePath !== 'string' ||
    !relativePath ||
    relativePath.length > 2048 ||
    path.isAbsolute(relativePath)
  )
    throw new Error('Invalid PDF path');
  const segments = relativePath.split(/[\\/]+/);
  if (
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  )
    throw new Error('Invalid PDF path');
  const target = path.resolve(root, ...segments);
  if (!inside(root, target)) throw new Error('PDF path is outside the vault');
  if (path.extname(target).toLowerCase() !== '.pdf')
    throw new Error('Unsupported PDF type');
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error('PDF is not a regular file');
  if (!inside(root, await realpath(target)))
    throw new Error('PDF path is outside the vault');
  if (info.size > MAX_PDF_BYTES)
    throw new Error('PDF exceeds the 100 MB size limit');
  const content = await readFile(target);
  if (content.length > MAX_PDF_BYTES)
    throw new Error('PDF exceeds the 100 MB size limit');
  if (content.subarray(0, 5).toString('ascii') !== '%PDF-')
    throw new Error('Invalid PDF file');
  return new Uint8Array(content);
}

export function isSupportedVaultImagePath(filePath: string): boolean {
  return Object.hasOwn(MIME_BY_EXTENSION, path.extname(filePath).toLowerCase());
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function safeImageName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048)
    throw new Error('Invalid image path');
  let name = value.trim();
  try {
    name = decodeURIComponent(name);
  } catch {
    throw new Error('Invalid image path');
  }
  if (/^(?:[a-z][a-z\d+.-]*:|\\\\|\/\/)/i.test(name))
    throw new Error('Image path must be vault-relative');
  return name;
}

function verifyImage(bytes: Buffer, extension: string): string {
  const mime = MIME_BY_EXTENSION[extension.toLowerCase()];
  if (!mime)
    throw new Error(
      'Unsupported image type (SVG and other formats are not supported)',
    );
  const valid =
    extension.toLowerCase() === '.png'
      ? bytes.length >= 8 &&
        bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : ['.jpg', '.jpeg'].includes(extension.toLowerCase())
        ? bytes.length >= 3 &&
          bytes[0] === 0xff &&
          bytes[1] === 0xd8 &&
          bytes[2] === 0xff
        : extension.toLowerCase() === '.gif'
          ? bytes.subarray(0, 3).toString() === 'GIF'
          : extension.toLowerCase() === '.webp'
            ? bytes.length >= 12 &&
              bytes.toString('ascii', 0, 4) === 'RIFF' &&
              bytes.toString('ascii', 8, 12) === 'WEBP'
            : bytes.length >= 12 &&
              bytes.toString('ascii', 4, 8) === 'ftyp' &&
              ['avif', 'avis'].includes(bytes.toString('ascii', 8, 12));
  if (!valid) throw new Error('Image content does not match its file type');
  return mime;
}

export async function readVaultAsset(
  rootPath: string,
  relativePath: unknown,
): Promise<VaultImageResult> {
  const root = await realpath(rootPath);
  if (
    typeof relativePath !== 'string' ||
    !relativePath ||
    relativePath.length > 2048 ||
    path.isAbsolute(relativePath)
  )
    throw new Error('Invalid asset path');
  const segments = relativePath.split(/[\\/]+/);
  if (
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  )
    throw new Error('Invalid asset path');
  const target = path.resolve(root, ...segments);
  if (!inside(root, target)) throw new Error('Asset path is outside the vault');
  const extension = path.extname(target).toLowerCase();
  if (!MIME_BY_EXTENSION[extension]) throw new Error('Unsupported image type');
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error('Asset is not a regular file');
  const realTarget = await realpath(target);
  if (!inside(root, realTarget))
    throw new Error('Asset path is outside the vault');
  if (info.size > MAX_BYTES)
    throw new Error('Image exceeds the 10 MB size limit');
  const content = await readFile(realTarget);
  if (content.length > MAX_BYTES)
    throw new Error('Image exceeds the 10 MB size limit');
  return {
    mimeType: verifyImage(content, extension),
    base64: content.toString('base64'),
  };
}

export async function readVaultImage(
  rootPath: string,
  request: Omit<VaultImageRequest, 'vaultId'>,
): Promise<VaultImageResult> {
  const root = await realpath(rootPath);
  const image = safeImageName(request.imagePath);
  const kind = request.kind ?? 'markdown';
  if (kind !== 'markdown' && kind !== 'wiki')
    throw new Error('Invalid image kind');
  if (
    typeof request.notePath !== 'string' ||
    !request.notePath ||
    path.isAbsolute(request.notePath)
  )
    throw new Error('Invalid note path');
  const note = path.resolve(root, request.notePath);
  if (!inside(root, note)) throw new Error('Note path is outside the vault');
  let candidates: string[] = [];
  const rootRelative = image.replace(/^[/\\]+/, '').replace(/\\/g, path.sep);
  if (
    kind === 'wiki' &&
    !rootRelative.includes('/') &&
    !rootRelative.includes(path.sep)
  ) {
    const noteDirectory = path.dirname(note);
    const preferred = path.join(noteDirectory, 'images', rootRelative);
    const besideNote = path.join(noteDirectory, rootRelative);
    const vaultRoot = path.join(root, rootRelative);
    const localCandidates = [preferred, besideNote, vaultRoot];
    const localMatches = await existingSafe(localCandidates, root);
    if (localMatches.length) {
      // A deterministic local match wins over unrelated duplicate basenames.
      candidates = [localMatches[0]];
    } else {
      candidates = await findBareImage(root, rootRelative);
    }
  } else {
    const target =
      image.startsWith('/') || image.startsWith('\\')
        ? path.resolve(root, rootRelative)
        : path.resolve(path.dirname(note), image);
    if (!inside(root, target))
      throw new Error('Image path is outside the vault');
    candidates = [target];
    if (
      kind === 'wiki' &&
      !image.startsWith('/') &&
      !image.startsWith('\\\\')
    ) {
      const vaultTarget = path.resolve(root, rootRelative);
      if (vaultTarget !== target) candidates.push(vaultTarget);
    }
  }
  let files = await existingSafe(candidates, root);
  if (kind === 'wiki' && files.length > 1 && candidates.length > 1) {
    files = await existingSafe([candidates[0]], root);
  }
  if (files.length !== 1)
    throw new Error(files.length ? 'Ambiguous image path' : 'Image not found');
  const file = files[0];
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error('Image is not a regular file');
  if (info.size > MAX_BYTES)
    throw new Error('Image exceeds the 10 MB size limit');
  const content = await readFile(file);
  if (content.length > MAX_BYTES)
    throw new Error('Image exceeds the 10 MB size limit');
  const realFile = await realpath(file);
  if (!inside(root, realFile))
    throw new Error('Image path is outside the vault');
  return {
    mimeType: verifyImage(content, path.extname(file)),
    base64: content.toString('base64'),
  };
}

async function existingSafe(paths: string[], root: string): Promise<string[]> {
  const found: string[] = [];
  for (const candidate of paths) {
    if (!inside(root, candidate)) continue;
    try {
      const resolved = await realpath(candidate);
      if (!inside(root, resolved))
        throw new Error('Image path is outside the vault');
      const info = await lstat(candidate);
      if (info.isSymbolicLink())
        throw new Error('Symbolic-link images are not supported');
      if (info.isFile()) found.push(candidate);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
        (error as NodeJS.ErrnoException).code !== 'ENOTDIR'
      )
        throw error;
    }
  }
  return found;
}

async function findBareImage(root: string, name: string): Promise<string[]> {
  const found: string[] = [];
  let visited = 0;
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 12) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++visited > MAX_SCAN_ENTRIES)
        throw new Error('Image lookup exceeded its scan limit');
      if (entry.isSymbolicLink()) continue;
      const target = path.join(directory, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase())
        found.push(target);
      else if (
        entry.isDirectory() &&
        !['.obsidian', '.git', 'node_modules'].includes(entry.name)
      )
        await walk(target, depth + 1);
    }
  }
  await walk(root, 0);
  if (found.length > 1) throw new Error('Ambiguous image path');
  return found;
}
