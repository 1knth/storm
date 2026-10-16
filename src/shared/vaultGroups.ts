import type { RegisteredVault, VaultGroup } from './types';

export function deriveVisibleVaults(
  vaults: RegisteredVault[],
  groups: VaultGroup[],
): RegisteredVault[] {
  const groupedIds = new Set(groups.map((group) => group.id));
  const visible = vaults.filter(
    (vault) => !vault.groupId || !groupedIds.has(vault.groupId),
  );
  for (const group of groups) {
    if (!group.collapsed)
      visible.push(...vaults.filter((vault) => vault.groupId === group.id));
  }
  return visible;
}
