import { randomUUID } from 'node:crypto';
import {
  isStudyRequest,
  type StudyRequest,
  type StudyValue,
} from '../shared/studyContext';
import { isAgentEditPlan } from '../shared/agentEditValidation';
import { quizLearningFromRequest } from '../shared/quizProtocol';
import { isLessonMapUpdate } from '../shared/lessonMap';
import type {
  AgentBridgeRequest,
  AgentBridgeResult,
} from '../shared/agentBridge';
import { PatchPreviewReceipts } from './patchPreviewReceipts';
import type { AgentNoteTarget } from '../vault/agentNoteTarget';
import { runVaultLifecycleExclusive } from './vaultLifecycle';
import {
  AGENT_TRANSPORT,
  AGENT_PROTOCOL_VERSION,
  type AgentContext,
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
export type AgentRendererRequest = AgentBridgeRequest;
export type AgentRendererResult = AgentBridgeResult;
export interface AgentBrokerOptions {
  study?(request: StudyRequest): Promise<StudyValue>;
  resolveTarget(path: string): Promise<AgentNoteTarget>;
  resolveExistingTarget?(path: string): Promise<AgentNoteTarget>;
  assertTargetRegistered?(target: AgentNoteTarget): Promise<void>;
  withVaultLifecycle?<T>(root: string, operation: () => Promise<T>): Promise<T>;
  renderer: AgentRendererTransport;
  quiz?(
    request: Extract<AgentRequest, { type: 'quiz' }>,
  ): Promise<AgentResponse>;
  getContext?(): Promise<AgentContext>;
  discover?(
    vaultId: string,
    query: string | undefined,
    limit: number,
    options?: { sourcePath?: string; depth?: number; includeSource?: boolean },
  ): Promise<{
    results: Array<{ path: string; name: string; excerpt?: string }>;
    unresolved: Array<{
      sourcePath: string;
      target: string;
      reason: 'missing' | 'ambiguous' | 'invalid';
    }>;
    truncated?: boolean;
  }>;
  resolveLink?(
    vaultId: string,
    sourcePath: string,
    target: string,
  ): Promise<{
    sourcePath: string;
    target: string;
    path?: string;
    reason?: 'missing' | 'ambiguous' | 'invalid';
  }>;
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
  activitySequence: number;
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
  private readonly patchReceipts = new PatchPreviewReceipts();
  private readonly maintenanceVaults = new Set<string>();
  private resolvingConnects = 0;
  private rendererIsReady = true;
  private rendererGeneration = 0;
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
  /** Fence sessions owned by a renderer being torn down. Call rendererReady after its replacement is initialized. */
  rendererUnavailable(): void {
    this.rendererIsReady = false;
    this.rendererGeneration++;
    for (const session of this.sessions.values()) {
      if (session.state === 'connected' || session.state === 'writing') {
        this.patchReceipts.revokeSession(session.id);
        session.state = 'disconnected';
        session.activity = undefined;
        if (session.pending > 0) session.outcomeUncertain = true;
        for (const reject of session.cancelWaiters) reject();
      }
    }
  }

  rendererReady(): void {
    this.rendererIsReady = true;
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
      if (request.type === 'study') {
        if (!this.options.study)
          return fail(
            'CONTEXT_UNAVAILABLE',
            'Study context is unavailable in this build',
          );
        try {
          return {
            protocol: AGENT_PROTOCOL_VERSION,
            requestId: request.requestId,
            ok: true,
            type: 'study',
            result: {
              ok: true,
              value: await this.options.study(request.study),
            },
          };
        } catch (e) {
          const code =
            e instanceof Error && /^STUDY_[A-Z_]+$/.test(e.message)
              ? e.message
              : 'STUDY_UNAVAILABLE';
          return fail('CONTEXT_UNAVAILABLE', code);
        }
      }
      if (request.type === 'quiz') {
        if (!this.options.quiz)
          return fail('CONTEXT_UNAVAILABLE', 'Quiz service is unavailable');
        return await this.options.quiz(request);
      }
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
        if (!this.rendererIsReady)
          return fail('SESSION_CLOSED', 'Renderer is unavailable', true);
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
              activitySequence: 0,
              pending: 0,
              queue: Promise.resolve(),
              operations: new Map(),
              cancelWaiters: new Set(),
              outcomeUncertain: false,
            };
            const generation = this.rendererGeneration;
            const snapshot = await this.options.renderer.dispatch({
              type: 'snapshot',
              requestId: request.requestId,
              sessionId: session.id,
              absolutePath: target.absolutePath,
              vaultId: target.vaultId,
              vaultRoot: target.vaultRoot,
            });
            if (generation !== this.rendererGeneration || !this.rendererIsReady)
              return fail(
                'SESSION_CLOSED',
                'Renderer was replaced during connect',
                true,
              );
            if (!snapshot.ok) return fail(snapshot.code, snapshot.message);
            if ('inspected' in snapshot || 'context' in snapshot)
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
      if (request.type === 'discover') {
        if (!this.options.discover)
          return fail('CONTEXT_UNAVAILABLE', 'Vault discovery is unavailable');
        try {
          const discovery = await this.options.discover(
            request.vaultId,
            request.query,
            request.limit ?? 50,
            {
              sourcePath: request.sourcePath,
              depth: request.depth,
              includeSource: request.includeSource,
            },
          );
          return {
            protocol: AGENT_PROTOCOL_VERSION,
            requestId: request.requestId,
            ok: true,
            type: 'discovery',
            vaultId: request.vaultId,
            ...discovery,
          };
        } catch (error) {
          return fail('INVALID_PATH', errorMessage(error));
        }
      }
      if (request.type === 'resolve-link') {
        if (!this.options.resolveLink)
          return fail(
            'CONTEXT_UNAVAILABLE',
            'Vault link resolution is unavailable',
          );
        try {
          const resolution = await this.options.resolveLink(
            request.vaultId,
            request.sourcePath,
            request.target,
          );
          return {
            protocol: AGENT_PROTOCOL_VERSION,
            requestId: request.requestId,
            ok: true,
            type: 'link-resolution',
            vaultId: request.vaultId,
            ...resolution,
          };
        } catch (error) {
          return fail('INVALID_PATH', errorMessage(error));
        }
      }
      if (request.type === 'context') {
        if (!this.options.getContext)
          return fail('CONTEXT_UNAVAILABLE', 'Context is unavailable');
        try {
          return {
            protocol: AGENT_PROTOCOL_VERSION,
            requestId: request.requestId,
            ok: true,
            type: 'context',
            context: await this.options.getContext(),
          };
        } catch (error) {
          if ((error as { code?: string })?.code === 'CONTEXT_UNAVAILABLE')
            return fail('CONTEXT_UNAVAILABLE', errorMessage(error));
          throw error;
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
        if (request.plan.type === 'replaceText' && !request.previewReceipt)
          return fail(
            'PREVIEW_REQUIRED',
            'Patch apply requires a preview receipt',
          );
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
        session.activity = request.activity ?? undefined;
        const activitySequence = ++session.activitySequence;
        const documentVersion = session.version;
        const status = this.status(session);
        // Invoke in request order, but do not put telemetry on the strict write
        // queue or make the CLI wait for renderer delivery. Rejections are
        // intentionally non-fatal: activity must never block a document write.
        const generation = this.rendererGeneration;
        try {
          void this.options.renderer
            .dispatch({
              type: 'activity',
              requestId: request.requestId,
              sessionId: session.id,
              activity: request.activity,
              activitySequence,
              documentVersion,
            })
            .then((result) => {
              if (generation !== this.rendererGeneration) return;
              if (!result.ok && result.code === 'SESSION_CLOSED') {
                session.state = 'failed';
                session.activity = undefined;
              }
            })
            .catch(() => {});
        } catch {
          // A synchronous transport failure is also best-effort only.
        }
        return {
          protocol: AGENT_PROTOCOL_VERSION,
          requestId: request.requestId,
          ok: true,
          type: 'activity',
          session: status,
        };
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
          const generation = this.rendererGeneration;
          const result = await this.options.renderer.dispatch({
            type: 'append',
            requestId: request.requestId,
            sessionId: session.id,
            absolutePath: session.target.absolutePath,
            operationId: request.operationId,
            sequence: request.sequence,
            text: request.text,
          });
          if (generation !== this.rendererGeneration || !this.rendererIsReady) {
            session.state = 'disconnected';
            session.activity = undefined;
            session.outcomeUncertain = true;
            throw new Error('SESSION_CLOSED');
          }
          if (!result.ok) {
            if (result.code === 'SESSION_CLOSED') {
              session.state = 'failed';
              session.activity = undefined;
            }
            throw Object.assign(new Error(result.message), {
              code: result.code,
            });
          }
          if ('inspected' in result || 'context' in result)
            throw new Error('Renderer returned an invalid response for append');
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
            const generation = this.rendererGeneration;
            let expectedFingerprints:
              | { baseFingerprint: string; resultFingerprint: string }
              | undefined;
            if (
              request.type === 'edit-apply' &&
              request.plan.type === 'replaceText'
            ) {
              const validated = this.patchReceipts.validate({
                receiptId: request.previewReceipt!,
                sessionId: session.id,
                documentIdentity: session.target.absolutePath,
                expectedVersion: String(request.expectedVersion),
                plan: JSON.stringify(request.plan),
                baseContentFingerprint: '',
                resultContentFingerprint: '',
              });
              if (!validated.ok)
                return fail(
                  receiptErrorCode(validated.error),
                  `Patch preview receipt rejected: ${validated.error}`,
                );
              expectedFingerprints = {
                baseFingerprint: validated.value.baseContentFingerprint,
                resultFingerprint: validated.value.resultContentFingerprint,
              };
              const claimed = this.patchReceipts.claim({
                receiptId: request.previewReceipt!,
                sessionId: session.id,
                documentIdentity: session.target.absolutePath,
                expectedVersion: String(request.expectedVersion),
                plan: JSON.stringify(request.plan),
                baseContentFingerprint: validated.value.baseContentFingerprint,
                resultContentFingerprint:
                  validated.value.resultContentFingerprint,
                opId: request.operationId,
              });
              if (!claimed.ok)
                return fail(
                  receiptErrorCode(claimed.error),
                  `Patch preview receipt rejected: ${claimed.error}`,
                );
            }
            const rendered = await this.options.renderer.dispatch({
              type: request.type,
              requestId: request.requestId,
              sessionId: session.id,
              expectedVersion: request.expectedVersion,
              plan: request.plan,
              ...(expectedFingerprints ? { expectedFingerprints } : {}),
            });
            if (
              generation !== this.rendererGeneration ||
              !this.rendererIsReady
            ) {
              session.state = 'disconnected';
              session.activity = undefined;
              if (request.type === 'edit-apply')
                session.outcomeUncertain = true;
              return fail(
                'SESSION_CLOSED',
                'Renderer was replaced during edit',
                true,
              );
            }
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
            if ('preview' in rendered) {
              let receiptFields = {};
              if (
                request.type === 'edit-preview' &&
                request.plan.type === 'replaceText'
              ) {
                if (
                  !rendered.edits ||
                  !rendered.baseFingerprint ||
                  !rendered.resultFingerprint
                )
                  return fail(
                    'INTERNAL',
                    'Renderer omitted patch preview fingerprints',
                  );
                const receipt = this.patchReceipts.issue({
                  sessionId: session.id,
                  documentIdentity: session.target.absolutePath,
                  expectedVersion: String(request.expectedVersion),
                  plan: JSON.stringify(request.plan),
                  baseContentFingerprint: rendered.baseFingerprint,
                  resultContentFingerprint: rendered.resultFingerprint,
                });
                if (!receipt.ok)
                  return fail(
                    'INTERNAL',
                    'Patch preview receipt capacity exhausted',
                  );
                receiptFields = {
                  previewReceipt: receipt.value.receiptId,
                  expiresAt: receipt.value.expiresAt,
                  baseFingerprint: rendered.baseFingerprint,
                  resultFingerprint: rendered.resultFingerprint,
                  edits: rendered.edits,
                };
              }
              return {
                protocol: AGENT_PROTOCOL_VERSION,
                requestId: request.requestId,
                ok: true,
                type: 'preview',
                operationId: request.operationId,
                ...receiptFields,
                content: rendered.content,
                changed: rendered.changed,
                documentVersion: rendered.documentVersion,
                diskRevision: rendered.diskRevision,
              };
            }
            return {
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
        if (
          cancellation.ok &&
          !('inspected' in cancellation) &&
          !('context' in cancellation)
        ) {
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
          if ('inspected' in rendererResult || 'context' in rendererResult)
            throw new Error('Renderer returned an invalid response for finish');
          if (session.state !== 'connected' && session.state !== 'writing')
            throw new Error('SESSION_CLOSED');
          this.patchReceipts.revokeSession(session.id);
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
    this.patchReceipts.revokeSession(session.id);
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
function receiptErrorCode(
  error: import('./patchPreviewReceipts').ReceiptErrorCode,
): string {
  if (error === 'expired') return 'PREVIEW_EXPIRED';
  return error === 'version_mismatch' ? 'STALE_VERSION' : 'PREVIEW_REJECTED';
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
function isQuizAgentRequest(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  const common =
    typeof r.sessionId === 'string' &&
    r.sessionId.length > 0 &&
    typeof r.agentToken === 'string' &&
    r.agentToken.length > 0 &&
    r.agentToken.length <= 512 &&
    Number.isSafeInteger(r.expectedRevision) &&
    Number(r.expectedRevision) >= 0 &&
    typeof r.idempotencyKey === 'string' &&
    r.idempotencyKey.length > 0 &&
    r.idempotencyKey.length <= 128;
  if (
    !common ||
    (r.handledThroughCursor !== undefined &&
      (!Number.isSafeInteger(r.handledThroughCursor) ||
        Number(r.handledThroughCursor) < 0))
  )
    return false;
  if (r.type === 'attach') return true;
  if (r.type === 'pose-question') {
    if (quizLearningFromRequest(r) === null) return false;
    if (
      r.studyBasis !== undefined &&
      (typeof r.studyBasis !== 'string' || !/^[a-f0-9]{64}$/.test(r.studyBasis))
    )
      return false;
    if (
      typeof r.question !== 'string' ||
      r.question.length < 1 ||
      r.question.length > 4000
    )
      return false;
    const kind = r.kind ?? 'multiple-choice';
    if (kind === 'short-answer' || kind === 'long-answer')
      return (
        r.choices === undefined &&
        r.leftItems === undefined &&
        r.rightItems === undefined
      );
    if (kind === 'matching') {
      const validItems = (items: unknown) =>
        Array.isArray(items) &&
        items.length >= 2 &&
        items.length <= 12 &&
        items.every(
          (item) =>
            !!item &&
            typeof item === 'object' &&
            typeof (item as Record<string, unknown>).id === 'string' &&
            !!(item as Record<string, unknown>).id &&
            typeof (item as Record<string, unknown>).text === 'string' &&
            !!(item as Record<string, unknown>).text,
        );
      const left = r.leftItems as Array<{ id: string }> | undefined;
      const right = r.rightItems as Array<{ id: string }> | undefined;
      return (
        r.choices === undefined &&
        validItems(left) &&
        validItems(right) &&
        left!.length === right!.length &&
        new Set([...left!, ...right!].map((item) => item.id)).size ===
          left!.length + right!.length
      );
    }
    if (kind !== 'multiple-choice') return false;
    return (
      Array.isArray(r.choices) &&
      r.choices.length >= 1 &&
      r.choices.length <= 6 &&
      r.choices.every(
        (choice) =>
          !!choice &&
          typeof choice === 'object' &&
          typeof (choice as Record<string, unknown>).id === 'string' &&
          !!(choice as Record<string, unknown>).id &&
          typeof (choice as Record<string, unknown>).text === 'string' &&
          !!(choice as Record<string, unknown>).text,
      ) &&
      new Set((r.choices as Array<{ id: string }>).map((choice) => choice.id))
        .size === r.choices.length
    );
  }
  if (r.type === 'pose-prompt') {
    return (
      (r.kind === 'next-steps' || r.kind === 'clarification') &&
      typeof r.prompt === 'string' &&
      r.prompt.length > 0 &&
      r.prompt.length <= 4000 &&
      Array.isArray(r.choices) &&
      r.choices.length >= 1 &&
      r.choices.length <= 6 &&
      r.choices.every(
        (choice) =>
          !!choice &&
          typeof choice === 'object' &&
          typeof (choice as Record<string, unknown>).id === 'string' &&
          !!(choice as Record<string, unknown>).id &&
          typeof (choice as Record<string, unknown>).text === 'string' &&
          !!(choice as Record<string, unknown>).text,
      ) &&
      new Set((r.choices as Array<{ id: string }>).map((choice) => choice.id))
        .size === r.choices.length &&
      (r.promptId === undefined ||
        (typeof r.promptId === 'string' &&
          r.promptId.length > 0 &&
          r.promptId.length <= 128))
    );
  }
  if (r.type === 'support-update')
    return (
      typeof r.questionId === 'string' &&
      !!r.questionId.trim() &&
      r.questionId.length <= 128 &&
      ['independent', 'hinted', 'worked'].includes(String(r.support)) &&
      typeof r.text === 'string' &&
      !!r.text.trim() &&
      r.text.length <= 10000
    );
  if (r.type === 'skip-question')
    return (
      typeof r.questionId === 'string' &&
      !!r.questionId.trim() &&
      r.questionId.length <= 128 &&
      typeof r.text === 'string' &&
      !!r.text.trim() &&
      r.text.length <= 10000
    );
  if (r.type === 'lesson-map') return isLessonMapUpdate(r.map);
  if (r.type === 'feedback' || r.type === 'agent-message')
    return (
      typeof r.text === 'string' &&
      r.text.length > 0 &&
      r.text.length <= 10000 &&
      (r.type !== 'feedback' ||
        r.verdict === undefined ||
        ['correct', 'incorrect', 'partial'].includes(String(r.verdict)))
    );
  return false;
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
  if (r.type === 'study') return isStudyRequest(r.study);
  if (r.type === 'quiz') {
    if (r.operation === 'list' || r.operation === 'capabilities') return true;
    if (r.operation === 'detach' || r.operation === 'activity')
      return (
        typeof r.sessionId === 'string' &&
        r.sessionId.length > 0 &&
        r.sessionId.length <= 128 &&
        typeof r.agentToken === 'string' &&
        r.agentToken.length > 0 &&
        r.agentToken.length <= 512 &&
        (r.operation !== 'activity' ||
          ['idle', 'thinking', 'drafting'].includes(String(r.state)))
      );
    if (r.operation === 'attach')
      return (
        (r.compact === undefined || typeof r.compact === 'boolean') &&
        typeof r.sessionId === 'string' &&
        r.sessionId.length > 0 &&
        typeof r.clientId === 'string' &&
        r.clientId.length > 0 &&
        r.clientId.length <= 128
      );
    if (r.operation === 'image-fetch' || r.operation === 'image-release')
      return (
        typeof r.sessionId === 'string' &&
        r.sessionId.length > 0 &&
        r.sessionId.length <= 128 &&
        typeof r.agentToken === 'string' &&
        r.agentToken.length > 0 &&
        r.agentToken.length <= 512 &&
        typeof r.imageId === 'string' &&
        r.imageId.length > 0 &&
        r.imageId.length <= 128
      );
    if (r.operation === 'learner')
      return (
        typeof r.sessionId === 'string' &&
        r.sessionId.length > 0 &&
        r.sessionId.length <= 128 &&
        typeof r.agentToken === 'string' &&
        r.agentToken.length > 0 &&
        r.agentToken.length <= 512
      );
    if (r.operation === 'context')
      return (
        typeof r.sessionId === 'string' &&
        r.sessionId.length > 0 &&
        typeof r.agentToken === 'string' &&
        r.agentToken.length > 0 &&
        r.agentToken.length <= 512 &&
        ['history', 'question', 'prompt', 'scope', 'event'].includes(
          String(r.section),
        ) &&
        [r.before, r.offset].every(
          (item) =>
            item === undefined ||
            (Number.isSafeInteger(item) && Number(item) >= 0),
        )
      );
    if (r.operation === 'snapshot')
      return (
        (r.compact === undefined || typeof r.compact === 'boolean') &&
        (r.recover === undefined || typeof r.recover === 'boolean') &&
        typeof r.sessionId === 'string' &&
        r.sessionId.length > 0 &&
        typeof r.agentToken === 'string' &&
        r.agentToken.length > 0 &&
        r.agentToken.length <= 512 &&
        (r.after === undefined ||
          (Number.isSafeInteger(r.after) && Number(r.after) >= 0))
      );
    if (r.operation === 'request') return isQuizAgentRequest(r.request);
    return false;
  }
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
  if (r.type === 'context') return true;
  if (r.type === 'resolve-link')
    return (
      typeof r.vaultId === 'string' &&
      r.vaultId.length > 0 &&
      typeof r.sourcePath === 'string' &&
      r.sourcePath.length > 0 &&
      typeof r.target === 'string' &&
      r.target.length > 0 &&
      r.target.length <= 512
    );
  if (r.type === 'discover') {
    const hasSourcePath =
      typeof r.sourcePath === 'string' && r.sourcePath.length > 0;
    return (
      typeof r.vaultId === 'string' &&
      r.vaultId.length > 0 &&
      (r.query === undefined ||
        (typeof r.query === 'string' && r.query.length <= 256)) &&
      (r.limit === undefined ||
        (Number.isSafeInteger(r.limit) &&
          Number(r.limit) >= 1 &&
          Number(r.limit) <= 100)) &&
      (r.sourcePath === undefined || hasSourcePath) &&
      (r.depth === undefined ||
        (Number.isSafeInteger(r.depth) &&
          Number(r.depth) >= 0 &&
          Number(r.depth) <= 5)) &&
      (r.includeSource === undefined || typeof r.includeSource === 'boolean') &&
      ((r.depth === undefined && r.includeSource === undefined) ||
        hasSourcePath)
    );
  }
  return (
    ['finish', 'cancel', 'status', 'disconnect'].includes(String(r.type)) &&
    (r.sessionId === undefined || typeof r.sessionId === 'string')
  );
}
