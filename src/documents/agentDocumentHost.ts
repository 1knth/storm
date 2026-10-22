import type { EditorState } from '@codemirror/state';
import type {
  AgentBridgeRequest,
  AgentBridgeResult,
  AgentBridgeStatusEvent,
} from '../shared/agentBridge';
import type {
  AgentDocument,
  AgentDocumentStatus,
} from './agentDocumentController';
import { AgentDocumentController } from './agentDocumentController';
import type { AgentEditorAdapter } from '../components/Editor/agentEditorAdapter';
import type { SaveNote } from './agentDocumentController';

export type OpenAgentDocument = {
  key: string;
  vaultId: string;
  absolutePath: string;
  vaultPath: string;
  path: string;
  state: EditorState;
  revision: string;
};

export interface AgentDocumentHostOptions {
  openDocument: (target: {
    absolutePath: string;
    vaultId: string;
    vaultRoot: string;
  }) => Promise<OpenAgentDocument>;
  lookupDocument: (target: {
    vaultId: string;
    path: string;
  }) => OpenAgentDocument | undefined;
  publishDocument: (document: AgentDocument) => void;
  publishStatus: (event: AgentBridgeStatusEvent) => void;
  saveNote: SaveNote;
  getAdapterFor: (
    vaultId: string,
    path: string,
  ) => AgentEditorAdapter | undefined;
}

