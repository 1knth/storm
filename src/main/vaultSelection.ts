import type { VaultRegistry } from '../vault/vaultRegistry';
import type { VaultService } from '../vault/vaultService';

/** Persist selection once, then update observational services such as the watcher. */
export async function activateVaultSelection(
  registry: VaultRegistry,
  service: VaultService,
  id: string,
  selected: () => Promise<string | null>,
): Promise<{ id: string; path: string | null }> {
  const { vaults } = await registry.list();
  const vault = vaults.find((entry) => entry.id === id);
  if (!vault) throw new Error('Unknown vault');
  await service.selectVault(vault.path);
  await registry.setActive(id);
  await selected();
  return { id, path: service.getSelectedVaultPath() };
}
