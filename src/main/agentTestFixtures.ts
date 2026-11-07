import {
  AgentBroker,
  type AgentBrokerOptions,
  type AgentRendererRequest,
} from './agentBroker';
import type { AgentBridgeResult } from '../shared/agentBridge';

export function documentResult(
  documentVersion = 0,
  diskRevision = 'rev',
): Extract<AgentBridgeResult, { kind: 'document' }> {
  return { ok: true, kind: 'document', documentVersion, diskRevision };
}

export function createAgentBrokerFixture(
  overrides: Partial<AgentBrokerOptions> = {},
) {
  const calls: AgentRendererRequest[] = [];
  const broker = new AgentBroker({
    resolveExistingTarget: async (absolutePath) => ({
      absolutePath,
      vaultId: 'fixture',
      vaultRoot: '/private/fixture',
      relativePath: 'note.md',
      content: 'disk text',
      diskRevision: 'rev',
    }),
    resolveTarget: async (absolutePath) => ({
      absolutePath,
      vaultId: 'fixture',
      vaultRoot: '/private/fixture',
      relativePath: 'note.md',
      content: '',
      diskRevision: 'rev',
    }),
    renderer: {
      dispatch: async (request) => {
        calls.push(request);
        if (request.type === 'inspect')
          return {
            ok: true,
            kind: 'inspect',
            open: true,
            content: 'live text',
            documentVersion: 1,
            diskRevision: 'rev',
            saveState: 'saved',
          };
        if (request.type === 'snapshot')
          return {
            kind: 'document',
            ok: true,
            content: '',
            documentVersion: calls.length,
            diskRevision: 'rev',
            saveState: 'saved',
          };
        if (request.type === 'activity')
          return {
            kind: 'document',
            ok: true,
            documentVersion: calls.length,
            diskRevision: 'rev',
          };
        if (request.type === 'append')
          return {
            kind: 'document',
            ok: true,
            documentVersion: calls.length,
            diskRevision: 'rev',
          };
        if (request.type === 'finish' || request.type === 'cancel')
          return {
            kind: 'document',
            ok: true,
            documentVersion: calls.length,
            diskRevision: 'rev',
          };
        return { ok: true, kind: 'inspect', open: false };
      },
    },
    ...overrides,
  });
  return { broker, calls };
}
