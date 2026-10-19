import type { ContextMenuItem } from './ContextMenu';

type ExplorerTarget = { path: string; kind: 'note' | 'folder' | 'image' };

export function getExplorerContextMenuItems(
  target: ExplorerTarget | null,
  parent: string,
  onCreate: (kind: 'note' | 'folder', parentPath: string) => void,
  onDeleteEntry?: (path: string, kind: ExplorerTarget['kind']) => void,
): ContextMenuItem[] {
  if (target && target.kind !== 'folder') {
    return onDeleteEntry
      ? [
          {
            id: 'delete-entry',
            label: `Move ${target.kind} to Trash…`,
            danger: true,
            onSelect: () => onDeleteEntry(target.path, target.kind),
          },
        ]
      : [];
  }

  return [
    ...(['note', 'folder'] as const).map((kind) => ({
      id: `new-${kind}`,
      label: `New ${kind}`,
      onSelect: () => onCreate(kind, parent),
    })),
    ...(target && onDeleteEntry
      ? [
          { type: 'separator' as const, id: 'entry-actions' },
          {
            id: 'delete-entry',
            label: `Move ${target.kind} to Trash…`,
            danger: true,
            onSelect: () => onDeleteEntry(target.path, target.kind),
          },
        ]
      : []),
  ];
}
