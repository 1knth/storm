import path from 'node:path';
export const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
};

export function isSupportedVaultImagePath(filePath: string): boolean {
  return Object.hasOwn(MIME_BY_EXTENSION, path.extname(filePath).toLowerCase());
}

export function vaultImageMimeType(filename: string): string | null {
  return MIME_BY_EXTENSION[path.extname(filename).toLowerCase()] ?? null;
}
