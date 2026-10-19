import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installCliShortcut,
  readCliSetupState,
  recordCliChoice,
} from './cliSetup';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'storm-cli-setup-'));
  const resources = path.join(root, 'Resources');
  const cli = path.join(resources, 'cli');
  const bin = path.join(root, 'bin');
  await mkdir(cli, { recursive: true });
  await mkdir(bin);
  const launcher = path.join(cli, 'storm');
  await writeFile(launcher, '#!/bin/sh\n');
  await chmod(launcher, 0o755);
  return {
    root,
    resources,
    launcher,
    destination: path.join(bin, 'storm'),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

describe('packaged CLI setup', () => {
  test('creates a shortcut; matching existing link succeeds idempotently', async () => {
    const f = await fixture();
    try {
      const options = {
        resourcesPath: f.resources,
        destination: f.destination,
        platform: 'darwin' as const,
      };
      assert.deepEqual(await installCliShortcut(options), { installed: true });
      assert.equal(await realpath(f.destination), await realpath(f.launcher));
      assert.deepEqual(await installCliShortcut(options), { installed: true });
    } finally {
      await f.cleanup();
    }
  });

  test('conflicting path remains untouched', async () => {
    const f = await fixture();
    try {
      await writeFile(f.destination, 'keep');
      const result = await installCliShortcut({
        resourcesPath: f.resources,
        destination: f.destination,
        platform: 'darwin',
      });
      assert.equal(result.installed, false);
      assert.equal(await readFile(f.destination, 'utf8'), 'keep');
    } finally {
      await f.cleanup();
    }
  });

  test('authorization only follows permission failure, and canceled authorization preserves state', async () => {
    const f = await fixture();
    try {
      let authorized = 0;
      const createLink = async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      };
      const result = await installCliShortcut({
        resourcesPath: f.resources,
        destination: f.destination,
        platform: 'darwin',
        createLink,
        authorize: async () => {
          authorized++;
          return false;
        },
      });
      assert.equal(authorized, 1);
      assert.equal(result.installed, false);
      await recordCliChoice(f.root, 'declined');
      assert.deepEqual(
        await readCliSetupState(path.join(f.root, 'cli-setup.json')),
        { version: 1, choice: 'declined' },
      );
      assert.equal(await lstat(f.destination).catch(() => null), null);
    } finally {
      await f.cleanup();
    }
  });

  test('does not authorize on non-permission errors or non-macOS', async () => {
    const f = await fixture();
    try {
      let authorized = 0;
      await assert.rejects(
        installCliShortcut({
          resourcesPath: f.resources,
          destination: f.destination,
          platform: 'darwin',
          createLink: async () => {
            throw Object.assign(new Error(), { code: 'EIO' });
          },
          authorize: async () => {
            authorized++;
            return true;
          },
        }),
      );
      assert.equal(authorized, 0);
      assert.match(
        (
          await installCliShortcut({
            resourcesPath: f.resources,
            platform: 'linux',
          })
        ).message!,
        /only on macOS/,
      );
    } finally {
      await f.cleanup();
    }
  });

  test('missing launcher and corrupt/missing preferences are safe', async () => {
    const f = await fixture();
    try {
      await rm(f.launcher);
      await assert.rejects(
        installCliShortcut({
          resourcesPath: f.resources,
          destination: f.destination,
          platform: 'darwin',
        }),
      );
      assert.equal(
        await readCliSetupState(path.join(f.root, 'absent.json')),
        null,
      );
      const corrupt = path.join(f.root, 'corrupt.json');
      await writeFile(corrupt, '{');
      assert.equal(await readCliSetupState(corrupt), null);
    } finally {
      await f.cleanup();
    }
  });

  test('state is versioned and stored with private permissions', async () => {
    const f = await fixture();
    try {
      await recordCliChoice(f.root, 'enabled');
      const statePath = path.join(f.root, 'cli-setup.json');
      assert.deepEqual(await readCliSetupState(statePath), {
        version: 1,
        choice: 'enabled',
      });
      assert.equal((await lstat(statePath)).mode & 0o777, 0o600);
      assert.match(await readFile(statePath, 'utf8'), /"version": 1/);
    } finally {
      await f.cleanup();
    }
  });
});
