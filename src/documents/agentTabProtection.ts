import type { AgentSessionStatus } from '../shared/agentProtocol';
import type { TabSnapshot } from '../components/Editor/Editor';

function normalizeAbsolutePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

export function isAgentTabProtected(
  tab: TabSnapshot,
  statuses: Record<string, AgentSessionStatus>,
): boolean {
  if (tab.kind !== 'note') return false;
  const absolutePath = normalizeAbsolutePath(
    `${tab.vaultPath}/${tab.note.path}`,
  );
  return Object.values(statuses).some(
    (status) =>
      (status.state === 'connected' || status.state === 'writing') &&
      normalizeAbsolutePath(status.absolutePath) === absolutePath,
  );
}
