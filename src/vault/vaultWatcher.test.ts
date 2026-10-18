import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { VaultWatcher } from './vaultWatcher';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('notifies on vault changes, ignores excluded paths, and stops cleanly', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'storm-vault-watch-'));
  const events: Array<{ vaultId: string; revision: number }> = [];
  const watcher = new VaultWatcher(
    (vaultId, revision) => events.push({ vaultId, revision }),
    40,
  );
  context.after(async () => {
    watcher.stop();
    await rm(root, { recursive: true, force: true });
  });

  watcher.start(root, 'fixture-vault');
  await mkdir(path.join(root, 'notes'));
  await writeFile(path.join(root, 'notes', 'new.md'), '# New\n');
  await wait(250);
  assert.ok(events.some((event) => event.vaultId === 'fixture-vault'));

  const priorCount = events.length;
  await mkdir(path.join(root, '.obsidian'));
  await writeFile(path.join(root, '.obsidian', 'ignored.md'), 'ignored');
  await wait(250);
  assert.equal(events.length, priorCount);

  watcher.stop();
  await writeFile(path.join(root, 'after-stop.md'), 'stopped');
  await wait(100);
  assert.equal(events.length, priorCount);
});
