import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { deriveVaultSidebarLayout } from './vaultSidebarLayout';
import type { RegisteredVault, VaultGroup } from './types';

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
