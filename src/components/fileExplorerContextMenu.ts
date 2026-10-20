import type { ContextMenuItem } from './ContextMenu';

type ExplorerTarget = { path: string; kind: 'note' | 'folder' | 'image' };

export function absoluteExplorerPath(
  vaultPath: string,
  relativePath: string,
): string {
  const separator = vaultPath.includes('\\') ? '\\' : '/';
  const root = vaultPath.replace(/[\\/]+$/, '');
  const relative = relativePath
    .replace(/[\\/]+/g, separator)
    .replace(/^[/\\]+/, '');
  return `${root}${separator}${relative}`;
}

export function getExplorerContextMenuItems(
  target: ExplorerTarget | null,
  parent: string,
  onCreate: (kind: 'note' | 'folder', parentPath: string) => void,
  onDeleteEntry?: (path: string, kind: ExplorerTarget['kind']) => void,
  onOpenLocation?: (path: string, kind: ExplorerTarget['kind']) => void,
  onRename?: (path: string, kind: ExplorerTarget['kind']) => void,
  onCopyPath?: (path: string, kind: ExplorerTarget['kind']) => void,
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
  const copyPathAction: ContextMenuItem[] =
    target && onCopyPath
      ? [
          {
            id: 'copy-path',
            label: 'Copy Path',
            onSelect: () => onCopyPath(target.path, target.kind),
          },
        ]
      : [];
  const renameAction: ContextMenuItem[] =
    target && onRename
      ? [
          {
            id: 'rename-entry',
            label: 'Rename…',
            onSelect: () => onRename(target.path, target.kind),
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
    return [
      ...renameAction,
      ...copyPathAction,
      ...locationAction,
      ...deleteAction,
    ];
  }

  return [
    ...(['note', 'folder'] as const).map((kind) => ({
      id: `new-${kind}`,
      label: `New ${kind}`,
      onSelect: () => onCreate(kind, parent),
    })),
    ...(target &&
    (copyPathAction.length || locationAction.length || deleteAction.length)
      ? [{ type: 'separator' as const, id: 'entry-actions' }]
      : []),
    ...renameAction,
    ...copyPathAction,
    ...locationAction,
    ...deleteAction,
  ];
}
