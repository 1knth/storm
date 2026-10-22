import type { AgentContext, AgentContextNote } from '../shared/agentProtocol';
import type { RegisteredVault } from '../shared/types';
import type { TabSnapshot } from '../components/Editor/Editor';
import { getTabId } from '../components/Editor/tabGroups';

/** Build a point-in-time context from registered vaults and the actual open tabs. */
export function createAgentContext(
  vaults: RegisteredVault[],
  activeVaultId: string | null,
  tabs: TabSnapshot[],
  activeId: string | null,
): AgentContext {
  const registeredVaults = vaults.map(({ id, name, path }) => ({
    id,
    name,
    path,
  }));
  const roots = new Map(vaults.map(({ id, path }) => [id, path]));
  const toNote = (
    tab: Extract<TabSnapshot, { kind: 'note' }>,
  ): AgentContextNote | null => {
    const root = roots.get(tab.vaultId);
    if (!root) return null;
    const relativePath = tab.note.path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!relativePath || relativePath.split('/').includes('..')) return null;
    const normalizedRoot = root.replace(/[\\/]+$/, '');
    return {
      vaultId: tab.vaultId,
      path: `${normalizedRoot}/${relativePath}`,
      relativePath,
    };
  };
  const seen = new Set<string>();
  const openNotes: AgentContextNote[] = [];
  for (const tab of tabs) {
    if (tab.kind !== 'note') continue;
    const note = toNote(tab);
    if (!note) continue;
    const key = JSON.stringify([note.vaultId, note.relativePath]);
    if (seen.has(key)) continue;
    seen.add(key);
    openNotes.push(note);
  }
  const activeTab = tabs.find((tab) => getTabId(tab) === activeId);
  const activeNote =
    activeTab?.kind === 'note' && activeTab.vaultId === activeVaultId
      ? toNote(activeTab)
      : null;
  return { registeredVaults, activeVaultId, activeNote, openNotes };
}
