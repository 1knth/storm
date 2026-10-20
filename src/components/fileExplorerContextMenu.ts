import type { ContextMenuItem } from './ContextMenu';

type ExplorerTarget = { path: string; kind: 'note' | 'folder' | 'image' };

export function getExplorerContextMenuItems(
  target: ExplorerTarget | null,
  parent: string,
  onCreate: (kind: 'note' | 'folder', parentPath: string) => void,
  onDeleteEntry?: (path: string, kind: ExplorerTarget['kind']) => void,
  onOpenLocation?: (path: string, kind: ExplorerTarget['kind']) => void,
): ContextMenuItem[] {
  const locationAction: ContextMenuItem[] =
    target && onOpenLocation
      ? [
          {
            id: 'open-location',
            label: 'Open Location',
            onSelect: () => onOpenLocation(target.path, target.kind),
          },
        ]
      : [];
  const deleteAction: ContextMenuItem[] =
    target && onDeleteEntry
      ? [
          {
            id: 'delete-entry',
            label: `Move ${target.kind} to Trash…`,
            danger: true,
            onSelect: () => onDeleteEntry(target.path, target.kind),
          },
        ]
      : [];

  if (target && target.kind !== 'folder') {
    return [...locationAction, ...deleteAction];
  }

  return [
    ...(['note', 'folder'] as const).map((kind) => ({
      id: `new-${kind}`,
      label: `New ${kind}`,
      onSelect: () => onCreate(kind, parent),
    })),
    ...(target && (locationAction.length || deleteAction.length)
      ? [{ type: 'separator' as const, id: 'entry-actions' }]
      : []),
    ...locationAction,
    ...deleteAction,
  ];
}
