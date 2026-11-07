import { activateVaultSelection } from './vaultSelection';
import { BrowserWindow, dialog, shell, type IpcMain } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { VaultService } from '../vault/vaultService';
import type { VaultRegistry } from '../vault/vaultRegistry';
import type { VaultMutationCoordinator } from '../vault/mutationCoordinator';
import type { AgentBroker } from './agentBroker';
import { resolveVaultNote } from '../vault/vaultNoteResolver';
import {
  readVaultAsset,
  readVaultImage,
  readVaultPdf,
} from '../vault/vaultAssets';
import { savePastedImage } from '../vault/pasteImage';
import { createFolder, createMarkdownNote } from '../vault/vaultCreation';
import {
  assertDeletionTargetUnchanged,
  resolveDeletionTarget,
} from '../vault/vaultDeletion';
import {
  classifyVaultListError,
  formatVaultListError,
} from './vaultListLogging';
export function registerVaultIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  dependencies: {
    vaultService: VaultService;
    vaultRegistry: VaultRegistry;
    vaultWriteBarrier: VaultMutationCoordinator;
    agentBroker: AgentBroker;
    watchSelectedVault: () => Promise<string | null>;
    invalidateSelectedVault: (id: string) => void;
  },
): void {
  const {
    vaultService,
    vaultRegistry,
    vaultWriteBarrier,
    agentBroker,
    watchSelectedVault,
    invalidateSelectedVault,
  } = dependencies;
  ipcMain.handle('vault:restore', async () => {
    return vaultWriteBarrier.run(async () => {
      try {
        const { vaults, activeVaultId } = await vaultRegistry.list();
        const savedPath = vaults.find(
          (vault) => vault.id === activeVaultId,
        )?.path;
        if (!savedPath) return { path: null, error: null };
        await vaultService.selectVault(savedPath);
        await watchSelectedVault();
        return { path: vaultService.getSelectedVaultPath(), error: null };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          return { path: null, error: null };
        }
        return {
          path: null,
          error: `Could not restore the last vault: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    });
  });

  ipcMain.handle('vault:choose', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
    });
    if (result.canceled) return { path: null, warning: null };
    const selectedPath = result.filePaths[0];
    if (!selectedPath) return { path: null, warning: null };
    return vaultWriteBarrier.run(async () => {
      await vaultService.selectVault(selectedPath);
      const validatedPath = vaultService.getSelectedVaultPath()!;
      try {
        const { vault } = await vaultRegistry.add(validatedPath);
        await activateVaultSelection(
          vaultRegistry,
          vaultService,
          vault.id,
          watchSelectedVault,
        );
        return { path: validatedPath, warning: null };
      } catch (error) {
        return {
          path: validatedPath,
          warning: `Vault opened, but the vault selection could not be saved: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    });
  });

  const pendingGroupFolders = new Map<
    string,
    { directory: string; createdAt: number }
  >();
  const groupFolderCreatesInFlight = new Set<string>();
  const GROUP_FOLDER_SELECTION_TTL_MS = 10 * 60 * 1000;
  const MAX_PENDING_GROUP_FOLDERS = 20;
  ipcMain.handle('vault:group-folder-choose', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const selectionId = randomUUID();
    const now = Date.now();
    for (const [id, selection] of pendingGroupFolders) {
      if (now - selection.createdAt > GROUP_FOLDER_SELECTION_TTL_MS)
        pendingGroupFolders.delete(id);
    }
    while (pendingGroupFolders.size >= MAX_PENDING_GROUP_FOLDERS) {
      const oldestId = pendingGroupFolders.keys().next().value;
      if (!oldestId) break;
      pendingGroupFolders.delete(oldestId);
    }
    pendingGroupFolders.set(selectionId, {
      directory: result.filePaths[0],
      createdAt: now,
    });
    return { selectionId, name: path.basename(result.filePaths[0]) };
  });
  ipcMain.handle(
    'vault:group-create-from-folder',
    async (_event, selectionId: unknown, name: unknown) => {
      if (typeof selectionId !== 'string' || typeof name !== 'string')
        throw new Error('Invalid folder-based group request');
      const selection = pendingGroupFolders.get(selectionId);
      if (
        !selection ||
        Date.now() - selection.createdAt > GROUP_FOLDER_SELECTION_TTL_MS
      ) {
        pendingGroupFolders.delete(selectionId);
        throw new Error('Folder selection expired; please choose it again');
      }
      if (groupFolderCreatesInFlight.has(selectionId))
        throw new Error('Folder-based group creation is already in progress');
      groupFolderCreatesInFlight.add(selectionId);
      try {
        const result = await vaultWriteBarrier.run(() =>
          vaultRegistry.createGroupFromFolder(selection.directory, name),
        );
        pendingGroupFolders.delete(selectionId);
        return result;
      } finally {
        groupFolderCreatesInFlight.delete(selectionId);
      }
    },
  );

  ipcMain.handle(
    'vault:resolve-note-link',
    async (_event, request: unknown) => {
      if (!request || typeof request !== 'object' || Array.isArray(request))
        return { ok: false, reason: 'invalid' as const };
      const { vaultId, notePath, target } = request as Record<string, unknown>;
      if (
        typeof vaultId !== 'string' ||
        typeof notePath !== 'string' ||
        typeof target !== 'string'
      )
        return { ok: false, reason: 'invalid' as const };
      const vault = await vaultRegistry.getById(vaultId);
      if (!vault) return { ok: false, reason: 'invalid' as const };
      try {
        const path = await resolveVaultNote(vault.path, notePath, target);
        return { ok: true, path };
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        const reason = /ambiguous/i.test(message)
          ? 'ambiguous'
          : /not found/i.test(message)
            ? 'missing'
            : 'invalid';
        return { ok: false, reason };
      }
    },
  );

  ipcMain.handle('vault:paste-image', async (_event, request: unknown) => {
    if (!request || typeof request !== 'object' || Array.isArray(request))
      throw new Error('Invalid paste image request');
    const value = request as Record<string, unknown>;
    if (
      typeof value.vaultId !== 'string' ||
      typeof value.notePath !== 'string' ||
      typeof value.mimeType !== 'string' ||
      typeof value.base64 !== 'string'
    )
      throw new Error('Invalid paste image request');
    const { vaultId, notePath, mimeType, base64 } = value as {
      vaultId: string;
      notePath: string;
      mimeType: string;
      base64: string;
    };
    const vault = await vaultRegistry.getById(vaultId);
    if (!vault) throw new Error('Unknown vault');
    return vaultWriteBarrier.mutate(vault.path, async () => {
      if ((await vaultRegistry.getById(vaultId))?.path !== vault.path)
        throw new Error('Vault is no longer registered');
      const result = await savePastedImage(vault.path, {
        vaultId,
        notePath,
        mimeType,
        base64,
      });
      invalidateSelectedVault(vaultId);
      return result;
    });
  });

  ipcMain.handle('vault:read-asset', async (_event, request: unknown) => {
    if (!request || typeof request !== 'object' || Array.isArray(request))
      throw new Error('Invalid asset request');
    const { vaultId, relativePath } = request as Record<string, unknown>;
    if (typeof vaultId !== 'string' || typeof relativePath !== 'string')
      throw new Error('Invalid asset request');
    const vault = await vaultRegistry.getById(vaultId);
    if (!vault) throw new Error('Unknown vault');
    try {
      return { ok: true, ...(await readVaultAsset(vault.path, relativePath)) };
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const reason = /not found|ENOENT/i.test(message)
        ? 'not-found'
        : /unsupported|content does not match/i.test(message)
          ? 'unsupported'
          : 'unavailable';
      return { ok: false, reason };
    }
  });

  ipcMain.handle('vault:read-pdf', async (_event, request: unknown) => {
    if (!request || typeof request !== 'object' || Array.isArray(request))
      throw new Error('Invalid PDF request');
    const { vaultId, relativePath } = request as Record<string, unknown>;
    if (typeof vaultId !== 'string' || typeof relativePath !== 'string')
      throw new Error('Invalid PDF request');
    const vault = await vaultRegistry.getById(vaultId);
    if (!vault) throw new Error('Unknown vault');
    return readVaultPdf(vault.path, relativePath);
  });

  ipcMain.handle('vault:read-image', async (_event, request: unknown) => {
    if (!request || typeof request !== 'object')
      throw new Error('Invalid image request');
    const { vaultId, notePath, imagePath, kind } = request as Record<
      string,
      unknown
    >;
    if (typeof vaultId !== 'string') throw new Error('Invalid vault ID');
    const vault = await vaultRegistry.getById(vaultId);
    if (!vault) throw new Error('Unknown vault');
    if (typeof notePath !== 'string' || typeof imagePath !== 'string')
      throw new Error('Invalid image request');
    try {
      const image = await readVaultImage(vault.path, {
        notePath,
        imagePath,
        kind: kind as 'markdown' | 'wiki' | undefined,
      });
      return { ok: true, ...image };
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const reason = /not found/i.test(message)
        ? 'not-found'
        : /ambiguous/i.test(message)
          ? 'ambiguous'
          : /unsupported|content does not match/i.test(message)
            ? 'unsupported'
            : 'unavailable';
      return { ok: false, reason };
    }
  });

  for (const [channel, create] of [
    ['vault:create-note', createMarkdownNote],
    ['vault:create-folder', createFolder],
  ] as const)
    ipcMain.handle(channel, async (_event, request: unknown) => {
      if (!request || typeof request !== 'object' || Array.isArray(request))
        throw new Error('Invalid creation request');
      const { vaultId, parentRelativePath, name } = request as Record<
        string,
        unknown
      >;
      if (
        typeof vaultId !== 'string' ||
        typeof parentRelativePath !== 'string' ||
        typeof name !== 'string'
      )
        throw new Error('Invalid creation request');
      const vault = await vaultRegistry.getById(vaultId);
      if (!vault) throw new Error('Unknown vault');
      return vaultWriteBarrier.mutate(vault.path, async () => {
        if ((await vaultRegistry.getById(vaultId))?.path !== vault.path)
          throw new Error('Vault is no longer registered');
        const entry = await create(vault.path, parentRelativePath, name);
        invalidateSelectedVault(vaultId);
        return entry;
      });
    });

  ipcMain.handle('vault:delete-entry', async (event, request: unknown) => {
    if (!request || typeof request !== 'object' || Array.isArray(request))
      throw new Error('Invalid deletion request');
    const { vaultId, path: relativePath } = request as Record<string, unknown>;
    if (typeof vaultId !== 'string' || typeof relativePath !== 'string')
      throw new Error('Invalid deletion request');
    const vault = await vaultRegistry.getById(vaultId);
    if (!vault) throw new Error('Unknown vault');
    const target = await resolveDeletionTarget(vault.path, relativePath);
    const window = BrowserWindow.fromWebContents(event.sender);
    const description =
      target.kind === 'folder'
        ? 'Folder.'
        : target.kind === 'image'
          ? 'Image.'
          : target.kind === 'pdf'
            ? 'PDF document.'
            : 'Markdown note.';
    const contains =
      target.kind === 'folder' ? ' Its entire contents will be moved.' : '';
    const choice = await dialog.showMessageBox(
      window ?? BrowserWindow.getFocusedWindow()!,
      {
        type: 'warning',
        buttons: ['Cancel', 'Move to Trash'],
        defaultId: 0,
        cancelId: 0,
        message: `Move “${target.relativePath}” to Trash?`,
        detail: `${description}${contains}`,
        noLink: true,
      },
    );
    if (choice.response !== 1)
      return { deleted: false, path: target.relativePath, kind: target.kind };
    return vaultWriteBarrier.mutate(vault.path, async () => {
      if ((await vaultRegistry.getById(vaultId))?.path !== vault.path)
        throw new Error('Vault is no longer registered');
      await assertDeletionTargetUnchanged(target);
      await shell.trashItem(target.absolutePath);
      invalidateSelectedVault(vaultId);
      return { deleted: true, path: target.relativePath, kind: target.kind };
    });
  });

  ipcMain.handle('vault:list-notes', async () => {
    try {
      return await vaultService.listNotes({ previews: true });
    } catch (error) {
      const trace = randomUUID().slice(0, 8);
      const severity = classifyVaultListError(error);
      console.error(formatVaultListError(severity, trace, error));
      throw error;
    }
  });

  ipcMain.handle('vault:read-note', async (_event, relativePath: unknown) =>
    vaultService.readNote(relativePath),
  );
  ipcMain.handle('vault:rename-entry', async (_event, request: unknown) => {
    if (!request || typeof request !== 'object' || Array.isArray(request))
      throw new Error('Invalid rename request');
    const value = request as Record<string, unknown>;
    if (typeof value.path !== 'string' || typeof value.newName !== 'string')
      throw new Error('Invalid rename request');
    const selectedPath = vaultService.getSelectedVaultPath();
    if (!selectedPath) throw new Error('No vault selected');
    const { vaults } = await vaultRegistry.list();
    const selected = vaults.find((vault) => vault.path === selectedPath);
    if (!selected) throw new Error('Selected vault is not registered');
    return vaultWriteBarrier.maintain(
      selectedPath,
      () => agentBroker.waitForMaintenanceLease(selected.id),
      async () => {
        if (vaultService.getSelectedVaultPath() !== selectedPath)
          throw new Error('Selected vault changed; rename cancelled');
        const result = await vaultService.renameEntryAndUpdateLinks(
          value.path,
          value.newName,
        );
        invalidateSelectedVault(selected.id);
        return result;
      },
    );
  });
  ipcMain.handle('vault:save-note', async (_event, request: unknown) =>
    vaultWriteBarrier.mutate(
      request &&
        typeof request === 'object' &&
        typeof (request as Record<string, unknown>).vaultPath === 'string'
        ? (request as { vaultPath: string }).vaultPath
        : (vaultService.getSelectedVaultPath() ?? ''),
      async () => {
        const result = await vaultService.saveNote(request);
        if (request && typeof request === 'object') {
          const value = request as Record<string, unknown>;
          if (
            typeof value.vaultPath === 'string' &&
            typeof value.path === 'string'
          ) {
            const { vaults } = await vaultRegistry.list();
            const vaultId = vaults.find(
              (vault) => vault.path === value.vaultPath,
            )?.id;
            if (vaultId) invalidateSelectedVault(vaultId);
          }
        }
        return result;
      },
    ),
  );
}
