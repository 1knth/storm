import type { RegisteredVault, VaultGroup } from './types';

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
) {
  return {
    pinnedVaults: vaults.filter((vault) => vault.pinned === true),
    ungroupedVaults: vaults.filter(
      (vault) =>
        vault.pinned !== true &&
        (!vault.groupId || !groups.some((group) => group.id === vault.groupId)),
    ),
    groups: groups.map((group) => ({
      ...group,
      vaults: vaults.filter(
        (vault) => vault.pinned !== true && vault.groupId === group.id,
      ),
    })),
  };
}
