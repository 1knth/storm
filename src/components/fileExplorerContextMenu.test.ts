// @ts-nocheck
import { describe, expect, it } from 'bun:test';
import {
  absoluteExplorerPath,
  getExplorerContextMenuItems,
} from './fileExplorerContextMenu';

const create = () => {};
const remove = () => {};

function ids(items: ReturnType<typeof getExplorerContextMenuItems>) {
  return items
    .filter((item) => item.type !== 'separator')
    .map((item) => item.id);
}

describe('file explorer context menu', () => {
  it.each(['note', 'image'] as const)(
    'shows only the delete action for a %s, including nested clicked content',
    (kind) => {
      const items = getExplorerContextMenuItems(
        { path: `folder/file.${kind}`, kind },
        'folder',
        create,
        remove,
      );
      expect(ids(items)).toEqual(['delete-entry']);
      expect(items[0]?.type === 'separator' ? '' : items[0]?.label).toContain(
        'Trash',
      );
    },
  );

  it('preserves folder and blank-area creation actions', () => {
    expect(
      ids(
        getExplorerContextMenuItems(
          { path: 'folder', kind: 'folder' },
          'folder',
          create,
          remove,
        ),
      ),
    ).toEqual(['new-note', 'new-folder', 'delete-entry']);
    expect(ids(getExplorerContextMenuItems(null, '', create, remove))).toEqual([
      'new-note',
      'new-folder',
    ]);
  });

  it.each([
    [{ path: 'note.md', kind: 'note' }, 'note'],
    [{ path: 'folder', kind: 'folder' }, 'folder'],
  ] as const)('routes Open Location for %s', (target, expectedKind) => {
    const opened: unknown[][] = [];
    const items = getExplorerContextMenuItems(
      target,
      '',
      create,
      remove,
      (path, kind) => opened.push([path, kind]),
    );
    const action = items.find((item) => item.id === 'open-location');
    expect(action?.label).toBe('Open Location');
    if (action?.type !== 'separator') action?.onSelect?.();
    expect(opened).toEqual([[target.path, expectedKind]]);
  });

  it.each(['note', 'folder'] as const)(
    'routes Rename for a %s to its actual target kind',
    (kind) => {
      const renamed: unknown[][] = [];
      const target = {
        path: kind === 'folder' ? 'folder' : 'note.md',
        kind,
      } as const;
      const items = getExplorerContextMenuItems(
        target,
        '',
        create,
        remove,
        undefined,
        (path, targetKind) => renamed.push([path, targetKind]),
      );
      const action = items.find((item) => item.id === 'rename-entry');
      expect(action?.label).toBe('Rename…');
      if (action?.type !== 'separator') action?.onSelect?.();
      expect(renamed).toEqual([[target.path, kind]]);
    },
  );

  it.each([
    [{ path: 'nested/note.md', kind: 'note' }, '/vault/nested/note.md'],
    [{ path: 'nested/image.png', kind: 'image' }, '/vault/nested/image.png'],
    [{ path: 'nested/folder', kind: 'folder' }, '/vault/nested/folder'],
  ] as const)(
    'copies the full absolute path for %s',
    (target, absolutePath) => {
      const copied: string[] = [];
      const items = getExplorerContextMenuItems(
        target,
        '',
        create,
        remove,
        undefined,
        undefined,
        (path) => copied.push(absoluteExplorerPath('/vault', path)),
      );
      const action = items.find((item) => item.id === 'copy-path');
      expect(action?.label).toBe('Copy Path');
      if (action?.type !== 'separator') action?.onSelect?.();
      expect(copied).toEqual([absolutePath]);
    },
  );

  it('normalizes relative separators using the vault path platform style', () => {
    expect(absoluteExplorerPath('C:\\vault\\', 'nested/file.md')).toBe(
      'C:\\vault\\nested\\file.md',
    );
  });

  it('does not expose deletion when no delete handler is provided', () => {
    expect(
      ids(
        getExplorerContextMenuItems(
          { path: 'file.md', kind: 'note' },
          '',
          create,
        ),
      ),
    ).toEqual([]);
  });
});
