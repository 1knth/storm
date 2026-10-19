// @ts-nocheck
import { describe, expect, it } from 'bun:test';
import { getExplorerContextMenuItems } from './fileExplorerContextMenu';

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
