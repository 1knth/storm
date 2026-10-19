import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isAgentTabProtected } from './agentTabProtection';
import type { TabSnapshot } from '../components/Editor/Editor';
import type { AgentSessionStatus } from '../shared/agentProtocol';

const tab = (vaultPath: string): TabSnapshot =>
  ({
    kind: 'note',
    note: { path: 'notes/a.md' },
    vaultPath,
    vaultId: vaultPath,
  }) as TabSnapshot;

const makeStatus = (
  absolutePath: string,
  state: AgentSessionStatus['state'],
): AgentSessionStatus => ({
  sessionId: 'session',
  absolutePath,
  state,
  documentVersion: 0,
  diskRevision: '',
  pendingOperations: 0,
});

describe('agent tab close protection', () => {
  it('protects connected/writing sessions regardless of pending-operation count', () => {
    for (const state of ['connected', 'writing'] as const) {
      assert.equal(
        isAgentTabProtected(tab('/vault'), {
          session: makeStatus('/vault/notes/a.md', state),
        }),
        true,
      );
    }
  });

  it('releases protection for terminal states and other vaults', () => {
    for (const state of [
      'finished',
      'cancelled',
      'disconnected',
      'failed',
    ] as const) {
      assert.equal(
        isAgentTabProtected(tab('/vault'), {
          session: makeStatus('/vault/notes/a.md', state),
        }),
        false,
      );
    }
    assert.equal(
      isAgentTabProtected(tab('/vault'), {
        session: makeStatus('/another-vault/notes/a.md', 'writing'),
      }),
      false,
    );
    assert.equal(
      isAgentTabProtected(tab('/vault'), {
        session: makeStatus('/vault/notes/other.md', 'connected'),
      }),
      false,
    );
    assert.equal(
      isAgentTabProtected({ kind: 'empty', id: 'empty' }, {}),
      false,
    );
  });
});
