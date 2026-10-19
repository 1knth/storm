import { chmod, copyFile, mkdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

export function assertNativeTarget(
  platform: string,
  arch: string,
  hostPlatform = process.platform,
  hostArch = os.arch(),
): void {
  const expectedPlatform = hostPlatform === 'win32' ? 'win32' : hostPlatform;
  const expectedArch =
    hostArch === 'x64' ? 'x64' : hostArch === 'arm64' ? 'arm64' : hostArch;
  if (platform !== expectedPlatform || arch !== expectedArch)
    throw new Error(
      `Standalone Storm CLI builds only for the current host (${expectedPlatform}-${expectedArch}); requested ${platform}-${arch}. No cross-target runtime download is attempted.`,
    );
}

export async function buildCliBinary(
  platform: string,
  arch: string,
  options: {
    root?: string;
    sourceRoot?: string;
    run?: typeof spawnSync;
    hostPlatform?: NodeJS.Platform;
    hostArch?: NodeJS.Architecture;
    bunPath?: string;
  } = {},
): Promise<string> {
  assertNativeTarget(platform, arch, options.hostPlatform, options.hostArch);
  const root = options.root ?? process.cwd();
  const sourceRoot = options.sourceRoot ?? root;
  const outputDirectory = path.join(root, 'build', 'cli');
  const output = path.join(outputDirectory, 'storm');
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(path.join(outputDirectory, 'runtime'), { recursive: true });
  const run = options.run ?? spawnSync;
  let candidatePath = options.bunPath;
  if (!candidatePath && process.versions.bun) candidatePath = process.execPath;
  if (!candidatePath) {
    const discovered = run('bun', ['--print', 'process.execPath'], {
      cwd: sourceRoot,
      encoding: 'utf8',
      shell: false,
    });
    if (discovered.error || discovered.status !== 0)
      throw new Error(
        'Building the standalone Storm CLI requires Bun 1.3.12. Install the reviewed Bun runtime or provide its executable path.',
      );
    candidatePath = String(discovered.stdout).trim();
    if (!candidatePath || candidatePath.includes('\\0'))
      throw new Error('Bun did not report a valid executable path.');
  }
  const bunPath = await realpath(candidatePath);
  const version = run(bunPath, ['--version'], {
    cwd: sourceRoot,
    encoding: 'utf8',
    shell: false,
  });
  if (version.error) throw version.error;
  if (version.status !== 0 || !/^1\.3\.12\b/.test(String(version.stdout)))
    throw new Error(
      `Refusing unverified Bun runtime at ${bunPath}: ${String(version.stdout).trim()}`,
    );
  const licenseDirectory = path.join(outputDirectory, 'licenses');
  await mkdir(licenseDirectory, { recursive: true });
  await copyFile(
    path.join(sourceRoot, 'resources', 'cli', 'licenses', 'BUN-LICENSE.md'),
    path.join(licenseDirectory, 'BUN-LICENSE.md'),
  );
  await copyFile(
    path.join(sourceRoot, 'resources', 'cli', 'licenses', 'README.md'),
    path.join(licenseDirectory, 'README.md'),
  );
  await copyFile(bunPath, path.join(outputDirectory, 'runtime', 'bun'));
  await chmod(path.join(outputDirectory, 'runtime', 'bun'), 0o755);
  const sourceRuntime = path.join(sourceRoot, 'scripts', 'storm.ts');
  const result = run(
    bunPath,
    [
      'build',
      '--target=bun',
      '--outfile',
      path.join(outputDirectory, 'storm.mjs'),
      sourceRuntime,
    ],
    { cwd: sourceRoot, stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `Bun standalone CLI compilation failed with exit code ${result.status}`,
    );
  await copyFile(path.join(sourceRoot, 'scripts', 'cli-launcher.sh'), output);
  await chmod(output, 0o755);
  return output;
}

if (import.meta.main) {
  const platform = process.argv[2] ?? process.platform;
  const arch = process.argv[3] ?? (os.arch() === 'x64' ? 'x64' : os.arch());
  buildCliBinary(platform, arch).then(
    (output) => console.log(`Built standalone Storm CLI: ${output}`),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
