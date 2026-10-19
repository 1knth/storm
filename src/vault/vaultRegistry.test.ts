import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { VaultRegistry } from './vaultRegistry';
import { groupColorForId } from '../shared/groupColors';
import { deriveVaultSidebarLayout } from '../shared/vaultSidebarLayout';
import { serializeTabLayout } from '../components/Editor/savedTabLayout';
import { getTabId } from '../components/Editor/tabGroups';
import type {
  ImageTabSnapshot,
  NoteTabSnapshot,
  TabSnapshot,
} from '../components/Editor/Editor';
import { EditorState } from '@codemirror/state';

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'storm-vault-registry-'));
}

test('persists pin placement, remembered groups, bucket order, and group reordering without moving files', async () => {
  const temp = await temporaryDirectory();
  try {
    const paths = ['a', 'b', 'c'].map((name) => path.join(temp, name));
    for (const directory of paths) {
      await mkdir(directory);
      await writeFile(path.join(directory, 'note.md'), directory);
    }
    const registry = new VaultRegistry(temp);
    const vaults = await Promise.all(
      paths.map((directory) => registry.add(directory)),
    );
    const [a, b, c] = vaults.map(({ vault }) => vault);
    const group = await registry.createGroup('Remember me');
    await registry.setVaultPlacement({
      vaultId: a.id,
      groupId: group.id,
      pinned: false,
      beforeVaultId: null,
    });
    await registry.setVaultPlacement({
      vaultId: b.id,
      groupId: group.id,
      pinned: false,
      beforeVaultId: null,
    });
    await registry.setVaultPlacement({
      vaultId: a.id,
      groupId: group.id,
      pinned: true,
      beforeVaultId: null,
    });
    assert.deepEqual(
      (await new VaultRegistry(temp).list()).vaults.map((v) => [
        v.id,
        v.pinned,
        v.groupId,
      ]),
      [
        [c.id, false, undefined],
        [b.id, false, group.id],
        [a.id, true, group.id],
      ],
    );
    await registry.setVaultPlacement({
      vaultId: a.id,
      groupId: group.id,
      pinned: false,
      beforeVaultId: null,
    });
    await assert.rejects(
      registry.setVaultPlacement({
        vaultId: c.id,
        groupId: null,
        pinned: false,
        beforeVaultId: b.id,
      }),
      /Invalid placement anchor/,
    );
    await registry.setVaultPlacement({
      vaultId: c.id,
      groupId: group.id,
      pinned: false,
      beforeVaultId: b.id,
    });
    const reorderedVaults = (await registry.list()).vaults;
    const visible = deriveVaultSidebarLayout(
      reorderedVaults,
      await registry.listGroups(),
    );
    assert.deepEqual(
      visible.pinnedVaults.map((vault) => vault.id),
      [],
    );
    assert.deepEqual(
      visible.ungroupedVaults.map((vault) => vault.id),
      [],
    );
    assert.deepEqual(
      visible.groups.map((item) => [
        item.id,
        item.vaults.map((vault) => vault.id),
      ]),
      [[group.id, [c.id, b.id, a.id]]],
    );
    const second = await registry.createGroup('Second');
    await registry.reorderGroups([second.id, group.id]);
    assert.deepEqual(
      (await new VaultRegistry(temp).listGroups()).map((g) => g.id),
      [second.id, group.id],
    );
    await assert.rejects(
      registry.reorderGroups([group.id]),
      /Invalid group order/,
    );
    await assert.rejects(
      registry.reorderGroups([group.id, group.id]),
      /Invalid group order/,
    );
    await assert.rejects(
      registry.setVaultPlacement({
        vaultId: a.id,
        groupId: group.id,
        pinned: true,
        beforeVaultId: c.id,
      }),
      /Invalid placement anchor/,
    );
    assert.deepEqual(
      (await registry.list()).vaults.map((v) => v.id),
      reorderedVaults.map((vault) => vault.id),
    );
    for (const directory of paths)
      assert.equal(
        await readFile(path.join(directory, 'note.md'), 'utf8'),
        directory,
      );
    assert.deepEqual((await readdir(temp)).sort(), [
      'a',
      'b',
      'c',
      'settings.json',
    ]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

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

test('saves and reloads serialized active image checkpoints through vault validation', async () => {
  const temp = await temporaryDirectory();
  try {
    const vaultPath = path.join(temp, 'vault');
    await mkdir(path.join(vaultPath, 'notes', 'images'), { recursive: true });
    const registry = new VaultRegistry(temp);
    const { vault } = await registry.add(vaultPath);
    const image: ImageTabSnapshot = {
      kind: 'image',
      vaultId: vault.id,
      path: 'notes/images/Pasted image 20261008152748.png',
      filename: 'Pasted image 20261008152748.png',
    };
    const noteData = {
      path: 'notes/readme.md',
      content: 'checkpoint note',
      revision: 'revision-1',
    };
    const note: NoteTabSnapshot = {
      kind: 'note',
      note: noteData,
      vaultPath,
      vaultId: vault.id,
      state: EditorState.create({ doc: noteData.content }),
      scrollTop: 0,
    };
    const group = {
      id: 'images',
      name: 'Images',
      collapsed: true,
      color: 'purple' as const,
    };
    const cases: {
      name: string;
      tabs: TabSnapshot[];
      groups: (typeof group)[];
      assignments: Record<string, string>;
    }[] = [
      { name: 'image only', tabs: [image], groups: [], assignments: {} },
      {
        name: 'mixed with image active',
        tabs: [note, image],
        groups: [],
        assignments: {},
      },
      {
        name: 'grouped image active',
        tabs: [image, note],
        groups: [group],
        assignments: { [getTabId(image)]: group.id },
      },
    ];

    for (const scenario of cases) {
      const expected = serializeTabLayout(
        scenario.tabs,
        getTabId(image),
        scenario.groups,
        scenario.assignments,
        new Map(),
      );
      await registry.saveTabLayout(vault.id, expected);
      const reloaded = await new VaultRegistry(temp).getTabLayout(vault.id);
      assert.deepEqual(reloaded, expected, scenario.name);
      assert.equal(
        reloaded?.activeTab,
        JSON.stringify([vault.id, image.path]),
        scenario.name,
      );
      assert.equal(
        reloaded?.tabs.some(
          (tab) => tab.kind === 'image' && tab.path === image.path,
        ),
        true,
        scenario.name,
      );
      assert.deepEqual(
        reloaded?.assignments,
        scenario.assignments,
        scenario.name,
      );
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('persists image tab layouts and rejects unsafe or duplicate image paths', async () => {
  const temp = await temporaryDirectory();
  try {
    const vaultPath = path.join(temp, 'vault');
    await mkdir(vaultPath);
    const registry = new VaultRegistry(temp);
    const { vault } = await registry.add(vaultPath);
    const imageId = JSON.stringify([vault.id, 'assets/photo.png']);
    const layout = {
      version: 1 as const,
      tabs: [
        { kind: 'image' as const, path: 'assets/photo.png' },
        {
          kind: 'note' as const,
          path: 'notes.md',
          anchor: 2,
          head: 4,
          scrollTop: 16,
        },
      ],
      activeTab: imageId,
      groups: [
        { id: 'media', name: 'Media', collapsed: true, color: 'purple' },
      ],
      assignments: { [imageId]: 'media' },
    };
    await registry.saveTabLayout(vault.id, layout);
    assert.deepEqual(
      await new VaultRegistry(temp).getTabLayout(vault.id),
      layout,
    );
    await assert.rejects(
      registry.saveTabLayout(vault.id, {
        ...layout,
        tabs: [{ kind: 'image', path: '../outside.png' }],
      }),
      /Invalid saved tab layout/,
    );
    await assert.rejects(
      registry.saveTabLayout(vault.id, {
        ...layout,
        tabs: [
          { kind: 'image', path: 'assets/photo.png' },
          { kind: 'image', path: 'assets/photo.png' },
        ],
      }),
      /Invalid saved tab layout/,
    );
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
    assert.deepEqual((await registry.list()).vaults, [
      { ...legacyVault, pinned: false },
    ]);
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
      sidebarRootOrder: [],
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

test('round-trips mixed sidebar root ordering and normalizes stale or invalid references', async () => {
  const temp = await temporaryDirectory();
  try {
    const firstPath = path.join(temp, 'first');
    const secondPath = path.join(temp, 'second');
    await mkdir(firstPath);
    await mkdir(secondPath);
    const registry = new VaultRegistry(temp);
    const first = (await registry.add(firstPath)).vault;
    const second = (await registry.add(secondPath)).vault;
    const group = await registry.createGroup('Group');
    await registry.setVaultGroup(second.id, group.id);

    const initialOrder = (await registry.list()).sidebarRootOrder;
    assert.deepEqual(initialOrder, [
      { kind: 'vault', id: first.id },
      { kind: 'group', id: group.id },
    ]);
    await registry.moveSidebarItem({
      item: { kind: 'group', id: group.id },
      before: { kind: 'vault', id: first.id },
    });
    const movedOrder = [
      { kind: 'group' as const, id: group.id },
      { kind: 'vault' as const, id: first.id },
    ];
    assert.deepEqual(
      (await new VaultRegistry(temp).list()).sidebarRootOrder,
      movedOrder,
    );

    const reloaded = new VaultRegistry(temp);
    await reloaded.setGroupCollapsed(group.id, true);
    await reloaded.renameGroup(group.id, 'Renamed');
    assert.deepEqual(
      (await new VaultRegistry(temp).list()).sidebarRootOrder,
      movedOrder,
    );
    await reloaded.removeGroup(group.id);
    assert.deepEqual((await new VaultRegistry(temp).list()).sidebarRootOrder, [
      { kind: 'vault', id: first.id },
      { kind: 'vault', id: second.id },
    ]);
    await reloaded.remove(first.id);
    assert.deepEqual((await new VaultRegistry(temp).list()).sidebarRootOrder, [
      { kind: 'vault', id: second.id },
    ]);

    const settingsFile = path.join(temp, 'settings.json');
    const settings = JSON.parse(await readFile(settingsFile, 'utf8'));
    settings.sidebarRootOrder = [
      { kind: 'vault', id: second.id },
      { kind: 'vault', id: second.id },
      { kind: 'group', id: 'missing' },
      { kind: 'other', id: 'bad-kind' },
      { kind: 'group', id: 12 },
      null,
    ];
    await writeFile(settingsFile, JSON.stringify(settings));
    assert.deepEqual((await new VaultRegistry(temp).list()).sidebarRootOrder, [
      { kind: 'vault', id: second.id },
    ]);
    await assert.rejects(
      reloaded.moveSidebarItem({
        item: { kind: 'vault', id: second.id },
        before: { kind: 'group', id: 'missing' },
      }),
      /Invalid sidebar anchor/,
    );
    assert.deepEqual((await new VaultRegistry(temp).list()).sidebarRootOrder, [
      { kind: 'vault', id: second.id },
    ]);
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
      pinned: false,
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
