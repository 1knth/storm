import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
type RunCommand = (command: string, args: string[]) => Promise<unknown>;

export async function repairDarwinBundleSignatures(
  platform: string,
  outputPaths: string[],
  signingConfigured: boolean,
  runCommand: RunCommand = execFileAsync,
): Promise<void> {
  if (platform !== 'darwin' || signingConfigured) return;

  for (const outputPath of outputPaths) {
    const appPaths = outputPath.endsWith('.app')
      ? [outputPath]
      : (await readdir(outputPath, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
          .map((entry) => path.join(outputPath, entry.name));
    if (appPaths.length === 0) {
      throw new Error(
        `No macOS app bundle found in package output: ${outputPath}`,
      );
    }

    for (const appPath of appPaths) {
      await runCommand('codesign', [
        '--force',
        '--deep',
        '--sign',
        '-',
        '--identifier',
        'com.electron.storm',
        appPath,
      ]);
      await runCommand('codesign', ['--verify', '--deep', '--strict', appPath]);
    }
  }
}
