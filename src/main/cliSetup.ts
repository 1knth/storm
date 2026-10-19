import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  symlink,
  writeFile,
  unlink,
} from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const STATE_VERSION = 1;
const DESTINATION = '/usr/local/bin/storm';
type Choice = 'pending' | 'declined' | 'enabled' | 'failed';
interface State {
  version: number;
  choice: Choice;
}
interface SetupOptions {
  resourcesPath: string;
  destination?: string;
  authorize?: (source: string, destination: string) => Promise<boolean>;
  createLink?: (source: string, destination: string) => Promise<void>;
  platform?: NodeJS.Platform;
}

export async function readCliSetupState(file: string): Promise<State | null> {
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!value || typeof value !== 'object') return null;
    const state = value as Partial<State>;
    if (
      state.version !== STATE_VERSION ||
      !['pending', 'declined', 'enabled', 'failed'].includes(
        String(state.choice),
      )
    )
      return null;
    return state as State;
  } catch {
    return null;
  }
}

async function saveState(file: string, choice: Choice): Promise<void> {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify({ version: STATE_VERSION, choice }, null, 2)}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  try {
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function appleScriptQuote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export async function authorizeCliLink(
  source: string,
  destination: string,
): Promise<boolean> {
  const command = `/bin/mkdir -p /usr/local/bin && /bin/ln -s ${shellQuote(source)} ${shellQuote(destination)}`;
  const script = `do shell script ${appleScriptQuote(command)} with administrator privileges`;
  try {
    await execFileAsync('/usr/bin/osascript', ['-e', script]);
    return true;
  } catch {
    return false;
  }
}

async function bundledLauncher(resourcesPath: string): Promise<string> {
  const root = await realpath(path.join(resourcesPath, 'cli'));
  const launcher = path.join(root, 'storm');
  const resolved = await realpath(launcher);
  if (!resolved.startsWith(`${root}${path.sep}`))
    throw new Error(
      'Bundled Storm CLI launcher resolves outside its app resources.',
    );
  const info = await lstat(launcher);
  if (!info.isFile() || !(info.mode & 0o111))
    throw new Error('Bundled Storm CLI launcher is missing or not executable.');
  return resolved;
}

export async function installCliShortcut(
  options: SetupOptions,
): Promise<{ installed: boolean; message?: string }> {
  if ((options.platform ?? process.platform) !== 'darwin')
    return {
      installed: false,
      message:
        'Automatic CLI setup is supported only on macOS. Use the bundled CLI launcher directly.',
    };
  const source = await bundledLauncher(options.resourcesPath);
  if (source.includes('/AppTranslocation/'))
    return {
      installed: false,
      message:
        'Move Storm to /Applications before enabling the CLI, then retry from the Storm menu.',
    };
  const destination = options.destination ?? DESTINATION;
  if (options.destination)
    await mkdir(path.dirname(destination), { recursive: true });
  try {
    const existing = await lstat(destination);
    if (
      existing.isSymbolicLink() &&
      (await realpath(destination).catch(() => '')) === source
    )
      return { installed: true };
    return {
      installed: false,
      message: `${destination} already exists and was not changed. Remove or rename it yourself, then retry Enable CLI….`,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    await (options.createLink ?? symlink)(source, destination);
    return { installed: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EACCES' && code !== 'EPERM') {
      if (code === 'EEXIST')
        return {
          installed: false,
          message: `${destination} already exists and was not changed.`,
        };
      throw error;
    }
  }
  const authorized = await (options.authorize ?? authorizeCliLink)(
    source,
    destination,
  );
  if (!authorized)
    return {
      installed: false,
      message:
        'Administrator authorization was cancelled or the shortcut could not be created. You can retry from the Storm menu.',
    };
  try {
    const info = await lstat(destination);
    if (
      info.isSymbolicLink() &&
      (await realpath(destination).catch(() => '')) === source
    )
      return { installed: true };
    return {
      installed: false,
      message: `${destination} already exists and was not changed.`,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return {
    installed: false,
    message:
      'The CLI shortcut could not be verified. Retry from the Storm menu.',
  };
}

export async function recordCliChoice(
  userDataPath: string,
  choice: Choice,
): Promise<void> {
  await saveState(path.join(userDataPath, 'cli-setup.json'), choice);
}
