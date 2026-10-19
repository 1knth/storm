import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { deriveVaultSidebarLayout } from './vaultSidebarLayout';
import type { RegisteredVault, SidebarRootRef, VaultGroup } from './types';

test('mixed root order drives visible vault keyboard indices without duplicates', () => {
  const groups: VaultGroup[] = [
    { id: 'g1', name: 'First group', collapsed: false },
    { id: 'g2', name: 'Collapsed group', collapsed: true },
  ];
  const vaults: RegisteredVault[] = [
    { id: 'pin', name: 'Pinned', path: '/pin', pinned: true, groupId: 'g1' },
    { id: 'member', name: 'Member', path: '/member', groupId: 'g1' },
    { id: 'root', name: 'Root', path: '/root' },
    { id: 'hidden', name: 'Hidden', path: '/hidden', groupId: 'g2' },
  ];
  const order: SidebarRootRef[] = [
    { kind: 'group', id: 'g2' },
    { kind: 'group', id: 'g1' },
    { kind: 'vault', id: 'root' },
  ];
  const layout = deriveVaultSidebarLayout(vaults, groups, order);
  assert.deepEqual(
    layout.rootItems.map(
      (item) =>
        `${item.kind}:${item.kind === 'group' ? item.group.id : item.vault.id}`,
    ),
    ['group:g2', 'group:g1', 'vault:root'],
  );
  assert.deepEqual(
    layout.visibleVaults.map((vault) => vault.id),
    ['pin', 'member', 'root'],
  );
  assert.equal(
    new Set(layout.visibleVaults.map((vault) => vault.id)).size,
    layout.visibleVaults.length,
  );
});

test('pinned members remain a top lane in layout and retain their remembered group', () => {
  const groups: VaultGroup[] = [{ id: 'g', name: 'Group', collapsed: false }];
  const vaults: RegisteredVault[] = [
    { id: 'p', name: 'Pinned', path: '/p', pinned: true, groupId: 'g' },
    { id: 'm', name: 'Member', path: '/m', groupId: 'g' },
    { id: 'u', name: 'Root', path: '/u' },
  ];
  const layout = deriveVaultSidebarLayout(vaults, groups);
  assert.deepEqual(
    layout.pinnedVaults.map((vault) => vault.id),
    ['p'],
  );
  assert.deepEqual(
    layout.ungroupedVaults.map((vault) => vault.id),
    ['u'],
  );
  assert.deepEqual(
    layout.groups[0].vaults.map((vault) => vault.id),
    ['m'],
  );
  assert.equal(
    layout.pinnedVaults.length +
      layout.ungroupedVaults.length +
      layout.groups.reduce((n, group) => n + group.vaults.length, 0),
    vaults.length,
  );
});
