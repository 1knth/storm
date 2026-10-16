import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { groupColorForId, isGroupColor, type GroupColor } from '../shared/groupColors';

export interface RegisteredVault {
  id: string;
  name: string;
  path: string;
  groupId?: string | null;
}

export interface VaultGroup {
  id: string;
  name: string;
  collapsed: boolean;
  color?: GroupColor;
}

interface Settings extends Record<string, unknown> {
  vaults?: RegisteredVault[];
  activeVaultId?: string | null;
  lastVaultPath?: string;
  vaultGroups?: VaultGroup[];
}

const MAX_GROUP_NAME_LENGTH = 80;

function validateGroupName(name: string): string {
  if (typeof name !== 'string') throw new Error('Group name must be text');
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > MAX_GROUP_NAME_LENGTH) {
    throw new Error(`Group name must be 1–${MAX_GROUP_NAME_LENGTH} characters`);
  }
  return trimmed;
}

function validateUniqueName(
  name: string,
  groups: VaultGroup[],
  exceptId?: string,
): void {
  if (
    groups.some(
      (group) =>
        group.id !== exceptId &&
        group.name.toLowerCase() === name.toLowerCase(),
    )
  ) {
    throw new Error('A group with that name already exists');
  }
}

export class VaultRegistry {
  private readonly settingsFile: string;
  private settings: Settings = {};
  private loaded = false;

  constructor(userDataPath: string) {
    this.settingsFile = path.join(userDataPath, 'settings.json');
  }

  async list(): Promise<{
    vaults: RegisteredVault[];
    activeVaultId: string | null;
  }> {
    await this.load();
    return {
      vaults: [...(this.settings.vaults ?? [])],
      activeVaultId: this.settings.activeVaultId ?? null,
    };
  }

  async listGroups(): Promise<VaultGroup[]> {
    await this.load();
    return (this.settings.vaultGroups ?? []).map((group) => ({ ...group }));
  }

  async createGroup(name: string): Promise<VaultGroup> {
    await this.load();
    const trimmed = validateGroupName(name);
    const groups = this.settings.vaultGroups ?? [];
    validateUniqueName(trimmed, groups);
    const id = randomUUID();
    const group = { id, name: trimmed, collapsed: false, color: groupColorForId(id) };
    await this.update({ ...this.settings, vaultGroups: [...groups, group] });
    return { ...group };
  }

  async createGroupFromFolder(
    directory: string,
    name: string,
  ): Promise<VaultGroup> {
    await this.load();
    const trimmed = validateGroupName(name);
    const groups = this.settings.vaultGroups ?? [];
    validateUniqueName(trimmed, groups);

    const root = await realpath(directory);
    const entries = await readdir(root, { withFileTypes: true });
    const childPaths: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const childPath = path.join(root, entry.name);
      const info = await lstat(childPath);
      if (info.isDirectory() && !info.isSymbolicLink())
        childPaths.push(await realpath(childPath));
    }
    if (childPaths.length === 0)
      throw new Error(
        'The selected folder has no immediate child folders to add as vaults',
      );

