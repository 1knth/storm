import type { RegisteredVault, VaultGroup, SidebarRootRef } from './types';

/** UI handoff: pinned vaults render first; then ungrouped, then groups in persisted order.
 * Pinned members stay remembered in groupId but appear only in the pinned lane.
 * Use vaultSetPlacement for a drop (one atomic persistence call): pin with the existing
 * groupId, unpin into its group with pinned:false, move group with its target id,
 * or move to root with groupId:null. beforeVaultId is the lane-local anchor or null.
 * Pin-toggle preserves groupId; an ordinary pin-lane drop also preserves it.
 * Dropping onto a group explicitly assigns that group and unpins.
 */
export function deriveVaultSidebarLayout(
  vaults: RegisteredVault[],
  groups: VaultGroup[],
  persistedRootOrder: SidebarRootRef[] = [],
) {
  const fallback: SidebarRootRef[] = [
    ...vaults
      .filter((vault) => vault.pinned !== true && !vault.groupId)
      .map((vault) => ({ kind: 'vault' as const, id: vault.id })),
    ...groups.map((group) => ({ kind: 'group' as const, id: group.id })),
  ];
  const candidates = persistedRootOrder.length ? persistedRootOrder : fallback;
  const rootItems: SidebarRootRef[] = [];
  const seen = new Set<string>();
  for (const ref of candidates) {
    const exists =
      ref.kind === 'vault'
        ? vaults.some(
            (vault) =>
              vault.id === ref.id && vault.pinned !== true && !vault.groupId,
          )
        : groups.some((group) => group.id === ref.id);
    const key = `${ref.kind}:${ref.id}`;
    if (exists && !seen.has(key)) {
      rootItems.push(ref);
      seen.add(key);
    }
  }
  for (const ref of fallback) {
    const key = `${ref.kind}:${ref.id}`;
    if (!seen.has(key)) {
      rootItems.push(ref);
      seen.add(key);
    }
  }
  const grouped = groups.map((group) => ({
    ...group,
    vaults: vaults.filter(
      (vault) => vault.pinned !== true && vault.groupId === group.id,
    ),
  }));
  const groupById = new Map(grouped.map((group) => [group.id, group]));
  const vaultById = new Map(vaults.map((vault) => [vault.id, vault]));
  return {
    pinnedVaults: vaults.filter((vault) => vault.pinned === true),
    ungroupedVaults: vaults.filter(
      (vault) =>
        vault.pinned !== true &&
        (!vault.groupId || !groups.some((group) => group.id === vault.groupId)),
    ),
    groups: grouped,
    rootItems: rootItems.map((ref) =>
      ref.kind === 'group'
        ? { kind: 'group' as const, group: groupById.get(ref.id)! }
        : { kind: 'vault' as const, vault: vaultById.get(ref.id)! },
    ),
    visibleVaults: [
      ...vaults.filter((vault) => vault.pinned === true),
      ...rootItems.flatMap((ref) =>
        ref.kind === 'vault'
          ? [vaultById.get(ref.id)!]
          : groupById.get(ref.id)!.collapsed
            ? []
            : groupById.get(ref.id)!.vaults,
      ),
    ],
  };
}
