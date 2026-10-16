import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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

export async function writeLastVault(
  userDataPath: string,
  vaultPath: string,
): Promise<void> {
  const settingsFile = path.join(userDataPath, SETTINGS_FILE);
  let settings: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(settingsFile, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  settings.lastVaultPath = vaultPath;
  await mkdir(userDataPath, { recursive: true });
  const temporary = `${settingsFile}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
    flag: 'wx',
  });
  await rename(temporary, settingsFile);
}
