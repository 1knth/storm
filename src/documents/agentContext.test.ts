import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentContext } from './agentContext';
import type { TabSnapshot } from '../components/Editor/Editor';

const vault = { id: 'v1', name: 'Notes', path: '/vault with spaces' };
const note = (path: string, vaultId = 'v1') =>
  ({
    kind: 'note',
    note: { path, content: '', revision: 'r1' },
    vaultId,
    vaultPath: '/vault with spaces',
    state: {} as never,
    scrollTop: 0,
  }) as Extract<TabSnapshot, { kind: 'note' }>;

describe('createAgentContext', () => {
  it('reports registered roots and actual open note tabs without mistaking a non-note active tab for a note', () => {
    const tabs: TabSnapshot[] = [
      note('one.md'),
      { kind: 'empty', id: 'new-tab' },
      {
        kind: 'image',
        vaultId: 'v1',
        path: 'image.png',
        filename: 'image.png',
      },
      note('two.md'),
      note('outside.md', 'unregistered'),
    ];
    assert.deepEqual(createAgentContext([vault], 'v1', tabs, 'new-tab'), {
      registeredVaults: [vault],
      activeVaultId: 'v1',
      activeNote: null,
      openNotes: [
        {
          vaultId: 'v1',
          path: '/vault with spaces/one.md',
          relativePath: 'one.md',
        },
        {
          vaultId: 'v1',
          path: '/vault with spaces/two.md',
          relativePath: 'two.md',
        },
      ],
    });
    const active = createAgentContext([vault], 'v1', tabs, 'two.md');
    assert.equal(active.activeNote?.relativePath, 'two.md');
  });

  it('keeps context empty and truthful when no vault is registered', () => {
    assert.deepEqual(createAgentContext([], null, [], null), {
      registeredVaults: [],
      activeVaultId: null,
      activeNote: null,
      openNotes: [],
    });
  });
});
