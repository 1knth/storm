import type { RegisteredVault } from './types';

export type VaultSidebarDragPayload =
  | { kind: 'vault'; id: string }
  | { kind: 'group'; id: string };

export interface SidebarDropEvent {
  dataTransfer: { getData: (type: string) => string };
  preventDefault: () => void;
  stopPropagation: () => void;
}

export interface SidebarDragStartEvent {
  dataTransfer: {
    setData: (type: string, value: string) => void;
    effectAllowed: string;
  };
  stopPropagation: () => void;
}

export function beginVaultSidebarDrag(
  event: SidebarDragStartEvent,
  payload: VaultSidebarDragPayload,
): void {
  event.dataTransfer.setData(
    'application/x-vault-sidebar',
    JSON.stringify(payload),
  );
  event.dataTransfer.effectAllowed = 'move';
  event.stopPropagation();
}

export function groupHeaderVaultDrop(
  clientY: number,
  top: number,
  height: number,
  groupId: string,
  firstUngroupedVaultId: string | null,
):
  | { groupId: null; beforeVaultId: string | null }
  | { groupId: string; beforeVaultId: null } {
  const edgeSize = Math.min(8, height * 0.25);
  if (clientY < top + edgeSize) {
    return { groupId: null, beforeVaultId: firstUngroupedVaultId };
  }
  return { groupId, beforeVaultId: null };
}

export function rootItemDropAnchor<
  T extends { kind: 'vault' | 'group'; id: string },
>(items: T[], dragged: T, target: T, after: boolean): T | null | undefined {
  if (dragged.kind === target.kind && dragged.id === target.id)
    return undefined;
  const remaining = items.filter(
    (item) => !(item.kind === dragged.kind && item.id === dragged.id),
  );
  const targetIndex = remaining.findIndex(
    (item) => item.kind === target.kind && item.id === target.id,
  );
  if (targetIndex < 0) return undefined;
  return remaining[targetIndex + (after ? 1 : 0)] ?? null;
}

export function groupDropAnchor(
  groups: { id: string }[],
  draggedId: string,
  targetId: string,
  after: boolean,
): string | null {
  const remaining = groups.filter((group) => group.id !== draggedId);
  const targetIndex = remaining.findIndex((group) => group.id === targetId);
  if (targetIndex < 0) return null;
  return remaining[targetIndex + (after ? 1 : 0)]?.id ?? null;
}

export function readVaultSidebarDragPayload(
  event: Pick<SidebarDropEvent, 'dataTransfer'>,
): VaultSidebarDragPayload | null {
  try {
    const value: unknown = JSON.parse(
      event.dataTransfer.getData('application/x-vault-sidebar'),
    );
    if (
      typeof value !== 'object' ||
      value === null ||
      !('kind' in value) ||
      !('id' in value) ||
      typeof value.id !== 'string' ||
      !value.id ||
      (value.kind !== 'vault' && value.kind !== 'group')
    )
      return null;
    return value as VaultSidebarDragPayload;
  } catch {
    return null;
  }
}

/** A drop target is a routing boundary, even for malformed or unrelated drags. */
export function handleVaultSidebarDrop(
  event: SidebarDropEvent,
  handle: (payload: VaultSidebarDragPayload | null) => void,
): void {
  event.preventDefault();
  event.stopPropagation();
  handle(readVaultSidebarDragPayload(event));
}

export function vaultPlacementForDrop(
  source: RegisteredVault,
  target: {
    groupId: string | null;
    pinned: boolean;
    beforeVaultId: string | null;
  },
) {
  return {
    vaultId: source.id,
    ...target,
    groupId: target.pinned ? (source.groupId ?? null) : target.groupId,
  };
}

/** Return the next lane item as the insertion anchor; null means append. */
export function vaultDropAnchor(
  order: RegisteredVault[],
  targetId: string,
  clientY: number,
  top: number,
  height: number,
  draggedId: string,
): string | null | undefined {
  const targetIndex = order.findIndex((vault) => vault.id === targetId);
  if (targetIndex < 0) return undefined;
  if (targetId === draggedId) return draggedId;
  const remaining = order.filter((vault) => vault.id !== draggedId);
  const target = remaining.findIndex((vault) => vault.id === targetId);
  if (target < 0) return null;
  const after = clientY >= top + height / 2;
  return remaining[after ? target + 1 : target]?.id ?? null;
}

/** Reorder an item by before-anchor in its current order. */
export function reorderBefore(
  order: string[],
  draggedId: string,
  beforeId: string | null,
): string[] | null {
  if (!order.includes(draggedId) || beforeId === draggedId) return null;
  const result = order.filter((id) => id !== draggedId);
  const index = beforeId === null ? result.length : result.indexOf(beforeId);
  if (index < 0) return null;
  result.splice(index, 0, draggedId);
  return result;
}
