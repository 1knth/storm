import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readVaultImage } from './vaultAssets';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);

test('reads safe local image paths and rejects unsafe or ambiguous paths', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'storm-vault-image-'));
  const root = path.join(temp, 'vault');
  try {
    await mkdir(path.join(root, 'notes', 'sub'), { recursive: true });
    await mkdir(path.join(root, 'assets'), { recursive: true });
    await writeFile(path.join(root, 'assets', 'ok.png'), png);
    await writeFile(path.join(root, 'notes', 'sub', 'near.png'), png);
    await writeFile(path.join(root, 'notes', 'sub', 'same.png'), png);
    await writeFile(path.join(root, 'assets', 'same.png'), png);
    await writeFile(
      path.join(root, 'notes', 'sub', 'big.png'),
      Buffer.alloc(10 * 1024 * 1024 + 1),
    );
    await symlink(
      path.join(temp, 'outside.png'),
      path.join(root, 'escape.png'),
    );
    await assert.doesNotReject(
      readVaultImage(root, {
        notePath: 'notes/sub/n.md',
        imagePath: '../../assets/ok.png',
      }),
    );
    await assert.doesNotReject(
      readVaultImage(root, {
        notePath: 'notes/sub/n.md',
        imagePath: '/assets/ok.png',
      }),
    );
    await assert.doesNotReject(
      readVaultImage(root, {
        notePath: 'notes/sub/n.md',
        imagePath: 'near.png',
        kind: 'wiki',
      }),
    );
    await assert.rejects(
      readVaultImage(root, {
        notePath: 'notes/sub/n.md',
        imagePath: '../../../outside.png',
      }),
    );
    await assert.rejects(
      readVaultImage(root, {
        notePath: 'notes/sub/n.md',
        imagePath: 'https://example.com/x.png',
      }),
    );
    await assert.rejects(
      readVaultImage(root, {
        notePath: 'notes/sub/n.md',
        imagePath: 'same.png',
        kind: 'wiki',
      }),
      /Ambiguous/,
    );
    await assert.rejects(
      readVaultImage(root, {
        notePath: 'notes/sub/n.md',
        imagePath: 'escape.png',
      }),
    );
    await assert.rejects(
      readVaultImage(root, {
        notePath: 'notes/sub/n.md',
        imagePath: 'big.png',
      }),
      /10 MB/,
    );
    await assert.rejects(
      readVaultImage(root, {
        notePath: 'notes/sub/n.md',
        imagePath: 'missing.png',
      }),
      /not found/i,
    );
    await assert.rejects(
      readVaultImage(root, {
        notePath: 'notes/sub/n.md',
        imagePath: '/etc/passwd',
      }),
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
