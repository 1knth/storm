import { execFile } from 'node:child_process';
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

  for (const appPath of outputPaths) {
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
