import { randomUUID } from 'node:crypto';
import type { AgentNoteTarget } from '../vault/agentNoteTarget';
import { runVaultLifecycleExclusive } from './vaultLifecycle';
import {
  AGENT_TRANSPORT,
  AGENT_PROTOCOL_VERSION,
  type AgentRequest,
  type AgentResponse,
  type AgentSessionStatus,
} from '../shared/agentProtocol';

export interface AgentRendererTransport {
  dispatch(request: AgentRendererRequest): Promise<AgentRendererResult>;
  onCancelled?(
    listener: (sessionId: string, reason: string) => void,
  ): () => void;
}
export type AgentRendererRequest =
  | {
      type: 'snapshot';
      requestId: string;
      sessionId: string;
      absolutePath: string;
      vaultId: string;
      vaultRoot: string;
    }
  | {
      type: 'append';
      requestId: string;
      sessionId: string;
      absolutePath: string;
      operationId: string;
      sequence: number;
      text: string;
    }
  | { type: 'finish' | 'cancel'; requestId: string; sessionId: string };
export type AgentRendererResult =
  | {
      ok: true;
      content?: string;
      documentVersion: number;
      diskRevision: string;
      saveState?: 'pending' | 'saved' | 'failed';
    }
  | { ok: false; code: string; message: string };
export interface AgentBrokerOptions {
  resolveTarget(path: string): Promise<AgentNoteTarget>;
  assertTargetRegistered?(target: AgentNoteTarget): Promise<void>;
  withVaultLifecycle?<T>(root: string, operation: () => Promise<T>): Promise<T>;
  renderer: AgentRendererTransport;
}
type CachedOperation = {
  fingerprint: string;
  promise: Promise<Extract<AgentResponse, { type: 'accepted' }>>;
};
type Session = {
  id: string;
  target: AgentNoteTarget;
  name?: string;
  state: AgentSessionStatus['state'];
  version: number;
  sequence: number;
  pending: number;
  queue: Promise<void>;
  operations: Map<string, CachedOperation>;
  cancelWaiters: Set<() => void>;
};
const MAX_REMEMBERED_OPERATIONS = 256;

