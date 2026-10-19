/** Local StormCLI ↔ Storm-main-process protocol. No renderer or disk paths cross this
 * boundary; the main process resolves and validates vault membership before use.
 */
export const AGENT_PROTOCOL_VERSION = 1 as const;

export type AgentSessionId = string;
export type AgentOperationId = string;

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
      type: 'append';
      sessionId: AgentSessionId;
      operationId: AgentOperationId;
      sequence: number;
      text: string;
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
}

export type AgentResponse =
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
      type: 'accepted';
      operationId: AgentOperationId;
      documentVersion: number;
      saveState: 'pending' | 'saved' | 'failed';
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
