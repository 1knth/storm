import { afterEach, describe, it as test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  resolveAgentNoteTarget,
  AgentNoteTargetError,
} from './agentNoteTarget';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'storm-agent-note-'));
  temporaryDirectories.push(base);
  const school = path.join(base, 'school');
  const nested = path.join(school, 'TELE');
  await mkdir(nested, { recursive: true });
  const vaults = [
    { id: 'school', path: school },
    { id: 'tele', path: nested },
  ];
  return { base, school, nested, vaults };
}

describe('resolveAgentNoteTarget', () => {
  test('creates empty markdown under most-specific registered root without clobbering', async () => {
    const { nested, vaults } = await fixture();
    const filename = path.join(nested, 'Some Note.MD');
    const first = await resolveAgentNoteTarget(filename, vaults);
    assert.equal(first.vaultId, 'tele');
    assert.equal(first.content, '');
    assert.equal(first.relativePath, 'Some Note.MD');
    await writeFile(filename, 'preserve me');
    assert.equal(
      (await resolveAgentNoteTarget(filename, vaults)).content,
      'preserve me',
    );
  });

  test('prefers the canonical registry entry when roots have lexical aliases', async () => {
    const { school } = await fixture();
    const alias = `${school}-alias`;
    await symlink(school, alias);
    const canonicalSchool = await realpath(school);
    const result = await resolveAgentNoteTarget(path.join(alias, 'note.md'), [
      { id: 'alias', path: alias },
      { id: 'canonical', path: canonicalSchool },
    ]);
    assert.equal(result.vaultId, 'canonical');
    assert.equal(result.vaultRoot, await realpath(school));
  });

  test('resolves platform temp-directory aliases and duplicate canonical roots', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'storm-agent-alias-'));
    temporaryDirectories.push(base);
    const canonicalBase = await realpath(base);
    const aliasedBase = path.join(path.dirname(base), path.basename(base));
    const canonicalVault = path.join(canonicalBase, 'vault');
    await mkdir(canonicalVault);
    const aliasVault = path.join(aliasedBase, 'vault');
    await mkdir(path.join(canonicalVault, 'nested'));
    const result = await resolveAgentNoteTarget(
      path.join(aliasVault, 'nested', 'note.md'),
      [
        { id: 'aliased', path: aliasVault },
        { id: 'canonical', path: canonicalVault },
      ],
    );
    assert.equal(result.vaultId, 'canonical');
    assert.equal(result.vaultRoot, await realpath(canonicalVault));
    await assert.rejects(
      resolveAgentNoteTarget(path.join(aliasVault, 'missing', 'note.md'), [
        { id: 'aliased', path: aliasVault },
        { id: 'canonical', path: canonicalVault },
      ]),
      { code: 'MISSING_PARENT' },
    );
  });

  test('validates traversal, unregistered paths, extension and missing parents', async () => {
    const { school, base, vaults } = await fixture();
    for (const [target, code] of [
      [path.join(school, '..', 'escape.md'), 'UNREGISTERED_VAULT'],
      [path.join(base, 'elsewhere.md'), 'UNREGISTERED_VAULT'],
      [path.join(school, 'bad.txt'), 'INVALID_EXTENSION'],
      [path.join(school, 'missing', 'note.md'), 'MISSING_PARENT'],
    ] as const) {
      await assert.rejects(resolveAgentNoteTarget(target, vaults), { code });
    }
  });

  test('rejects symlink parent and symlink note escapes', async () => {
    const { base, school, vaults } = await fixture();
    const outside = path.join(base, 'outside');
    await mkdir(outside);
    await symlink(outside, path.join(school, 'linked-dir'));
    await symlink(
      path.join(outside, 'target.md'),
      path.join(school, 'linked.md'),
    );
    await assert.rejects(
      resolveAgentNoteTarget(
        path.join(school, 'linked-dir', 'note.md'),
        vaults,
      ),
      AgentNoteTargetError,
    );
    await assert.rejects(
      resolveAgentNoteTarget(path.join(school, 'linked.md'), vaults),
      { code: 'PATH_OUTSIDE_VAULT' },
    );
    assert.equal(
      await readFile(path.join(outside, 'target.md')).catch(() => ''),
      '',
    );
  });

  test('concurrent creates both return the same valid empty note', async () => {
    const { school, vaults } = await fixture();
    const target = path.join(school, 'race.md');
    const results = await Promise.all([
      resolveAgentNoteTarget(target, vaults),
      resolveAgentNoteTarget(target, vaults),
    ]);
    assert.deepEqual(
      results.map((result) => result.content),
      ['', ''],
    );
    assert.equal(await readFile(target, 'utf8'), '');
  });
});
