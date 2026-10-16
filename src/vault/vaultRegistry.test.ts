import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { VaultRegistry } from './vaultRegistry';
import { groupColorForId } from '../shared/groupColors';

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'storm-vault-registry-'));
}

test('imports immediate child folders as vaults in one group without importing the selected parent', async () => {
  const temp = await temporaryDirectory();
  try {
    const parent = path.join(temp, 'Team');
    const child = path.join(parent, 'Alpha');
    const nested = path.join(child, 'Nested');
    await mkdir(nested, { recursive: true });
    await mkdir(path.join(parent, 'Beta'));
    await writeFile(path.join(parent, 'readme.txt'), 'not a vault');
    await writeFile(
      path.join(temp, 'settings.json'),
      JSON.stringify({ activeVaultId: null, unrelated: 7 }),
    );

    const registry = new VaultRegistry(temp);
    const existing = await registry.add(path.join(parent, 'Beta'));
    const group = await registry.createGroupFromFolder(parent, 'Crew');
    const { vaults, activeVaultId } = await registry.list();
    assert.equal(group.name, 'Crew');
    assert.equal(vaults.length, 2);
    assert.equal(
      vaults.find((vault) => vault.path === existing.vault.path)?.id,
      existing.vault.id,
    );
    assert.ok(vaults.every((vault) => vault.groupId === group.id));
    assert.equal(
      vaults.some((vault) => vault.path === parent || vault.path === nested),
      false,
    );
    assert.equal(activeVaultId, null);
    assert.equal(
      JSON.parse(await readFile(path.join(temp, 'settings.json'), 'utf8'))
        .unrelated,
      7,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('folder group import rejects empty folders and duplicate names without partial registry changes', async () => {
  const temp = await temporaryDirectory();
  try {
    const parent = path.join(temp, 'Empty');
    await mkdir(parent);
    const registry = new VaultRegistry(temp);
    await assert.rejects(
      registry.createGroupFromFolder(parent, 'Empty group'),
      /no immediate child folders/,
    );
    assert.deepEqual(await registry.listGroups(), []);
    await mkdir(path.join(parent, 'Child'));
    await registry.createGroup('Taken');
    await assert.rejects(
      registry.createGroupFromFolder(parent, ' taken '),
      /already exists/,
    );
    assert.equal((await registry.list()).vaults.length, 0);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('persists groups, assignments and collapse state without changing vault folders', async () => {
  const temp = await temporaryDirectory();
  try {
    const vaultPath = path.join(temp, 'actual-vault');
    await mkdir(vaultPath);
    await writeFile(path.join(vaultPath, 'note.md'), 'keep');
    await writeFile(
      path.join(temp, 'settings.json'),
      JSON.stringify({ unrelated: { keep: true }, activeVaultId: null }),
    );
    const registry = new VaultRegistry(temp);
    const { vault } = await registry.add(vaultPath);
    const group = await registry.createGroup('  Work  ');
    assert.equal(group.name, 'Work');
    await registry.setVaultGroup(vault.id, group.id);
    await registry.setGroupColor(group.id, 'pink');
    await assert.rejects(registry.setGroupColor(group.id, 'not-a-color'));
    await registry.setGroupCollapsed(group.id, true);
    await registry.renameGroup(group.id, 'Projects');
    const layout = {
      version: 1 as const,
      tabs: [{ kind: 'note' as const, path: 'note.md', anchor: 0, head: 2, scrollTop: 4 }],
      activeTab: 'note.md',
      groups: [{ id: 'tabs-group', name: 'Reading', collapsed: false }],
      assignments: { 'note.md': 'tabs-group' },
    };
    await registry.saveTabLayout(vault.id, layout);
    assert.deepEqual(await registry.getTabLayout(vault.id), layout);

    const reloaded = new VaultRegistry(temp);
    assert.deepEqual(await reloaded.listGroups(), [
      { ...group, name: 'Projects', collapsed: true, color: 'pink' },
    ]);
    assert.equal((await reloaded.list()).vaults[0].groupId, group.id);
    assert.equal(
      await readFile(path.join(vaultPath, 'note.md'), 'utf8'),
      'keep',
    );
    const settings = JSON.parse(
      await readFile(path.join(temp, 'settings.json'), 'utf8'),
    );
    assert.deepEqual(settings.unrelated, { keep: true });

    await reloaded.removeGroup(group.id);
    assert.equal((await reloaded.list()).vaults[0].groupId, null);
    assert.equal(
      await readFile(path.join(vaultPath, 'note.md'), 'utf8'),
      'keep',
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('preserves legacy registries and normalizes unknown or malformed group references', async () => {
  const temp = await temporaryDirectory();
  try {
    const vaultPath = path.join(temp, 'legacy-vault');
    await mkdir(vaultPath);
    const legacyVault = { id: 'stable-id', name: 'Legacy', path: vaultPath };
    await writeFile(
      path.join(temp, 'settings.json'),
      JSON.stringify({
        vaults: [legacyVault],
        activeVaultId: 'stable-id',
        lastVaultPath: '/old/path',
        otherSetting: 42,
      }),
    );
    const registry = new VaultRegistry(temp);
    assert.deepEqual(await registry.listGroups(), []);
    assert.deepEqual((await registry.list()).vaults, [legacyVault]);
    const group = await registry.createGroup('Team');
    await assert.rejects(registry.setVaultGroup(legacyVault.id, 'missing'));
    await assert.rejects(registry.setVaultGroup('missing-vault', group.id));
    await assert.rejects(registry.createGroup(' team '));
    await assert.rejects(registry.renameGroup('missing', 'Other'));
    await assert.rejects(registry.createGroup('  '));
    await assert.rejects(registry.createGroup('x'.repeat(81)));

    const raw = JSON.parse(
      await readFile(path.join(temp, 'settings.json'), 'utf8'),
    );
    assert.equal(raw.otherSetting, 42);
    assert.equal(raw.activeVaultId, 'stable-id');
    assert.equal(raw.lastVaultPath, '/old/path');
    assert.equal(raw.vaults[0].id, 'stable-id');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('clears unknown saved group references safely while retaining valid vault records', async () => {
  const temp = await temporaryDirectory();
  try {
    const vault = {
      id: 'vault-1',
      name: 'Keep',
      path: '/not-touched',
      groupId: 'gone',
    };
    await writeFile(
      path.join(temp, 'settings.json'),
      JSON.stringify({
        vaults: [vault],
        vaultGroups: [
          { id: 'g', name: '  ' },
          { id: 'ok', name: 'Okay', collapsed: true, color: 'bad-color' },
        ],
      }),
    );
    const registry = new VaultRegistry(temp);
    assert.deepEqual(await registry.listGroups(), [
      {
        id: 'ok',
        name: 'Okay',
        collapsed: true,
        color: groupColorForId('ok'),
      },
    ]);
    assert.deepEqual((await registry.list()).vaults[0], {
      ...vault,
      groupId: null,
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
