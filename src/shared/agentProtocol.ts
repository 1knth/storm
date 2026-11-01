/** Local StormCLI ↔ Storm-main-process protocol. No renderer or disk paths cross this
 * boundary; the main process resolves and validates vault membership before use.
 */
import type {
  QuizAgentRequest,
  QuizResult,
  QuizSession,
  QuizSnapshot,
} from './quizProtocol';
import type { StudyRequest, StudyValue } from './studyContext';
export const AGENT_PROTOCOL_VERSION = 1 as const;

export type AgentSessionId = string;
export type AgentOperationId = string;

export interface AgentContextNote {
  vaultId: string;
  /** Absolute filesystem path. */
  path: string;
  relativePath: string;
}

export interface AgentContext {
  /** Registered vault IDs and root paths are intentional context output. */
  registeredVaults: Array<{ id: string; name: string; path: string }>;
  activeVaultId: string | null;
  activeNote: AgentContextNote | null;
  openNotes: AgentContextNote[];
}

export function isAgentContext(value: unknown): value is AgentContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const context = value as Record<string, unknown>;
  const isNote = (note: unknown): note is AgentContextNote => {
    if (!note || typeof note !== 'object' || Array.isArray(note)) return false;
    const item = note as Record<string, unknown>;
    return (
      typeof item.vaultId === 'string' &&
      typeof item.path === 'string' &&
      typeof item.relativePath === 'string'
    );
  };
  return (
    Array.isArray(context.registeredVaults) &&
    context.registeredVaults.every(
      (vault) =>
        !!vault &&
        typeof vault === 'object' &&
        typeof (vault as Record<string, unknown>).id === 'string' &&
        typeof (vault as Record<string, unknown>).name === 'string' &&
        typeof (vault as Record<string, unknown>).path === 'string',
    ) &&
    (context.activeVaultId === null ||
      typeof context.activeVaultId === 'string') &&
    (context.activeNote === null || isNote(context.activeNote)) &&
    Array.isArray(context.openNotes) &&
    context.openNotes.every(isNote)
  );
}

export type AgentActivity = 'thinking' | 'drafting';
export type AgentEditPlan =
  | { type: 'replace'; content: string }
  | {
      type: 'replaceText';
      replacements: Array<{ find: string; replace: string }>;
    };
export type AgentPatchPreviewEdit = {
  start: number;
  end: number;
  line: number;
  column: number;
  heading?: string;
  contextBefore: string;
  contextAfter: string;
  find: string;
  replace: string;
};
export type AgentEditFingerprints = {
  baseFingerprint: string;
  resultFingerprint: string;
};

export type AgentRequest =
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      type: 'study';
      study: StudyRequest;
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      type: 'connect';
      absolutePath: string;
      name?: string;
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      type: 'inspect';
      absolutePath: string;
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      type: 'activity';
      sessionId: AgentSessionId;
      activity: AgentActivity | null;
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      type: 'append';
      sessionId: AgentSessionId;
      operationId: AgentOperationId;
      sequence: number;
      text: string;
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      type: 'edit-preview' | 'edit-apply';
      sessionId: AgentSessionId;
      operationId: AgentOperationId;
      expectedVersion: number;
      plan: AgentEditPlan;
      previewReceipt?: string;
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      type: 'finish';
      sessionId: AgentSessionId;
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      type: 'cancel';
      sessionId: AgentSessionId;
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      type: 'status';
      sessionId?: AgentSessionId;
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      type: 'context';
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      type: 'discover';
      vaultId: string;
      query?: string;
      limit?: number;
      sourcePath?: string;
      depth?: number;
      includeSource?: boolean;
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      type: 'resolve-link';
      vaultId: string;
      sourcePath: string;
      target: string;
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      type: 'disconnect';
      sessionId: AgentSessionId;
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      type: 'quiz';
      operation: 'list';
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      type: 'quiz';
      operation: 'attach';
      sessionId: string;
      clientId: string;
      compact?: boolean;
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      type: 'quiz';
      operation: 'detach';
      sessionId: string;
      agentToken: string;
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      type: 'quiz';
      operation: 'activity';
      sessionId: string;
      agentToken: string;
      state: 'idle' | 'thinking' | 'drafting';
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      type: 'quiz';
      operation: 'image-fetch';
      sessionId: string;
      agentToken: string;
      imageId: string;
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      type: 'quiz';
      operation: 'image-release';
      sessionId: string;
      agentToken: string;
      imageId: string;
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      type: 'quiz';
      operation: 'snapshot';
      sessionId: string;
      agentToken: string;
      after?: number;
      compact?: boolean;
      recover?: boolean;
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      type: 'quiz';
      operation: 'context';
      sessionId: string;
      agentToken: string;
      section: 'history' | 'question' | 'prompt' | 'scope' | 'event';
      before?: number;
      offset?: number;
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      type: 'quiz';
      operation: 'request';
      request: QuizAgentRequest;
    };

export type AgentQuizSession = Omit<QuizSession, 'agentToken'>;
export type AgentQuizSnapshot = Omit<QuizSnapshot, 'session'> & {
  session: AgentQuizSession;
  recovery?: Record<string, any>;
  after?: number;
  hasMore?: boolean;
};
export type AgentQuizAttachResult = {
  agentToken: string;
  snapshot: AgentQuizSnapshot;
};