/** Bridges transport requests to per-document ownership; it deliberately owns no UI or transport. */
export function createAgentDocumentHost(options: AgentDocumentHostOptions) {
  const controller = new AgentDocumentController(options.saveNote);
  const sessions = new Map<string, AgentDocument>();
  const activitySequences = new Map<string, number>();
  const identities = new Map<string, { vaultId: string; path: string }>();
  const unsubscribe = controller.subscribe((document) => {
    options.publishDocument(document);
    for (const [sessionId, owned] of sessions) {
      if (owned !== document) continue;
      options.publishStatus({ session: toSessionStatus(sessionId, document) });
    }
  });

  function lookupDocument(
    vaultId: string,
    path: string,
  ): AgentDocument | undefined {
    const opened = options.lookupDocument({ vaultId, path });
    if (!opened) return undefined;
    const document = controller.attach(
      opened.key,
      opened.vaultPath,
      opened.path,
      opened.state,
      opened.revision,
    );
    document.vaultId = opened.vaultId;
    document.absolutePath = opened.absolutePath;
    return document;
  }

  async function handleRequest(
    request: AgentBridgeRequest & { vaultId?: string; vaultRoot?: string },
  ): Promise<AgentBridgeResult> {
    try {
      if (request.type === 'inspect') {
        const document = lookupDocument(request.vaultId, request.path);
        if (!document || document.closed)
          return { ok: true, inspected: true, open: false };
        return {
          ok: true,
          inspected: true,
          open: true,
          content: document.state.doc.toString(),
          documentVersion: document.acceptedVersion,
          diskRevision: document.revision,
          saveState: document.saveError
            ? 'failed'
            : document.dirty || document.inFlight
              ? 'pending'
              : 'saved',
        };
      }
      if (request.type === 'snapshot') {
        const opened = await options.openDocument({
          absolutePath: request.absolutePath,
          vaultId: request.vaultId,
          vaultRoot: request.vaultRoot,
        });
        const previous = controller.get(opened.key);
        if (previous?.status === 'finished') {
          if (!controller.resetFinished(opened.key))
            throw new Error('Finished agent session is not ready to reconnect');
          for (const [oldSessionId, owned] of sessions) {
            if (owned !== previous) continue;
            sessions.delete(oldSessionId);
            activitySequences.delete(oldSessionId);
            identities.delete(oldSessionId);
          }
        }
        const document = controller.attach(
          opened.key,
          opened.vaultPath,
          opened.path,
          opened.state,
          opened.revision,
        );
        const sessionId = request.sessionId;
        sessions.set(sessionId, document);
        activitySequences.set(sessionId, 0);
        document.vaultId = opened.vaultId;
        document.absolutePath = opened.absolutePath;
        options.publishDocument(document);
        identities.set(sessionId, {
          vaultId: opened.vaultId,
          path: opened.path,
        });
        options.publishStatus({
          session: toSessionStatus(sessionId, document),
        });
        return {
          ok: true,
          content: document.state.doc.toString(),
          documentVersion: document.acceptedVersion,
          diskRevision: document.revision,
        };
      }
      if (request.type === 'activity') {
        const document = sessions.get(request.sessionId);
        if (!document || document.closed)
          return {
            ok: false,
            code: 'SESSION_CLOSED',
            message: 'Session is not open',
          };
        const sequence = request.activitySequence;
        const currentSequence = activitySequences.get(request.sessionId) ?? 0;
        if (
          (request.documentVersion !== undefined &&
            request.documentVersion !== document.acceptedVersion) ||
          (sequence !== undefined && sequence <= currentSequence) ||
          document.status === 'finished' ||
          document.status === 'stopped' ||
          document.status === 'disconnected'
        )
          return {
            ok: true,
            documentVersion: document.acceptedVersion,
            diskRevision: document.revision,
          };
        if (sequence !== undefined)
          activitySequences.set(request.sessionId, sequence);
        controller.setActivity(document, request.activity);
        options.publishStatus({
          session: toSessionStatus(request.sessionId, document),
        });
        return {
          ok: true,
          documentVersion: document.acceptedVersion,
          diskRevision: document.revision,
        };
      }
      if (request.type === 'append') {
        const document = sessions.get(request.sessionId);
        const identity = identities.get(request.sessionId);
        if (!document || !identity || document.closed)
          return {
            ok: false,
            code: 'SESSION_CLOSED',
            message: 'Session is not open',
          };
        const result = await controller.append(document, request.text);
        return {
          ok: true,
          documentVersion: result.version,
          diskRevision: document.revision,
          saveState: document.dirty ? 'pending' : 'saved',
        };
      }
      const document = sessions.get(request.sessionId);
      const identity = identities.get(request.sessionId);
      if (!document || !identity || document.closed)
        return {
          ok: false,
          code: 'SESSION_CLOSED',
          message: 'Session is not open',
        };
      if (request.type === 'edit-preview') {
        const preview = controller.previewEdit(
          document,
          request.expectedVersion,
          request.plan,
        );
        return {
          ok: true,
          preview: true,
          ...preview,
          documentVersion: document.acceptedVersion,
          diskRevision: document.revision,
        };
      }
      if (request.type === 'edit-apply') {
        const applied = await controller.applyEdit(
          document,
          request.expectedVersion,
          request.plan,
        );
        return {
          ok: true,
          edited: true,
          content: applied.content,
          documentVersion: applied.version,
          diskRevision: document.revision,
          saveState: 'saved',
        };
      }
      if (request.type === 'finish') {
        controller.finish(document);
        const adapter = options.getAdapterFor(identity.vaultId, identity.path);
        const flushed = await controller.flush(document);
        const viewFlushed = await adapter?.flush();
        return flushed && viewFlushed !== false
          ? {
              ok: true,
              documentVersion: document.acceptedVersion,
              diskRevision: document.revision,
            }
          : {
              ok: false,
              code: 'SAVE_FAILED',
              message: 'Could not flush document changes',
            };
      }
      if (request.type === 'cancel') {
        controller.stop(document);
        const flushed = await controller.flush(document);
        return flushed
          ? {
              ok: true,
              documentVersion: document.acceptedVersion,
              diskRevision: document.revision,
            }
          : {
              ok: false,
              code: 'SAVE_FAILED',
              message: 'Could not flush document changes',
            };
      }
      return {
        ok: false,
        code: 'INVALID_REQUEST',
        message: 'Unsupported renderer request',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = /closed/i.test(message)
        ? 'SESSION_CLOSED'
        : /stale document version/i.test(message)
          ? 'STALE_VERSION'
          : /find text|replacement targets overlap/i.test(message)
            ? 'INVALID_EDIT'
            : 'SAVE_FAILED';
      return { ok: false, code, message };
    }
  }

  function onCancelled(sessionId: string, reason: string): void {
    const document = sessions.get(sessionId);
    if (document && !document.closed) {
      controller.stop(document);
      options.publishStatus({
        session: toSessionStatus(sessionId, document),
        reason,
      });
    }
  }

  return {
    controller,
    getAdapterFor: options.getAdapterFor,
    invalidateFinishedDocuments(paths: string[]): void {
      const affected = paths.map((path) => path.replace(/\\/g, '/'));
      for (const [sessionId, identity] of identities) {
        const path = identity.path.replace(/\\/g, '/');
        if (
          !affected.some(
            (candidate) =>
              path === candidate || path.startsWith(`${candidate}/`),
          )
        )
          continue;
        const document = sessions.get(sessionId);
        if (
          document?.status === 'finished' &&
          controller.resetFinished(document.key)
        ) {
          sessions.delete(sessionId);
          identities.delete(sessionId);
        }
      }
    },
    lookupDocument,
    handleRequest,
    onCancelled,
    subscribe: controller.subscribe.bind(controller),
    dispose: unsubscribe,
  };
}

function toSessionStatus(sessionId: string, document: AgentDocument) {
  const state: AgentDocumentStatus = document.status;
  return {
    sessionId,
    absolutePath: document.absolutePath,
    state:
      state === 'stopped'
        ? ('cancelled' as const)
        : state === 'disconnected'
          ? ('disconnected' as const)
          : state === 'finished'
            ? ('finished' as const)
            : state === 'writing'
              ? ('writing' as const)
              : ('connected' as const),
    documentVersion: document.acceptedVersion,
    diskRevision: document.revision,
    pendingOperations: document.appendCount,
    ...(document.activity ? { activity: document.activity } : {}),
  };
}
