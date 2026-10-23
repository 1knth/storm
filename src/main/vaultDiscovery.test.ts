import { afterEach, describe, it as test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverVaultNotes, resolveVaultLink } from './vaultDiscovery';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createVault(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'storm-discovery-'));
  roots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
  }
  const canonicalRoot = await realpath(root);
  const vaultId = 'vault-test';
  const discover = (
    query?: string,
    options?: { sourcePath?: string; depth?: number; includeSource?: boolean },
  ) =>
    discoverVaultNotes(
      async () => ({ vaults: [{ id: vaultId, path: canonicalRoot }] }),
      vaultId,
      query,
      50,
      options,
    );
  return { root, vaultId, discover };
}

describe('vault discovery', () => {
  test('searches note names and contents with excerpts', async () => {
    const { discover } = await createVault({
      'Alpha.md': 'First note.',
      'Folder/Beta.md': 'Contains searchable phrase.',
    });
    assert.deepEqual(
      (await discover('alpha')).results.map((note) => note.path),
      ['Alpha.md'],
    );
    const content = await discover('searchable');
    assert.equal(content.results[0]?.path, 'Folder/Beta.md');
    assert.ok(content.results[0]?.excerpt?.includes('searchable phrase'));
    assert.deepEqual(content.unresolved, []);
  });

  test('resolves standalone links and distinguishes missing, ambiguous, and invalid targets', async () => {
    const { root, vaultId } = await createVault({
      'A.md': 'source',
      'B.md': 'target',
      'one/Twin.md': 'one',
      'two/Twin.md': 'two',
    });
    const canonicalRoot = await realpath(root);
    const listVaults = async () => ({
      vaults: [{ id: vaultId, path: canonicalRoot }],
    });
    assert.deepEqual(await resolveVaultLink(listVaults, vaultId, 'A.md', 'B'), {
      sourcePath: 'A.md',
      target: 'B',
      path: 'B.md',
    });
    assert.equal(
      (await resolveVaultLink(listVaults, vaultId, 'A.md', 'Missing')).reason,
      'missing',
    );
    assert.equal(
      (await resolveVaultLink(listVaults, vaultId, 'A.md', 'Twin')).reason,
      'ambiguous',
    );
    assert.equal(
      (await resolveVaultLink(listVaults, vaultId, 'A.md', '../outside'))
        .reason,
      'invalid',
    );
  });

  test('reports traversal truncation at the link safety budget', async () => {
    const links = Array.from(
      { length: 10_001 },
      (_, index) => `[[Missing${index}]]`,
    ).join(' ');
    const { discover } = await createVault({ 'A.md': links });
    const result = await discover(undefined, { sourcePath: 'A.md', depth: 1 });
    assert.equal(result.truncated, true);
    assert.equal(result.unresolved.length, 10_000);
  });

  test('rejects an unregistered vault', async () => {
    const { root } = await createVault({ 'A.md': 'note' });
    await assert.rejects(
      discoverVaultNotes(async () => ({ vaults: [] }), 'nope', undefined, 10),
      /Vault is not registered/,
    );
    assert.ok(root);
  });

  test('follows links to requested depth without looping and reports missing or ambiguous links', async () => {
    const { discover } = await createVault({
      'A.md': '[[B]] [[Missing]] [[Twin]] [[../escape]] [[%ZZ]]',
      'B.md': '[[C]] [[A]]',
      'C.md': 'end',
      'one/Twin.md': 'one',
      'two/Twin.md': 'two',
    });
    const depthOne = await discover(undefined, {
      sourcePath: 'A.md',
      depth: 1,
    });
    assert.deepEqual(
      depthOne.results.map((note) => note.path),
      ['B.md'],
    );
    assert.deepEqual(depthOne.unresolved, [
      { sourcePath: 'A.md', target: 'Missing', reason: 'missing' },
      { sourcePath: 'A.md', target: 'Twin', reason: 'ambiguous' },
      { sourcePath: 'A.md', target: '../escape', reason: 'invalid' },
      { sourcePath: 'A.md', target: '%ZZ', reason: 'invalid' },
    ]);
    const depthTwo = await discover(undefined, {
      sourcePath: 'A.md',
      depth: 2,
      includeSource: true,
    });
    assert.deepEqual(
      depthTwo.results.map((note) => note.path),
      ['A.md', 'B.md', 'C.md'],
    );
  });
});
