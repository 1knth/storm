import type { TabSnapshot } from './Editor';

export type TabPresenceSnapshot = { tab: TabSnapshot; rect: DOMRect };

export function removedTabSnapshots(
  previousIds: Set<string>,
  previousTabs: Map<string, TabSnapshot>,
  previousRects: Map<string, DOMRect>,
  currentIds: Set<string>,
): TabPresenceSnapshot[] {
  return [...previousIds].flatMap((id) => {
    if (currentIds.has(id)) return [];
    const tab = previousTabs.get(id);
    const rect = previousRects.get(id);
    return tab && rect ? [{ tab, rect }] : [];
  });
}
