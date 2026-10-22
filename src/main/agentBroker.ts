import { randomUUID } from 'node:crypto';
import { isAgentEditPlan } from '../shared/agentEditValidation';
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
      type: 'activity';
      requestId: string;
      sessionId: string;
      activity: 'thinking' | 'drafting' | null;
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
  | { type: 'inspect'; requestId: string; vaultId: string; path: string }
  | {
      type: 'edit-preview' | 'edit-apply';
      requestId: string;
      sessionId: string;
      expectedVersion: number;
      plan: import('../shared/agentProtocol').AgentEditPlan;
    }
  | { type: 'finish' | 'cancel'; requestId: string; sessionId: string };
export type AgentRendererResult =
  | { ok: true; inspected: true; open: false }
  | {
      ok: true;
      inspected: true;
      open: true;
      content: string;
      documentVersion: number;
      diskRevision: string;
      saveState: 'pending' | 'saved' | 'failed';
    }
  | {
      ok: true;
      content?: string;
      documentVersion: number;
      diskRevision: string;
      saveState?: 'pending' | 'saved' | 'failed';
    }
  | {
      ok: true;
      preview: true;
      content: string;
      changed: boolean;
      documentVersion: number;
      diskRevision: string;
      saveState?: 'saved';
    }
  | {
      ok: true;
      edited: true;
      content: string;
      documentVersion: number;
      diskRevision: string;
      saveState: 'saved';
    }
  | { ok: false; code: string; message: string };
export interface AgentBrokerOptions {
  resolveTarget(path: string): Promise<AgentNoteTarget>;
  resolveExistingTarget?(path: string): Promise<AgentNoteTarget>;
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
  activity?: 'thinking' | 'drafting';
  version: number;
  sequence: number;
  pending: number;
  queue: Promise<void>;
  operations: Map<string, CachedOperation>;
  cancelWaiters: Set<() => void>;
  outcomeUncertain: boolean;
};
const MAX_REMEMBERED_OPERATIONS = 256;

/** Per-session mutation queue preserves renderer order; operation results are retained up to a bounded count per session. */
export class AgentBroker {
  private readonly sessions = new Map<string, Session>();
  private readonly maintenanceVaults = new Set<string>();
  private resolvingConnects = 0;
  private readonly editOperations = new Map<
    string,
    { fingerprint: string; result: Promise<AgentResponse> }
  >();
  constructor(private readonly options: AgentBrokerOptions) {
    options.renderer.onCancelled?.((id) => {
      const session = this.sessions.get(id);
      if (session && session.state !== 'finished') {
        session.state = 'cancelled';
        session.activity = undefined;
      }
    });
  }
  acquireMaintenanceLease(vaultId: string): (() => void) | null {
    if (
      this.maintenanceVaults.has(vaultId) ||
      this.resolvingConnects > 0 ||
      this.hasWritableSessionForVault(vaultId)
    )
      return null;
    this.maintenanceVaults.add(vaultId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.maintenanceVaults.delete(vaultId);
    };
  }

