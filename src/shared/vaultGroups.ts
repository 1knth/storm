import type { RegisteredVault, SidebarRootRef, VaultGroup } from './types';
import { deriveVaultSidebarLayout } from './vaultSidebarLayout';

export function deriveVisibleVaults(
  vaults: RegisteredVault[],
  groups: VaultGroup[],
  rootOrder: SidebarRootRef[] = [],
): RegisteredVault[] {
  return deriveVaultSidebarLayout(vaults, groups, rootOrder).visibleVaults;
}