    const id = randomUUID();
    const group = { id, name: trimmed, collapsed: false, color: groupColorForId(id) };
    const vaults = [...(this.settings.vaults ?? [])];
    for (const childPath of childPaths) {
      const existing = vaults.find((vault) => vault.path === childPath);
      if (existing) existing.groupId = group.id;
      else
        vaults.push({
          id: randomUUID(),
          name: path.basename(childPath),
          path: childPath,
          groupId: group.id,
        });
    }
    await this.update({
      ...this.settings,
      vaultGroups: [...groups, group],
      vaults,
    });
    return { ...group };
  }

  async renameGroup(id: string, name: string): Promise<VaultGroup> {
    await this.load();
    const trimmed = validateGroupName(name);
    const groups = this.settings.vaultGroups ?? [];
    const existing = groups.find((group) => group.id === id);
    if (!existing) throw new Error('Unknown vault group');
    validateUniqueName(trimmed, groups, id);
    const renamed = { ...existing, name: trimmed };
    await this.update({
      ...this.settings,
      vaultGroups: groups.map((group) => (group.id === id ? renamed : group)),
    });
    return { ...renamed };
  }

  async removeGroup(id: string): Promise<void> {
    await this.load();
    const groups = this.settings.vaultGroups ?? [];
    if (!groups.some((group) => group.id === id))
      throw new Error('Unknown vault group');
    const vaults = (this.settings.vaults ?? []).map((vault) =>
      vault.groupId === id ? { ...vault, groupId: null } : vault,
    );
    await this.update({
      ...this.settings,
      vaultGroups: groups.filter((group) => group.id !== id),
      vaults,
    });
  }

  async setVaultGroup(vaultId: string, groupId: string | null): Promise<void> {
    await this.load();
    const vaults = this.settings.vaults ?? [];
    if (!vaults.some((vault) => vault.id === vaultId))
      throw new Error('Unknown vault');
    if (
      groupId !== null &&
      !(this.settings.vaultGroups ?? []).some((group) => group.id === groupId)
    )
      throw new Error('Unknown vault group');
    await this.update({
      ...this.settings,
      vaults: vaults.map((vault) =>
        vault.id === vaultId ? { ...vault, groupId } : vault,
      ),
    });
  }

  async setGroupColor(id: string, color: unknown): Promise<void> {
    await this.load();
    if (!isGroupColor(color)) throw new Error('Invalid group color');
    const groups = this.settings.vaultGroups ?? [];
    if (!groups.some((group) => group.id === id))
      throw new Error('Unknown vault group');
    await this.update({
      ...this.settings,
      vaultGroups: groups.map((group) =>
        group.id === id ? { ...group, color } : group,
      ),
    });
  }

  async setGroupCollapsed(id: string, collapsed: boolean): Promise<void> {
    await this.load();
    if (typeof collapsed !== 'boolean')
      throw new Error('Collapsed must be a boolean');
    const groups = this.settings.vaultGroups ?? [];
    if (!groups.some((group) => group.id === id))
      throw new Error('Unknown vault group');
    await this.update({
      ...this.settings,
      vaultGroups: groups.map((group) =>
        group.id === id ? { ...group, collapsed } : group,
      ),
    });
  }

  async getById(id: string): Promise<RegisteredVault | null> {
    await this.load();
    return (
      (this.settings.vaults ?? []).find((vault) => vault.id === id) ?? null
    );
  }

  async add(
    directory: string,
  ): Promise<{ vault: RegisteredVault; created: boolean }> {
    await this.load();
    const canonicalPath = await realpath(directory);
    const vaults = this.settings.vaults ?? [];
    const existing = vaults.find((vault) => vault.path === canonicalPath);
    if (existing) return { vault: existing, created: false };
    const vault = {
      id: randomUUID(),
      name: path.basename(canonicalPath),
      path: canonicalPath,
    };
    await this.update({ ...this.settings, vaults: [...vaults, vault] });
    return { vault, created: true };
  }

  async setActive(id: string | null): Promise<void> {
    await this.load();
    if (
      id !== null &&
      !(this.settings.vaults ?? []).some((vault) => vault.id === id)
    )
      throw new Error('Unknown vault');
    const next = { ...this.settings, activeVaultId: id };
    delete next.lastVaultPath;
    await this.update(next);
  }

  async remove(id: string): Promise<void> {
    await this.load();
    const vaults = this.settings.vaults ?? [];
    const removed = vaults.find((vault) => vault.id === id);
    if (!removed) return;
    const next = {
      ...this.settings,
      vaults: vaults.filter((vault) => vault.id !== id),
    };
    if (next.activeVaultId === id) next.activeVaultId = null;
    await this.update(next);
  }

  private async update(settings: Settings): Promise<void> {
    await this.persist(settings);
    this.settings = settings;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed: unknown = JSON.parse(
        await readFile(this.settingsFile, 'utf8'),
      );
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        this.settings = parsed as Settings;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!Array.isArray(this.settings.vaults)) this.settings.vaults = [];
    const rawGroups: unknown = this.settings.vaultGroups;
    const groups: VaultGroup[] = [];
    if (Array.isArray(rawGroups)) {
      for (const candidate of rawGroups) {
        if (!candidate || typeof candidate !== 'object') continue;
        const group = candidate as Partial<VaultGroup>;
        if (
          typeof group.id !== 'string' ||
          !group.id ||
          typeof group.name !== 'string'
        )
          continue;
        let name: string;
        try {
          name = validateGroupName(group.name);
        } catch {
          continue;
        }
        if (
          groups.some(
            (valid) =>
              valid.id === group.id ||
              valid.name.toLowerCase() === name.toLowerCase(),
          )
        )
          continue;
        groups.push({
          id: group.id,
          name,
          collapsed: group.collapsed === true,
          color: isGroupColor(group.color)
            ? group.color
            : groupColorForId(group.id),
        });
      }
    }
    this.settings.vaultGroups = groups;
    const validGroupIds = new Set(groups.map((group) => group.id));
    this.settings.vaults = this.settings.vaults.map((vault) =>
      vault.groupId && !validGroupIds.has(vault.groupId)
        ? { ...vault, groupId: null }
        : vault,
    );
    if (this.settings.lastVaultPath && this.settings.vaults.length === 0) {
      try {
        const canonicalPath = await realpath(this.settings.lastVaultPath);
        this.settings.vaults.push({
          id: randomUUID(),
          name: path.basename(canonicalPath),
          path: canonicalPath,
        });
        this.settings.activeVaultId = this.settings.vaults[0].id;
        await this.persist(this.settings);
      } catch {
        const legacy = path.resolve(this.settings.lastVaultPath);
        this.settings.vaults.push({
          id: randomUUID(),
          name: path.basename(legacy),
          path: legacy,
        });
        this.settings.activeVaultId = this.settings.vaults[0].id;
      }
    }
    this.loaded = true;
  }

  private async persist(settings: Settings): Promise<void> {
    const directory = path.dirname(this.settingsFile);
    await mkdir(directory, { recursive: true });
    const temporary = `${this.settingsFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
      flag: 'wx',
    });
    await rename(temporary, this.settingsFile);
  }
}
