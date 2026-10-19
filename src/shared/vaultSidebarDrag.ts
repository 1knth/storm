import type { RegisteredVault } from './types';

export type VaultSidebarDragPayload =
  | { kind: 'vault'; id: string }
  | { kind: 'group'; id: string };

export interface SidebarDropEvent {
  dataTransfer: { getData: (type: string) => string };
  preventDefault: () => void;
  stopPropagation: () => void;
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
