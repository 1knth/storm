import type { EditorState } from '@codemirror/state';
import type { AgentContext } from '../shared/agentProtocol';
import type {
  AgentBridgeRequest,
  AgentBridgeResult,
  AgentBridgeStatusEvent,
} from '../shared/agentBridge';
import type {
  AgentDocument,
  AgentDocumentStatus,
} from './agentDocumentController';
import {
  AgentDocumentError,
  AgentDocumentController,
} from './agentDocumentController';
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
  getContext?: () => AgentContext | undefined;
}

/** Bridges transport requests to per-document ownership; it deliberately owns no UI or transport. */
export function createAgentDocumentHost(options: AgentDocumentHostOptions) {
  const controller = new AgentDocumentController(options.saveNote);
  const sessions = new Map<
    string,
    { document: AgentDocument; activitySequence: number }
  >();
  const documentSessions = new Map<AgentDocument, Set<string>>();
  function removeSession(id: string) {
    const record = sessions.get(id);
    if (!record) return;
    sessions.delete(id);
    const ids = documentSessions.get(record.document);
    ids?.delete(id);
    if (!ids?.size) documentSessions.delete(record.document);
  }
  const unsubscribe = controller.subscribe((document) => {
    options.publishDocument(document);
    for (const sessionId of documentSessions.get(document) ?? []) {
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
      if (request.type === 'context') {
        const context = options.getContext?.();
        return context
          ? { ok: true, context }
          : {
              ok: false,
              code: 'CONTEXT_UNAVAILABLE',
              message: 'App context is unavailable',
            };
      }
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
          for (const id of documentSessions.get(previous) ?? [])
            removeSession(id);
        }
        const document = controller.attach(
          opened.key,
          opened.vaultPath,
          opened.path,
          opened.state,
          opened.revision,
        );
        const sessionId = request.sessionId;
        removeSession(sessionId);
        sessions.set(sessionId, { document, activitySequence: 0 });
        const ids = documentSessions.get(document) ?? new Set<string>();
        ids.add(sessionId);
        documentSessions.set(document, ids);
        document.vaultId = opened.vaultId;
        document.absolutePath = opened.absolutePath;
        options.publishDocument(document);
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
        const document = sessions.get(request.sessionId)?.document;
        if (!document || document.closed)
          return {
            ok: false,
            code: 'SESSION_CLOSED',
            message: 'Session is not open',
          };
        const sequence = request.activitySequence;
        const currentSequence = sessions.get(
          request.sessionId,
        )!.activitySequence;
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
          sessions.get(request.sessionId)!.activitySequence = sequence;
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
        const document = sessions.get(request.sessionId)?.document;
        if (!document || document.closed)
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
      const document = sessions.get(request.sessionId)?.document;
      if (!document || document.closed)
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
        const fingerprints = await controller.fingerprints(
          preview,
          document.state.doc.toString(),
        );
        return {
          ok: true,
          preview: true,
          ...preview,
          ...fingerprints,
          documentVersion: document.acceptedVersion,
          diskRevision: document.revision,
        };
      }
      if (request.type === 'edit-apply') {
        const applied = await controller.applyEdit(
          document,
          request.expectedVersion,
          request.plan,
          request.expectedFingerprints,
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
        const adapter = options.getAdapterFor(document.vaultId!, document.path);
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
      const code =
        error instanceof AgentDocumentError ? error.code : 'SAVE_FAILED';
      return { ok: false, code, message };
    }
  }

  return {
    controller,
    getAdapterFor: options.getAdapterFor,
    invalidateFinishedDocuments(paths: string[]): void {
      const affected = paths.map((path) => path.replace(/\\/g, '/'));
      for (const [sessionId, { document }] of sessions) {
        const path = document.path.replace(/\\/g, '/');
        if (
          !affected.some(
            (candidate) =>
              path === candidate || path.startsWith(`${candidate}/`),
          )
        )
          continue;
        if (
          document?.status === 'finished' &&
          controller.resetFinished(document.key)
        ) {
          removeSession(sessionId);
        }
      }
    },
    lookupDocument,
    handleRequest,
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
