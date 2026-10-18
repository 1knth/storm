import type { TabSnapshot } from './Editor';

export function closeTabTransition(
  tabs: TabSnapshot[],
  targetId: string,
  activeId: string | null,
  getTabId: (tab: TabSnapshot) => string,
) {
  const remaining = tabs.filter((tab) => getTabId(tab) !== targetId);
  const wasActive = targetId === activeId;
  return {
    remaining,
    wasActive,
    nextActive: wasActive ? (remaining.at(-1) ?? null) : null,
  };
}
