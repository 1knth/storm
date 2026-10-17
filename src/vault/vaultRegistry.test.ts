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

test('serializes concurrent mutations and recovers after a failed save', async () => {
  const temp = await temporaryDirectory();
  try {
    const registry = new VaultRegistry(temp);
    for (let round = 0; round < 5; round++) {
      await Promise.all([
        registry.createGroup(`Team ${round} A`),
        registry.createGroup(`Team ${round} B`),
      ]);
    }
    assert.equal((await new VaultRegistry(temp).listGroups()).length, 10);

    const settingsFile = path.join(temp, 'settings.json');
    const backupFile = path.join(temp, 'settings.backup');
    await (await import('node:fs/promises')).rename(settingsFile, backupFile);
    await mkdir(settingsFile);
    await assert.rejects(registry.createGroup('Save fails'));
    await rm(settingsFile, { recursive: true });
    await (await import('node:fs/promises')).rename(backupFile, settingsFile);

    await registry.createGroup('After recovery');
    const persisted = new VaultRegistry(temp);
    const groups = await persisted.listGroups();
    assert.equal(groups.length, 11);
    assert.ok(groups.some((group) => group.name === 'After recovery'));
    assert.ok(groups.every((group) => group.name !== 'Save fails'));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('serializes concurrent group and saved-layout mutations without losing either update', async () => {
  const temp = await temporaryDirectory();
  try {
    const vaultPath = path.join(temp, 'vault');
    await mkdir(vaultPath);
    const registry = new VaultRegistry(temp);
    const { vault } = await registry.add(vaultPath);
    const layout = {
      version: 1 as const,
      tabs: [{ kind: 'empty' as const, id: 'welcome' }],
      activeTab: 'welcome',
      groups: [],
      assignments: {},
    };
    const [group] = await Promise.all([
      registry.createGroup('Concurrent'),
      registry.saveTabLayout(vault.id, layout),
    ]);

    const reloaded = new VaultRegistry(temp);
    assert.equal((await reloaded.listGroups())[0].id, group.id);
    assert.deepEqual(await reloaded.getTabLayout(vault.id), layout);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

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

test('folder group import falls back when there are no child folders and ignores root notes when importing children', async () => {
  const temp = await temporaryDirectory();
  try {
    const parent = path.join(temp, 'Empty');
    await mkdir(parent);
    await writeFile(path.join(parent, 'root-note.md'), 'keep');
    const registry = new VaultRegistry(temp);
    const group = await registry.createGroupFromFolder(parent, 'Empty group');
    const fallback = (await registry.list()).vaults[0];
    assert.equal(
      fallback.path,
      await import('node:fs/promises').then(({ realpath }) => realpath(parent)),
    );
    assert.equal(fallback.name, 'Empty');
    assert.equal(fallback.groupId, group.id);
    await mkdir(path.join(parent, 'Child'));
    await writeFile(path.join(parent, 'another-note.md'), 'also keep');
    const childGroup = await registry.createGroupFromFolder(
      parent,
      'Child group',
    );
    const afterChildImport = (await registry.list()).vaults;
    const canonicalChild = await import('node:fs/promises').then(
      ({ realpath }) => realpath(path.join(parent, 'Child')),
    );
    assert.deepEqual(
      afterChildImport.map((vault) => vault.path),
      [fallback.path, canonicalChild],
    );
    assert.equal(
      afterChildImport.find((vault) => vault.path === fallback.path)?.groupId,
      group.id,
    );
    assert.equal(
      afterChildImport.find((vault) => vault.path === canonicalChild)?.groupId,
      childGroup.id,
    );
    await registry.createGroup('Taken');
    await assert.rejects(
      registry.createGroupFromFolder(parent, ' taken '),
      /already exists/,
    );
    assert.equal((await registry.list()).vaults.length, 2);
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
      tabs: [
        {
          kind: 'note' as const,
          path: 'note.md',
          anchor: 0,
          head: 2,
          scrollTop: 4,
        },
      ],
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

test('unloads all vault registrations and layouts while preserving unrelated settings and vault files', async () => {
  const temp = await temporaryDirectory();
  try {
    const vaultPath = path.join(temp, 'notes');
    await mkdir(vaultPath);
    await writeFile(path.join(vaultPath, 'note.md'), 'leave untouched');
    await writeFile(
      path.join(temp, 'settings.json'),
      JSON.stringify({
        appearance: { theme: 'light' },
        vimMode: true,
        lastVaultPath: vaultPath,
      }),
    );
    const registry = new VaultRegistry(temp);
    const { vault } = await registry.add(vaultPath);
    const group = await registry.createGroup('Saved group');
    await registry.setVaultGroup(vault.id, group.id);
    await registry.saveTabLayout(vault.id, {
      version: 1,
      tabs: [{ kind: 'empty', id: 'tab' }],
      activeTab: 'tab',
      groups: [],
      assignments: {},
    });
    await registry.setActive(vault.id);

    await registry.unloadAll();
    const stored = JSON.parse(
      await readFile(path.join(temp, 'settings.json'), 'utf8'),
    );
    assert.deepEqual(stored.vaults, []);
    assert.equal(stored.activeVaultId, null);
    assert.deepEqual(stored.vaultGroups, []);
    assert.deepEqual(stored.savedTabLayouts, {});
    assert.equal('lastVaultPath' in stored, false);
    assert.deepEqual(stored.appearance, { theme: 'light' });
    assert.equal(stored.vimMode, true);
    const reloaded = new VaultRegistry(temp);
    assert.deepEqual(await reloaded.list(), {
      vaults: [],
      activeVaultId: null,
    });
    assert.equal(
      await readFile(path.join(vaultPath, 'note.md'), 'utf8'),
      'leave untouched',
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('does not update in-memory registry when unloading cannot persist', async () => {
  const temp = await temporaryDirectory();
  try {
    const vaultPath = path.join(temp, 'vault');
    await mkdir(vaultPath);
    const registry = new VaultRegistry(temp);
    await registry.add(vaultPath);
    const settingsFile = path.join(temp, 'settings.json');
    const backup = path.join(temp, 'settings.backup');
    await (await import('node:fs/promises')).rename(settingsFile, backup);
    await mkdir(settingsFile);
    await assert.rejects(registry.unloadAll());
    await rm(settingsFile, { recursive: true });
    await (await import('node:fs/promises')).rename(backup, settingsFile);
    assert.equal((await registry.list()).vaults.length, 1);
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