export type AgentSessionState =
  | 'connected'
  | 'writing'
  | 'finished'
  | 'cancelled'
  | 'disconnected'
  | 'failed';

export interface AgentSessionStatus {
  /** Optional self-reported CLI identity; never inferred from the provider. */
  name?: string;
  sessionId: AgentSessionId;
  absolutePath: string;
  state: AgentSessionState;
  documentVersion: number;
  diskRevision: string;
  pendingOperations: number;
  /** Agent-reported work phase; absent means idle/unspecified. */
  activity?: AgentActivity;
  /** A write may have reached the document without confirmation; version/revision are last observed, not proof of the operation's outcome. */
  outcomeUncertain?: boolean;
}

export type AgentResponse =
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      ok: true;
      type: 'study';
      result: { ok: true; value: StudyValue };
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      ok: true;
      type: 'inspected';
      open: false;
      source: 'disk';
      content: string;
      diskRevision: string;
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      ok: true;
      type: 'inspected';
      open: true;
      source: 'live';
      content: string;
      documentVersion: number;
      diskRevision: string;
      saveState: 'pending' | 'saved' | 'failed';
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      ok: true;
      type: 'connected';
      session: AgentSessionStatus;
      content: string;
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      ok: true;
      type: 'activity';
      session: AgentSessionStatus;
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      ok: true;
      type: 'accepted';
      operationId: AgentOperationId;
      documentVersion: number;
      saveState: 'pending' | 'saved' | 'failed';
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      ok: true;
      type: 'preview';
      operationId: AgentOperationId;
      previewReceipt?: string;
      expiresAt?: number;
      baseFingerprint?: string;
      resultFingerprint?: string;
      edits?: AgentPatchPreviewEdit[];
      content: string;
      changed: boolean;
      documentVersion: number;
      diskRevision: string;
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      ok: true;
      type: 'edited';
      operationId: AgentOperationId;
      content: string;
      documentVersion: number;
      diskRevision: string;
      saveState: 'saved';
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      ok: true;
      type: 'status';
      sessions: AgentSessionStatus[];
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      ok: true;
      type: 'context';
      context: AgentContext;
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      ok: true;
      type: 'discovery';
      vaultId: string;
      results: Array<{ path: string; name: string; excerpt?: string }>;
      unresolved: Array<{
        sourcePath: string;
        target: string;
        reason: 'missing' | 'ambiguous' | 'invalid';
      }>;
      truncated?: boolean;
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      ok: true;
      type: 'link-resolution';
      vaultId: string;
      sourcePath: string;
      target: string;
      path?: string;
      reason?: 'missing' | 'ambiguous' | 'invalid';
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      ok: true;
      type: 'closed';
      session: AgentSessionStatus;
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      ok: true;
      type: 'quiz';
      operation: 'list';
      result: QuizResult<AgentQuizSession[]>;
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      ok: true;
      type: 'quiz';
      operation: 'attach';
      result: QuizResult<AgentQuizAttachResult>;
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      ok: true;
      type: 'quiz';
      operation: 'detach';
      result: QuizResult<AgentQuizSession>;
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      ok: true;
      type: 'quiz';
      operation: 'activity';
      result: QuizResult<AgentQuizSession>;
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      ok: true;
      type: 'quiz';
      operation: 'image-fetch';
      result: QuizResult<{
        id: string;
        mimeType: string;
        size: number;
        path: string;
      }>;
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      ok: true;
      type: 'quiz';
      operation: 'image-release';
      result: QuizResult<{ id: string; released: true }>;
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      ok: true;
      type: 'quiz';
      operation: 'snapshot';
      snapshot: AgentQuizSnapshot | null;
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      ok: true;
      type: 'quiz';
      operation: 'context';
      result: QuizResult<Record<string, any>>;
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      ok: true;
      type: 'quiz';
      operation: 'request';
      result: QuizResult<AgentQuizSession>;
    }
  | {
      protocol: typeof AGENT_PROTOCOL_VERSION;
      requestId: string;
      ok: false;
      error: AgentProtocolError;
    };

export type AgentProtocolErrorCode =
  | 'UNSUPPORTED_PROTOCOL'
  | 'INVALID_REQUEST'
  | 'CONTEXT_UNAVAILABLE'
  | 'INVALID_PATH'
  | 'PATH_OUTSIDE_VAULT'
  | 'NOTE_NOT_OPEN'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_CLOSED'
  | 'DUPLICATE_OPERATION'
  | 'INVALID_SEQUENCE'
  | 'QUEUE_FULL'
  | 'OPERATION_TOO_LARGE'
  | 'DISK_CONFLICT'
  | 'STALE_VERSION'
  | 'INVALID_EDIT'
  | 'PREVIEW_REQUIRED'
  | 'PREVIEW_EXPIRED'
  | 'PREVIEW_REJECTED'
  | 'SAVE_FAILED'
  | 'INTERNAL';

export interface AgentProtocolError {
  code: AgentProtocolErrorCode;
  message: string;
  retryable: boolean;
}

/** Transport contract: one bounded newline-delimited JSON request/response per line,
 * private per-user local endpoint, authenticated to the local Storm instance. */
export const AGENT_TRANSPORT = {
  framing: 'newline-delimited-json',
  maxFrameBytes: 1_048_576,
  maxAppendBytes: 262_144,
  maxPendingOperationsPerSession: 64,
} as const;
