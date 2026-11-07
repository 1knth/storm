import { readFile } from 'node:fs/promises';
import path from 'node:path';

const SETTINGS_FILE = 'settings.json';

export async function readLastVault(
  userDataPath: string,
): Promise<string | null> {
  let contents: string;
  try {
    contents = await readFile(path.join(userDataPath, SETTINGS_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  try {
    const settings: unknown = JSON.parse(contents);
    if (
      settings &&
      typeof settings === 'object' &&
      'lastVaultPath' in settings &&
      typeof settings.lastVaultPath === 'string' &&
      path.isAbsolute(settings.lastVaultPath)
    ) {
      return settings.lastVaultPath;
    }
  } catch {
    // A malformed preference should not prevent the app from opening.
  }
  return null;
}
