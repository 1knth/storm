import path from 'node:path';
import { mkdir, lstat, open, realpath } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import type { PasteImageRequest, PasteImageResult } from '../shared/types';

const MAX_BYTES = 10 * 1024 * 1024;
const formats = [
  {
    mime: 'image/png',
    extension: 'png',
    valid: (b: Buffer) =>
      b.length >= 8 &&
      b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  },
  {
    mime: 'image/jpeg',
    extension: 'jpg',
    valid: (b: Buffer) =>
      b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255,
  },
  {
    mime: 'image/gif',
    extension: 'gif',
    valid: (b: Buffer) => b.subarray(0, 3).toString() === 'GIF',
  },
  {
    mime: 'image/webp',
    extension: 'webp',
    valid: (b: Buffer) =>
      b.length >= 12 &&
      b.toString('ascii', 0, 4) === 'RIFF' &&
      b.toString('ascii', 8, 12) === 'WEBP',
  },
  {
    mime: 'image/avif',
    extension: 'avif',
    valid: (b: Buffer) =>
      b.length >= 12 &&
      b.toString('ascii', 4, 8) === 'ftyp' &&
      ['avif', 'avis'].includes(b.toString('ascii', 8, 12)),
  },
];
function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export async function savePastedImage(
  rootPath: string,
  request: PasteImageRequest,
): Promise<PasteImageResult> {
  if (
    !request ||
    typeof request !== 'object' ||
    typeof request.notePath !== 'string' ||
    !request.notePath ||
    path.isAbsolute(request.notePath)
  )
    throw new Error('Invalid note path');
  const segments = request.notePath.split(/[\\/]+/);
  if (
    segments.some((part) => !part || part === '.' || part === '..') ||
    !request.notePath.toLowerCase().endsWith('.md')
  )
    throw new Error('Paste requires a saved Markdown note inside the vault');
  const root = await realpath(rootPath);
  const note = path.resolve(root, ...segments);
  if (!inside(root, note)) throw new Error('Note path is outside the vault');
  const noteInfo = await lstat(note);
  if (
    !noteInfo.isFile() ||
    noteInfo.isSymbolicLink() ||
    !inside(root, await realpath(note))
  )
    throw new Error('Paste requires a regular Markdown note inside the vault');
  if (
    typeof request.mimeType !== 'string' ||
    typeof request.base64 !== 'string' ||
    request.base64.length > Math.ceil((MAX_BYTES * 4) / 3) + 8 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      request.base64,
    )
  )
    throw new Error('Invalid clipboard image data');
  const bytes = Buffer.from(request.base64, 'base64');
  if (!bytes.length || bytes.length > MAX_BYTES)
    throw new Error('Clipboard image exceeds the 10 MB limit');
  const format = formats.find(
    (item) => item.mime === request.mimeType && item.valid(bytes),
  );
  if (!format)
    throw new Error(
      'Unsupported or invalid clipboard image (PNG, JPEG, GIF, WebP, and AVIF are supported)',
    );
  const directory = path.join(path.dirname(note), 'images');
  try {
    await mkdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const directoryInfo = await lstat(directory);
  if (
    !directoryInfo.isDirectory() ||
    directoryInfo.isSymbolicLink() ||
    !inside(root, await realpath(directory))
  )
    throw new Error(
      'The note images folder must be a real folder inside the vault; move or remove the unsafe path first.',
    );
  for (let attempt = 0; attempt < 8; attempt++) {
    const filename = `Pasted-image-${Date.now()}-${randomBytes(3).toString('hex')}.${format.extension}`;
    const target = path.join(directory, filename);
    try {
      const file = await open(target, 'wx', 0o600);
      try {
        await file.writeFile(bytes);
      } finally {
        await file.close();
      }
      return { imagePath: `images/${filename}` };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error(
    'Could not create a unique pasted image filename; try again.',
  );
}
