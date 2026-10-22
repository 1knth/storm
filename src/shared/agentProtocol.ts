/** Local StormCLI ↔ Storm-main-process protocol. No renderer or disk paths cross this
 * boundary; the main process resolves and validates vault membership before use.
 */
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

export type AgentRequest =
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
      type: 'disconnect';
      sessionId: AgentSessionId;
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
      type: 'closed';
      session: AgentSessionStatus;
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