  isMaintenanceLeased(vaultId: string): boolean {
    return this.maintenanceVaults.has(vaultId);
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
      if (request.type === 'inspect') {
        const resolveExisting = this.options.resolveExistingTarget;
        if (!resolveExisting)
          return fail('INTERNAL', 'Inspection is unavailable');
        const target = await resolveExisting(request.absolutePath);
        const rendered = await this.options.renderer.dispatch({
          type: 'inspect',
          requestId: request.requestId,
          vaultId: target.vaultId,
          path: target.relativePath,
        });
        if (!rendered.ok) return fail(rendered.code, rendered.message);
        if (!('inspected' in rendered))
          return fail(
            'INTERNAL',
            'Renderer returned a mutation response for inspection',
          );
        if (rendered.open)
          return {
            protocol: AGENT_PROTOCOL_VERSION,
            requestId: request.requestId,
            ok: true,
            type: 'inspected',
            open: true,
            source: 'live',
            content: rendered.content,
            documentVersion: rendered.documentVersion,
            diskRevision: rendered.diskRevision,
            saveState: rendered.saveState,
          };
        return {
          protocol: AGENT_PROTOCOL_VERSION,
          requestId: request.requestId,
          ok: true,
          type: 'inspected',
          open: false,
          source: 'disk',
          content: target.content,
          diskRevision: target.diskRevision,
        };
      }
      if (request.type === 'connect') {
        this.resolvingConnects++;
        try {
          const target = await this.options.resolveTarget(request.absolutePath);
          const withLifecycle =
            this.options.withVaultLifecycle ?? runVaultLifecycleExclusive;
          if (this.maintenanceVaults.has(target.vaultId))
            return fail(
              'VAULT_MAINTENANCE',
              'Vault rename is in progress; retry shortly',
              true,
            );
          return await withLifecycle(target.vaultRoot, async () => {
            if (this.maintenanceVaults.has(target.vaultId))
              return fail(
                'VAULT_MAINTENANCE',
                'Vault rename is in progress; retry shortly',
                true,
              );
            await this.options.assertTargetRegistered?.(target);
            const session: Session = {
              id: randomUUID(),
              target,
              ...(request.name
                ? { name: request.name.trim().slice(0, 64) }
                : {}),
              state: 'connected',
              version: 0,
              sequence: 0,
              pending: 0,
              queue: Promise.resolve(),
              operations: new Map(),
              cancelWaiters: new Set(),
              outcomeUncertain: false,
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
            if ('inspected' in snapshot)
              return fail(
                'INTERNAL',
                'Renderer returned an inspection response for snapshot',
              );
            if (this.maintenanceVaults.has(target.vaultId))
              return fail(
                'VAULT_MAINTENANCE',
                'Vault rename is in progress; retry shortly',
                true,
              );
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
        } finally {
          this.resolvingConnects--;
        }
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
      if (request.type === 'edit-apply') {
        const key = `${session.id}:${request.operationId}`;
        const fingerprint = JSON.stringify([
          request.expectedVersion,
          request.plan,
        ]);
        const previous = this.editOperations.get(key);
        if (previous) {
          if (previous.fingerprint !== fingerprint)
            return fail(
              'DUPLICATE_OPERATION',
              'Operation ID was already used with different content',
            );
          return { ...(await previous.result), requestId: request.requestId };
        }
      }
      if (
        session.state === 'cancelled' ||
        session.state === 'disconnected' ||
        session.state === 'failed'
      )
        return fail('SESSION_CLOSED', `Session is ${session.state}`);
      if (session.state === 'finished' && request.type !== 'finish')
        return fail('SESSION_CLOSED', 'Session is finished');
      if (
        this.maintenanceVaults.has(session.target.vaultId) &&
        request.type !== 'finish' &&
        request.type !== 'cancel' &&
        request.type !== 'disconnect'
      )
        return fail(
          'VAULT_MAINTENANCE',
          'Vault rename is in progress; retry shortly',
          true,
        );
      if (request.type === 'activity') {
        if (session.state !== 'connected' && session.state !== 'writing')
          return fail('SESSION_CLOSED', 'Session is not writable');
        const result = await this.enqueue(session, async () => {
          if (session.state !== 'connected' && session.state !== 'writing')
            return fail('SESSION_CLOSED', 'Session is not writable');
          const rendered = await this.options.renderer.dispatch({
            type: 'activity',
            requestId: request.requestId,
            sessionId: session.id,
            activity: request.activity,
          });
          if (!rendered.ok) return fail(rendered.code, rendered.message);
          if (
            'inspected' in rendered ||
            'preview' in rendered ||
            'edited' in rendered
          )
            return fail(
              'INTERNAL',
              'Renderer returned an invalid activity response',
            );
          this.observeDocument(
            session,
            rendered.documentVersion,
            rendered.diskRevision,
          );
          if (session.state !== 'connected' && session.state !== 'writing')
            return fail(
              'SESSION_CLOSED',
              'Session closed before activity update',
            );
          session.activity = request.activity ?? undefined;
          return {
            protocol: AGENT_PROTOCOL_VERSION,
            requestId: request.requestId,
            ok: true as const,
            type: 'activity' as const,
            session: this.status(session),
          };
        });
        return { ...result, requestId: request.requestId };
      }
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
        session.activity = undefined;
        session.state = 'writing';
        const promise = this.enqueue(session, async () => {
          if (session.state !== 'connected' && session.state !== 'writing')
            throw new Error('SESSION_CLOSED');
          if (request.sequence !== session.sequence + 1)
            throw new Error('sequence');
          session.outcomeUncertain = true;
          const result = await this.options.renderer.dispatch({
            type: 'append',
            requestId: request.requestId,
            sessionId: session.id,
            absolutePath: session.target.absolutePath,
            operationId: request.operationId,
            sequence: request.sequence,
            text: request.text,
          });
          if (!result.ok) {
            if (result.code === 'SESSION_CLOSED') {
              session.state = 'failed';
              session.activity = undefined;
            }
            throw Object.assign(new Error(result.message), {
              code: result.code,
            });
          }
          if ('inspected' in result)
            throw new Error(
              'Renderer returned an inspection response for append',
            );
          this.observeDocument(
            session,
            result.documentVersion,
            result.diskRevision,
          );
          session.outcomeUncertain = false;
          if (session.state !== 'connected' && session.state !== 'writing')
            throw new Error('SESSION_CLOSED');
          session.sequence = request.sequence;
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
          if (session.pending === 0 && session.state === 'writing')
            session.state = 'connected';
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
            (error as { code?: string }).code ??
              (errorMessage(error) === 'sequence'
                ? 'INVALID_SEQUENCE'
                : 'SESSION_CLOSED'),
            errorMessage(error),
          );
        }
      }
      if (request.type === 'edit-preview' || request.type === 'edit-apply') {
        const cacheKey = `${session.id}:${request.operationId}`;
        const fingerprint = JSON.stringify([
          request.expectedVersion,
          request.plan,
        ]);
        if (session.state !== 'connected' && session.state !== 'writing')
          return fail('SESSION_CLOSED', 'Session is not writable');

        if (request.type === 'edit-apply') {
          session.pending++;
          session.outcomeUncertain = true;
        }
        const resultPromise = this.enqueue(
          session,
          async (): Promise<AgentResponse> => {
            if (session.state !== 'connected' && session.state !== 'writing')
              return fail('SESSION_CLOSED', 'Session is not writable');
            const rendered = await this.options.renderer.dispatch({
              type: request.type,
              requestId: request.requestId,
              sessionId: session.id,
              expectedVersion: request.expectedVersion,
              plan: request.plan,
            });
            if (!rendered.ok) return fail(rendered.code, rendered.message);
            if (
              'inspected' in rendered ||
              !('preview' in rendered || 'edited' in rendered)
            )
              return fail(
                'INTERNAL',
                'Renderer returned an invalid edit response',
              );
            this.observeDocument(
              session,
              rendered.documentVersion,
              rendered.diskRevision,
            );
            if (request.type === 'edit-apply') session.outcomeUncertain = false;
            if (session.state !== 'connected' && session.state !== 'writing')
              return fail(
                'SESSION_CLOSED',
                'Session closed before acknowledgement',
              );
            return 'preview' in rendered
              ? {
                  protocol: AGENT_PROTOCOL_VERSION,
                  requestId: request.requestId,
                  ok: true,
                  type: 'preview',
                  operationId: request.operationId,
                  content: rendered.content,
                  changed: rendered.changed,
                  documentVersion: rendered.documentVersion,
                  diskRevision: rendered.diskRevision,
                }
              : {
                  protocol: AGENT_PROTOCOL_VERSION,
                  requestId: request.requestId,
                  ok: true,
                  type: 'edited',
                  operationId: request.operationId,
                  content: rendered.content,
                  documentVersion: rendered.documentVersion,
                  diskRevision: rendered.diskRevision,
                  saveState: 'saved',
                };
          },
        ).catch((error) => fail('INTERNAL', errorMessage(error)));
        if (request.type === 'edit-apply') {
          this.editOperations.set(cacheKey, {
            fingerprint,
            result: resultPromise,
          });
          while (this.editOperations.size > MAX_REMEMBERED_OPERATIONS) {
            const oldest = this.editOperations.keys().next().value;
            if (oldest) this.editOperations.delete(oldest);
          }
        }
        const response = await resultPromise;
        if (request.type === 'edit-apply') session.pending--;
        return { ...response, requestId: request.requestId };
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
        if (session.pending > 0) session.outcomeUncertain = true;
        // Cancellation fences queued work immediately and does not wait for a blocked append.
        const cancellation = await this.options.renderer.dispatch({
          type: 'cancel',
          requestId: request.requestId,
          sessionId: session.id,
        });
        // Cancellation remains fenced, but its response is authoritative observation
        // of the renderer's document state (not acknowledgement of queued writes).
        if (cancellation.ok && !('inspected' in cancellation)) {
          this.observeDocument(
            session,
            cancellation.documentVersion,
            cancellation.diskRevision,
          );
          session.outcomeUncertain = false;
        }
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
          if (!rendererResult.ok) {
            if (rendererResult.code === 'SESSION_CLOSED') {
              session.state = 'failed';
              session.activity = undefined;
            }
            throw Object.assign(new Error(rendererResult.message), {
              code: rendererResult.code,
            });
          }
          if ('inspected' in rendererResult)
            throw new Error(
              'Renderer returned an inspection response for finish',
            );
          if (session.state !== 'connected' && session.state !== 'writing')
            throw new Error('SESSION_CLOSED');
          session.state = 'finished';
          session.activity = undefined;
          session.operations.clear();
          session.version = rendererResult.documentVersion;
          session.target.diskRevision = rendererResult.diskRevision;
        }).then(
          () => null,
          (error) => error,
        );
        if (result) {
          const code = (result as { code?: string }).code;
          if (code === 'SESSION_CLOSED')
            return fail('SESSION_CLOSED', errorMessage(result));
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
    session.activity = undefined;
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
  private observeDocument(session: Session, version: number, revision: string) {
    if (version >= session.version) {
      session.version = version;
      session.target.diskRevision = revision;
    }
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
      ...(s.activity ? { activity: s.activity } : {}),
      ...(s.outcomeUncertain ? { outcomeUncertain: true } : {}),
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
  if (r.type === 'inspect') return typeof r.absolutePath === 'string';
  if (r.type === 'connect')
    return (
      typeof r.absolutePath === 'string' &&
      (r.name === undefined ||
        (typeof r.name === 'string' &&
          r.name.length <= 64 &&
          !hasControlCharacter(r.name)))
    );
  if (r.type === 'edit-preview' || r.type === 'edit-apply')
    return (
      typeof r.sessionId === 'string' &&
      typeof r.operationId === 'string' &&
      r.operationId.length <= 128 &&
      Number.isSafeInteger(r.expectedVersion) &&
      Number(r.expectedVersion) >= 0 &&
      isAgentEditPlan(r.plan)
    );
  if (r.type === 'activity')
    return (
      typeof r.sessionId === 'string' &&
      (r.activity === null ||
        r.activity === 'thinking' ||
        r.activity === 'drafting')
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
