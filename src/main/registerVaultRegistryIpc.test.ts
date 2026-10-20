import { strict as assert } from 'node:assert';
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  realpath,
  symlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { VaultWriteBarrier } from '../vault/writeBarrier';
import { registerVaultRegistryIpc } from './registerVaultRegistryIpc';
import type { VaultRegistry } from '../vault/vaultRegistry';
import type { VaultService } from '../vault/vaultService';

const event = {};

function setup() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const calls: unknown[][] = [];
  const vault = { id: 'vault-1', path: '/vault' };
  const registry = {
    list: async () => ({
      vaults: [vault],
      sidebarRootOrder: [],
      activeVaultId: 'vault-1',
    }),
    moveSidebarItem: (...args: unknown[]) => {
      calls.push(['moveSidebarItem', ...args]);
      return true;
    },
    listGroups: () => [],
    getTabLayout: (...args: unknown[]) => {
      calls.push(['getTabLayout', ...args]);
      return null;
    },
    saveTabLayout: (...args: unknown[]) => {
      calls.push(['saveTabLayout', ...args]);
      return true;
    },
    createGroup: (...args: unknown[]) => {
      calls.push(['createGroup', ...args]);
      return 'group-1';
    },
    renameGroup: (...args: unknown[]) => {
      calls.push(['renameGroup', ...args]);
      return true;
    },
    removeGroup: (...args: unknown[]) => {
      calls.push(['removeGroup', ...args]);
      return true;
    },
    setVaultGroup: (...args: unknown[]) => {
      calls.push(['setVaultGroup', ...args]);
      return true;
    },
    setGroupColor: (...args: unknown[]) => {
      calls.push(['setGroupColor', ...args]);
      return true;
    },
    setGroupCollapsed: (...args: unknown[]) => {
      calls.push(['setGroupCollapsed', ...args]);
      return true;
    },
    setVaultPlacement: (...args: unknown[]) => {
      calls.push(['setVaultPlacement', ...args]);
      return true;
    },
    reorderGroups: (...args: unknown[]) => {
      calls.push(['reorderGroups', ...args]);
      return true;
    },
    add: (...args: unknown[]) => {
      calls.push(['add', ...args]);
      return vault;
    },
    setActive: (...args: unknown[]) => {
      calls.push(['setActive', ...args]);
    },
    remove: (...args: unknown[]) => {
      calls.push(['remove', ...args]);
      return true;
    },
    unloadAll: async () => {
      calls.push(['unloadAll']);
    },
  };
  const service = {
    selectVault: async (...args: unknown[]) => {
      calls.push(['selectVault', ...args]);
    },
    getSelectedVaultPath: () => '/vault',
    clearSelectedVault: () => {
      calls.push(['clearSelectedVault']);
    },
  };
  const dependencies = {
    registry: registry as unknown as VaultRegistry,
    service: service as unknown as VaultService,
    writeBarrier: new VaultWriteBarrier(),
    watchSelectedVault: async () => {
      calls.push(['watchSelectedVault']);
      return 'vault-1';
    },
    stopWatcher: () => {
      calls.push(['stopWatcher']);
    },
    clearWatchedVaultId: () => {
      calls.push(['clearWatchedVaultId']);
    },
    hasWritableAgentSession: () => false,
    openPath: async (directory: string) => {
      calls.push(['openPath', directory]);
      return '';
    },
    showItemInFolder: (file: string) => calls.push(['showItemInFolder', file]),
  };
  registerVaultRegistryIpc(
    { handle: (name, listener) => handlers.set(name, listener) },
    dependencies,
  );
  return { handlers, calls, registry, dependencies };
}

const invoke = (
  handlers: Map<string, (...args: unknown[]) => unknown>,
  channel: string,
  ...args: unknown[]
) => handlers.get(channel)!(event, ...args);

test('opens the selected vault directory and rejects when none is selected', async () => {
  const { handlers, calls, dependencies } = setup();
  await invoke(handlers, 'vault:open-directory');
  assert.deepEqual(calls, [['openPath', '/vault']]);

  (
    dependencies.service as unknown as {
      getSelectedVaultPath: () => string | null;
    }
  ).getSelectedVaultPath = () => null;
  await assert.rejects(
    async () => invoke(handlers, 'vault:open-directory'),
    /No vault selected/,
  );

  (
    dependencies.service as unknown as {
      getSelectedVaultPath: () => string | null;
    }
  ).getSelectedVaultPath = () => '/vault';
  dependencies.openPath = async () => 'Finder failed';
  await assert.rejects(
    async () => invoke(handlers, 'vault:open-directory'),
    /Finder failed/,
  );
});