/** Per-session mutation queue preserves renderer order; operation results are retained up to a bounded count per session. */
export class AgentBroker {
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly options: AgentBrokerOptions) {
    options.renderer.onCancelled?.((id) => {
      const session = this.sessions.get(id);
      if (session && session.state !== 'finished') session.state = 'cancelled';
    });
  }
  hasWritableSessionForVault(vaultId: string): boolean {
    return [...this.sessions.values()].some(
      (session) =>
        session.target.vaultId === vaultId &&
        (session.state === 'connected' || session.state === 'writing'),
    );
  }

  async handle(value: unknown): Promise<AgentResponse> {
    if (!isRequest(value))
      return failure('', 'INVALID_REQUEST', 'Invalid request');
    const request = value;
    const fail = (
      code: string,
      message: string,
      retryable = false,
    ): AgentResponse => ({
      protocol: AGENT_PROTOCOL_VERSION,
      requestId: request.requestId,
      ok: false,
      error: { code: code as never, message, retryable },
    });
    try {
      if (request.type === 'connect') {
        const target = await this.options.resolveTarget(request.absolutePath);
        const withLifecycle =
          this.options.withVaultLifecycle ?? runVaultLifecycleExclusive;
        return await withLifecycle(target.vaultRoot, async () => {
          await this.options.assertTargetRegistered?.(target);
          const session: Session = {
            id: randomUUID(),
            target,
            ...(request.name ? { name: request.name.trim().slice(0, 64) } : {}),
            state: 'connected',
            version: 0,
            sequence: 0,
            pending: 0,
            queue: Promise.resolve(),
            operations: new Map(),
            cancelWaiters: new Set(),
          };
          const snapshot = await this.options.renderer.dispatch({
            type: 'snapshot',
            requestId: request.requestId,
            sessionId: session.id,
            absolutePath: target.absolutePath,
            vaultId: target.vaultId,
            vaultRoot: target.vaultRoot,
          });
          if (!snapshot.ok) return fail(snapshot.code, snapshot.message);
          session.version = snapshot.documentVersion;
          session.target.diskRevision = snapshot.diskRevision;
          this.sessions.set(session.id, session);
          return {
            protocol: AGENT_PROTOCOL_VERSION,
            requestId: request.requestId,
            ok: true,
            type: 'connected',
            session: this.status(session),
            content: snapshot.content ?? target.content,
          };
        });
      }
      if (request.type === 'status') {
        const sessions = request.sessionId
          ? [this.sessions.get(request.sessionId)]
              .filter((s): s is Session => !!s)
              .map((s) => this.status(s))
          : [...this.sessions.values()].map((s) => this.status(s));
        return {
          protocol: AGENT_PROTOCOL_VERSION,
          requestId: request.requestId,
          ok: true,
          type: 'status',
          sessions,
        };
      }
      const session = this.sessions.get(request.sessionId);
      if (!session) return fail('SESSION_NOT_FOUND', 'Unknown session');
      if (
        session.state === 'cancelled' ||
        session.state === 'disconnected' ||
        session.state === 'failed'
      )
        return fail('SESSION_CLOSED', `Session is ${session.state}`);
      if (session.state === 'finished' && request.type !== 'finish')
        return fail('SESSION_CLOSED', 'Session is finished');
      if (request.type === 'append') {
        const fingerprint = JSON.stringify([request.sequence, request.text]);
        const previous = session.operations.get(request.operationId);
        if (previous) {
          if (previous.fingerprint !== fingerprint)
            return fail(
              'DUPLICATE_OPERATION',
              'Operation ID was already used with different content',
            );
          try {
            return {
              ...(await previous.promise),
              requestId: request.requestId,
            };
          } catch (e) {
            return fail('INVALID_SEQUENCE', errorMessage(e));
          }
        }
        if (session.state !== 'connected' && session.state !== 'writing')
          return fail('SESSION_CLOSED', 'Session is not writable');
        if (
          new TextEncoder().encode(request.text).byteLength >
          AGENT_TRANSPORT.maxAppendBytes
        )
          return fail('OPERATION_TOO_LARGE', 'Append exceeds 256 KiB');
        if (session.pending >= AGENT_TRANSPORT.maxPendingOperationsPerSession)
          return fail('QUEUE_FULL', 'Session queue is full', true);
        session.pending++;
        session.state = 'writing';
        const promise = this.enqueue(session, async () => {
          if (session.state !== 'connected' && session.state !== 'writing')
            throw new Error('SESSION_CLOSED');
          if (request.sequence !== session.sequence + 1)
            throw new Error('sequence');
          const result = await this.options.renderer.dispatch({
            type: 'append',
            requestId: request.requestId,
            sessionId: session.id,
            absolutePath: session.target.absolutePath,
            operationId: request.operationId,
            sequence: request.sequence,
            text: request.text,
          });
          if (!result.ok) throw new Error(result.message);
          if (session.state !== 'connected' && session.state !== 'writing')
            throw new Error('SESSION_CLOSED');
          session.sequence = request.sequence;
          session.version = result.documentVersion;
          session.target.diskRevision = result.diskRevision;
          return {
            protocol: AGENT_PROTOCOL_VERSION,
            requestId: request.requestId,
            ok: true as const,
            type: 'accepted' as const,
            operationId: request.operationId,
            documentVersion: result.documentVersion,
            saveState: result.saveState ?? 'pending',
          };
        });
        let rejectCancelled = () => {};
        const cancelled = new Promise<never>((_, reject) => {
          rejectCancelled = () => reject(new Error('cancelled'));
          session.cancelWaiters.add(rejectCancelled);
        });
        const accepted = Promise.race([promise, cancelled]).finally(() => {
          session.cancelWaiters.delete(rejectCancelled);
          session.pending--;
        });
        session.operations.set(request.operationId, {
          fingerprint,
          promise: accepted,
        });
        while (session.operations.size > MAX_REMEMBERED_OPERATIONS) {
          const oldest = session.operations.keys().next().value;
          if (oldest) session.operations.delete(oldest);
        }
        try {
          return { ...(await accepted), requestId: request.requestId };
        } catch (error) {
          return fail(
            errorMessage(error) === 'sequence'
              ? 'INVALID_SEQUENCE'
              : 'SESSION_CLOSED',
            errorMessage(error),
          );
        }
      }
      if (request.type === 'disconnect') {
        this.fenceSession(session, 'disconnected');
        return {
          protocol: AGENT_PROTOCOL_VERSION,
          requestId: request.requestId,
          ok: true,
          type: 'closed',
          session: this.status(session),
        };
      }
      if (request.type === 'cancel') {
        this.fenceSession(session, 'cancelled');
        // Cancellation fences queued work immediately and does not wait for a blocked append.
        void this.options.renderer.dispatch({
          type: 'cancel',
          requestId: request.requestId,
          sessionId: session.id,
        });
      } else {
        if (session.state === 'finished') {
          return {
            protocol: AGENT_PROTOCOL_VERSION,
            requestId: request.requestId,
            ok: true,
            type: 'closed',
            session: this.status(session),
          };
        }
        const result = await this.enqueue(session, async () => {
          if (session.state !== 'connected' && session.state !== 'writing')
            throw new Error('SESSION_CLOSED');
          const rendererResult = await this.options.renderer.dispatch({
            type: 'finish',
            requestId: request.requestId,
            sessionId: session.id,
          });
          if (!rendererResult.ok) throw new Error(rendererResult.message);
          if (session.state !== 'connected' && session.state !== 'writing')
            throw new Error('SESSION_CLOSED');
          session.state = 'finished';
          session.operations.clear();
          session.version = rendererResult.documentVersion;
          session.target.diskRevision = rendererResult.diskRevision;
        }).then(
          () => null,
          (error) => error,
        );
        if (result) {
          if (errorMessage(result) === 'SESSION_CLOSED')
            return fail('SESSION_CLOSED', 'Session is not writable');
          return fail('INTERNAL', errorMessage(result));
        }
      }
      return {
        protocol: AGENT_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: true,
        type: 'closed',
        session: this.status(session),
      };
    } catch (error) {
      return fail('INTERNAL', errorMessage(error));
    }
  }
  private fenceSession(session: Session, state: 'cancelled' | 'disconnected') {
    session.state = state;
    session.operations.clear();
    for (const reject of session.cancelWaiters) reject();
  }
  private enqueue<T>(
    session: Session,
    operation: () => Promise<T>,
  ): Promise<T> {
    const result = session.queue.then(operation);
    session.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  private status(s: Session): AgentSessionStatus {
    return {
      ...(s.name ? { name: s.name } : {}),
      sessionId: s.id,
      absolutePath: s.target.absolutePath,
      state: s.state,
      documentVersion: s.version,
      diskRevision: s.target.diskRevision,
      pendingOperations: s.pending,
    };
  }
}
function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0)!;
    return code < 32 || (code >= 127 && code <= 159);
  });
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function failure(
  requestId: string,
  code: string,
  message: string,
): AgentResponse {
  return {
    protocol: AGENT_PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: { code: code as never, message, retryable: false },
  };
}
function isRequest(v: unknown): v is AgentRequest {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (
    r.protocol !== AGENT_PROTOCOL_VERSION ||
    typeof r.requestId !== 'string' ||
    r.requestId.length > 128
  )
    return false;
  if (r.type === 'connect')
    return (
      typeof r.absolutePath === 'string' &&
      (r.name === undefined ||
        (typeof r.name === 'string' &&
          r.name.length <= 64 &&
          !hasControlCharacter(r.name)))
    );
  if (r.type === 'append')
    return (
      typeof r.sessionId === 'string' &&
      typeof r.operationId === 'string' &&
      r.operationId.length <= 128 &&
      typeof r.text === 'string' &&
      Number.isSafeInteger(r.sequence)
    );
  return (
    ['finish', 'cancel', 'status', 'disconnect'].includes(String(r.type)) &&
    (r.sessionId === undefined || typeof r.sessionId === 'string')
  );
}
