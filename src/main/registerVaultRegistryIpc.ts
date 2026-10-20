import type { VaultRegistry } from '../vault/vaultRegistry';
import type { VaultService } from '../vault/vaultService';
import type { VaultWriteBarrier } from '../vault/writeBarrier';

export interface IpcHandlerRegistrar {
  handle(channel: string, listener: (...args: unknown[]) => unknown): void;
}

export function registerVaultRegistryIpc(
  ipc: IpcHandlerRegistrar,
  dependencies: {
    registry: VaultRegistry;
    service: VaultService;
    writeBarrier: VaultWriteBarrier;
    watchSelectedVault: () => Promise<string | null>;
    stopWatcher: () => void;
    clearWatchedVaultId: () => void;
    hasWritableAgentSession?: (vaultId: string) => boolean;
    withVaultLifecycle?<T>(
      root: string,
      operation: () => Promise<T>,
    ): Promise<T>;
    openPath: (directory: string) => Promise<string>;
  },
): void {
  const { registry, service, writeBarrier } = dependencies;
  ipc.handle('vault:open-directory', async () => {
    const directory = service.getSelectedVaultPath();
    if (!directory) throw new Error('No vault selected');
    const error = await dependencies.openPath(directory);
    if (error) throw new Error(error);
  });
  ipc.handle('vault:registry-list', () => registry.list());
  ipc.handle('vault:groups-list', () => registry.listGroups());
  ipc.handle('vault:sidebar-move', (_event, value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid sidebar move');
    const request = value as Record<string, unknown>;
    const validRef = (ref: unknown) =>
      !!ref &&
      typeof ref === 'object' &&
      !Array.isArray(ref) &&
      typeof (ref as Record<string, unknown>).id === 'string' &&
      !!(ref as Record<string, unknown>).id &&
      ((ref as Record<string, unknown>).kind === 'vault' ||
        (ref as Record<string, unknown>).kind === 'group');
    if (
      !validRef(request.item) ||
      (request.before !== null && !validRef(request.before))
    )
      throw new Error('Invalid sidebar move');
    return registry.moveSidebarItem(
      request as unknown as import('../shared/types').SidebarMoveRequest,
    );
  });
  ipc.handle('vault:placement-set', (_event, value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid vault placement');
    const request = value as Record<string, unknown>;
    if (
      typeof request.vaultId !== 'string' ||
      (request.groupId !== null && typeof request.groupId !== 'string') ||
      typeof request.pinned !== 'boolean' ||
      (request.beforeVaultId !== null &&
        typeof request.beforeVaultId !== 'string')
    )
      throw new Error('Invalid vault placement');
    return registry.setVaultPlacement(
      request as {
        vaultId: string;
        groupId: string | null;
        pinned: boolean;
        beforeVaultId: string | null;
      },
    );
  });
  ipc.handle('vault:groups-reorder', (_event, value: unknown) => {
    if (!Array.isArray(value) || value.some((id) => typeof id !== 'string'))
      throw new Error('Invalid group order');
    return registry.reorderGroups(value);
  });
  ipc.handle('vault:tab-layout-get', (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Invalid vault ID');
    return registry.getTabLayout(id);
  });
  ipc.handle(
    'vault:tab-layout-save',
    (_event, id: unknown, layout: unknown) => {
      if (typeof id !== 'string') throw new Error('Invalid vault ID');
      return registry.saveTabLayout(
        id,
        layout as import('../shared/types').SavedTabLayout,
      );
    },
  );
  ipc.handle('vault:group-create', (_event, name: unknown) => {
    if (typeof name !== 'string') throw new Error('Invalid group name');
    return registry.createGroup(name);
  });
  ipc.handle('vault:group-rename', (_event, id: unknown, name: unknown) => {
    if (typeof id !== 'string' || typeof name !== 'string')
      throw new Error('Invalid group rename');
    return registry.renameGroup(id, name);
  });
  ipc.handle('vault:group-remove', (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Invalid vault group ID');
    return registry.removeGroup(id);
  });
  ipc.handle(
    'vault:group-set-vault',
    (_event, vaultId: unknown, groupId: unknown) => {
      if (
        typeof vaultId !== 'string' ||
        (groupId !== null && typeof groupId !== 'string')
      )
        throw new Error('Invalid vault group assignment');
      return registry.setVaultGroup(vaultId, groupId);
    },
  );
  ipc.handle('vault:group-set-color', (_event, id: unknown, color: unknown) => {
    if (typeof id !== 'string') throw new Error('Invalid vault group ID');
    return registry.setGroupColor(id, color);
  });
  ipc.handle(
    'vault:group-set-collapsed',
    (_event, id: unknown, collapsed: unknown) => {
      if (typeof id !== 'string' || typeof collapsed !== 'boolean')
        throw new Error('Invalid group collapse state');
      return registry.setGroupCollapsed(id, collapsed);
    },
  );
  ipc.handle('vault:registry-add', async (_event, directory: unknown) => {
    if (typeof directory !== 'string')
      throw new Error('Invalid vault directory');
    return registry.add(directory);
  });
  ipc.handle('vault:registry-activate', async (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Invalid vault ID');
    const { vaults } = await registry.list();
    const selected = vaults.find((vault) => vault.id === id);
    if (!selected) throw new Error('Unknown vault');
    await service.selectVault(selected.path);
    await registry.setActive(id);
    await dependencies.watchSelectedVault();
    return { id, path: service.getSelectedVaultPath() };
  });
  ipc.handle('vault:registry-remove', (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Invalid vault ID');
    return registry.remove(id);
  });
  ipc.handle('vault:registry-unload-one', async (_event, id: unknown) => {
    if (typeof id !== 'string' || !id) throw new Error('Invalid vault ID');
    const withLifecycle =
      dependencies.withVaultLifecycle ?? ((_root, operation) => operation());
    const { vaults } = await registry.list();
    const vault = vaults.find((entry) => entry.id === id);
    if (!vault) throw new Error('Unknown vault');
    return withLifecycle(vault.path, () =>
      writeBarrier.close(async () => {
        const { vaults: currentVaults, activeVaultId } = await registry.list();
        if (!currentVaults.some((entry) => entry.id === id))
          throw new Error('Unknown vault');
        if (dependencies.hasWritableAgentSession?.(id))
          throw new Error(
            'Stop the connected agent session before unloading this vault.',
          );
        await registry.remove(id);
        if (activeVaultId === id) {
          dependencies.stopWatcher();
          dependencies.clearWatchedVaultId();
          service.clearSelectedVault();
        }
      }),
    );
  });
  ipc.handle('vault:registry-unload-all', () =>
    writeBarrier.close(async () => {
      await registry.unloadAll();
      dependencies.stopWatcher();
      dependencies.clearWatchedVaultId();
      service.clearSelectedVault();
    }),
  );
}