test('opens only validated vault locations with the requested Finder behavior', async () => {
  const { handlers, calls, dependencies } = setup();
  const root = await mkdtemp(path.join(os.tmpdir(), 'storm-open-location-'));
  try {
    await mkdir(path.join(root, 'folder'));
    await writeFile(path.join(root, 'note.md'), '');
    await symlink(path.join(root, 'note.md'), path.join(root, 'linked.md'));
    (
      dependencies.service as unknown as { getSelectedVaultPath: () => string }
    ).getSelectedVaultPath = () => root;
    await invoke(handlers, 'vault:open-location', 'note.md', 'note');
    await invoke(handlers, 'vault:open-location', 'folder', 'folder');
    const canonicalRoot = await realpath(root);
    assert.deepEqual(calls, [
      ['showItemInFolder', path.join(canonicalRoot, 'note.md')],
      ['openPath', path.join(canonicalRoot, 'folder')],
    ]);
    await assert.rejects(
      async () => invoke(handlers, 'vault:open-location', '../outside', 'note'),
      /Invalid vault path/,
    );
    await assert.rejects(
      async () => invoke(handlers, 'vault:open-location', 'folder', 'note'),
      /type changed/,
    );
    await assert.rejects(
      async () => invoke(handlers, 'vault:open-location', 'linked.md', 'note'),
      /Symbolic links/,
    );
    await assert.rejects(
      async () =>
        invoke(
          handlers,
          'vault:open-location',
          path.join(root, 'note.md'),
          'note',
        ),
      /Invalid vault path/,
    );
    dependencies.openPath = async () => 'Finder failed';
    await assert.rejects(
      async () => invoke(handlers, 'vault:open-location', 'folder', 'folder'),
      /Finder failed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unloads one registered vault through the write barrier without deleting files', async () => {
  const { handlers, calls } = setup();
  await invoke(handlers, 'vault:registry-unload-one', 'vault-1');
  assert.deepEqual(calls, [
    ['remove', 'vault-1'],
    ['stopWatcher'],
    ['clearWatchedVaultId'],
    ['clearSelectedVault'],
  ]);
});

test('rejects unknown vault ids before registry mutation', async () => {
  const { handlers, calls } = setup();
  await assert.rejects(
    invoke(
      handlers,
      'vault:registry-unload-one',
      '../vault',
    ) as Promise<unknown>,
  );
  assert.deepEqual(calls, []);
});

test('refuses to unload a vault with a writable agent session', async () => {
  const { handlers, calls, dependencies } = setup();
  dependencies.hasWritableAgentSession = () => true;
  await assert.rejects(
    invoke(
      handlers,
      'vault:registry-unload-one',
      'vault-1',
    ) as Promise<unknown>,
    /Stop the connected agent session/,
  );
  assert.deepEqual(calls, []);
});

test('returns registry and group lists', async () => {
  const { handlers } = setup();
  assert.deepEqual(await invoke(handlers, 'vault:registry-list'), {
    vaults: [{ id: 'vault-1', path: '/vault' }],
    sidebarRootOrder: [],
    activeVaultId: 'vault-1',
  });
  assert.deepEqual(invoke(handlers, 'vault:groups-list'), []);
});

test('forwards a registered group-member vault root drop through sidebar IPC', async () => {
  const { handlers, calls } = setup();
  const request = {
    item: { kind: 'vault' as const, id: 'group-member' },
    before: { kind: 'group' as const, id: 'visible-group' },
  };
  assert.equal(await invoke(handlers, 'vault:sidebar-move', request), true);
  assert.deepEqual(calls, [['moveSidebarItem', request]]);
});

test('preserves validation errors for invalid payloads', async () => {
  const { handlers, calls } = setup();
  const cases: [string, unknown[], string][] = [
    ['vault:sidebar-move', [null], 'Invalid sidebar move'],
    [
      'vault:sidebar-move',
      [
        {
          item: { kind: 'vault', id: 'v' },
          before: { kind: 'other', id: 'x' },
        },
      ],
      'Invalid sidebar move',
    ],
    [
      'vault:sidebar-move',
      [{ item: { kind: 'group', id: '' }, before: null }],
      'Invalid sidebar move',
    ],
    ['vault:tab-layout-get', [null], 'Invalid vault ID'],
    ['vault:tab-layout-save', [1, {}], 'Invalid vault ID'],
    ['vault:group-create', [false], 'Invalid group name'],
    ['vault:group-rename', ['id', null], 'Invalid group rename'],
    ['vault:group-remove', [null], 'Invalid vault group ID'],
    ['vault:group-set-vault', ['vault', 1], 'Invalid vault group assignment'],
    ['vault:group-set-color', [null, 'red'], 'Invalid vault group ID'],
    [
      'vault:group-set-collapsed',
      ['id', 'yes'],
      'Invalid group collapse state',
    ],
    ['vault:registry-add', [null], 'Invalid vault directory'],
    ['vault:registry-activate', [null], 'Invalid vault ID'],
    ['vault:registry-remove', [null], 'Invalid vault ID'],
    ['vault:placement-set', [null], 'Invalid vault placement'],
    [
      'vault:placement-set',
      [{ vaultId: null, groupId: null, pinned: true, beforeVaultId: null }],
      'Invalid vault placement',
    ],
    [
      'vault:placement-set',
      [
        {
          vaultId: 'vault-1',
          groupId: null,
          pinned: 'yes',
          beforeVaultId: null,
        },
      ],
      'Invalid vault placement',
    ],
    [
      'vault:placement-set',
      [{ vaultId: 'vault-1', groupId: 1, pinned: true, beforeVaultId: null }],
      'Invalid vault placement',
    ],
    [
      'vault:placement-set',
      [{ vaultId: 'vault-1', groupId: null, pinned: true, beforeVaultId: 1 }],
      'Invalid vault placement',
    ],
    ['vault:groups-reorder', [null], 'Invalid group order'],
    ['vault:groups-reorder', [['g', null]], 'Invalid group order'],
  ];
  for (const [channel, args, message] of cases) {
    await assert.rejects(
      Promise.resolve().then(() =>
        invoke(handlers, channel, ...args),
      ) as Promise<unknown>,
      new RegExp(message),
    );
  }
  assert.deepEqual(calls, []);
});

test('activates a listed vault in order and returns selected path', async () => {
  const { handlers, calls } = setup();
  assert.deepEqual(
    await invoke(handlers, 'vault:registry-activate', 'vault-1'),
    { id: 'vault-1', path: '/vault' },
  );
  assert.deepEqual(calls, [
    ['selectVault', '/vault'],
    ['setActive', 'vault-1'],
    ['watchSelectedVault'],
  ]);
});

test('rejects unknown vaults without selecting or watching', async () => {
  const { handlers, calls } = setup();
  await assert.rejects(
    invoke(handlers, 'vault:registry-activate', 'missing') as Promise<unknown>,
    /Unknown vault/,
  );
  assert.deepEqual(calls, []);
});

test('does not persist active state or watch if selecting fails', async () => {
  // A failing service is injected by replacing the captured handler's dependency in a separate registration.
  const failures = new Map<string, (...args: unknown[]) => unknown>();
  const registry = {
    list: async () => ({ vaults: [{ id: 'vault-1', path: '/vault' }] }),
  };
  const service = {
    selectVault: async () => {
      throw new Error('selection failed');
    },
    getSelectedVaultPath: () => '/vault',
  };
  registerVaultRegistryIpc(
    { handle: (name, listener) => failures.set(name, listener) },
    {
      registry: registry as unknown as VaultRegistry,
      service: service as unknown as VaultService,
      writeBarrier: new VaultWriteBarrier(),
      watchSelectedVault: async () => {
        throw new Error('should not watch');
      },
      stopWatcher: () => {},
      clearWatchedVaultId: () => {},
      openPath: async () => '',
      showItemInFolder: () => {},
    },
  );
  await assert.rejects(
    failures.get('vault:registry-activate')!(
      event,
      'vault-1',
    ) as Promise<unknown>,
    /selection failed/,
  );
});

test('waits for pending writes before unloading and clearing selection', async () => {
  const { handlers, calls, dependencies } = setup();
  const barrier = dependencies.writeBarrier;
  let finishWrite!: () => void;
  const writeFinished = new Promise<void>((resolve) => {
    finishWrite = resolve;
  });
  const writeStarted = barrier.run(async () => {
    await writeFinished;
  });
  const unload = invoke(handlers, 'vault:registry-unload-all');
  assert.deepEqual(calls, []);
  finishWrite();
  await writeStarted;
  await unload;
  assert.deepEqual(calls, [
    ['unloadAll'],
    ['stopWatcher'],
    ['clearWatchedVaultId'],
    ['clearSelectedVault'],
  ]);
});
