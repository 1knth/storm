import type {
  AgentBroker,
  AgentRendererRequest,
  AgentRendererResult,
} from './agentBroker';
import type {
  AgentBridgeResult,
  AgentBridgeStatusEvent,
} from '../shared/agentBridge';

export interface AgentIpcEvent {
  sender: AgentWebContents;
  senderFrame?: { url: string; parent?: unknown } | null;
}
export interface AgentIpcMain {
  on(
    channel: string,
    listener: (event: AgentIpcEvent, ...args: unknown[]) => void,
  ): void;
  removeHandler(channel: string): void;
  handle(
    channel: string,
    listener: (event: AgentIpcEvent, ...args: unknown[]) => unknown,
  ): void;
}
export interface AgentWebContents {
  id: number;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
}
export interface AgentWindow {
  isDestroyed(): boolean;
  webContents: AgentWebContents;
}
export interface AgentRendererTransport {
  dispatch(request: AgentRendererRequest): Promise<AgentRendererResult>;
  onCancelled?(
    listener: (sessionId: string, reason: string) => void,
  ): () => void;
}
const REQUEST_CHANNEL = 'agent:renderer-request';
const RESPONSE_CHANNEL = 'agent:renderer-response';
const CANCEL_CHANNEL = 'agent:renderer-cancel';
const STATUS_CHANNEL = 'agent:status';
const TIMEOUT_MS = 15_000;
const MAX_PENDING = 128;
const cancellationListeners = new Set<
  (sessionId: string, reason: string) => void
>();

export function registerAgentIpc(
  ipc: AgentIpcMain,
  getWindow: () => AgentWindow | undefined,
  onCancel: (sessionId: string, reason: string) => void,
  acceptedUrl: () => string | undefined,
): AgentRendererTransport {
  const pending = new Map<string, (result: AgentRendererResult) => void>();
  const trusted = (event: AgentIpcEvent): boolean => {
    const window = getWindow();
    const url = acceptedUrl();
    return (
      !!window &&
      !window.isDestroyed() &&
      !window.webContents.isDestroyed() &&
      event.sender.id === window.webContents.id &&
      !!url &&
      !!event.senderFrame &&
      !event.senderFrame.parent &&
      isAcceptedUrl(event.senderFrame.url, url)
    );
  };
  ipc.on(RESPONSE_CHANNEL, (event, requestId, payload) => {
    if (!trusted(event) || typeof requestId !== 'string') return;
    const resolve = pending.get(requestId);
    if (!resolve || !isResult(payload)) return;
    pending.delete(requestId);
    resolve(payload);
  });
  ipc.on(CANCEL_CHANNEL, (event, sessionId, reason) => {
    if (
      !trusted(event) ||
      typeof sessionId !== 'string' ||
      sessionId.length > 128
    )
      return;
    const safeReason =
      typeof reason === 'string'
        ? reason.slice(0, 500)
        : 'Cancelled by renderer';
    onCancel(sessionId, safeReason);
    for (const listener of cancellationListeners)
      listener(sessionId, safeReason);
  });
  return {
    dispatch(request) {
      const window = getWindow();
      if (!window || window.isDestroyed() || window.webContents.isDestroyed())
        return Promise.resolve({
          ok: false,
          code: 'RENDERER_UNAVAILABLE',
          message: 'Storm renderer is unavailable',
        });
      if (pending.size >= MAX_PENDING)
        return Promise.resolve({
          ok: false,
          code: 'QUEUE_FULL',
          message: 'Renderer request queue is full',
        });
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(request.requestId);
          resolve({
            ok: false,
            code: 'RENDERER_TIMEOUT',
            message: 'Renderer did not answer in time',
          });
        }, TIMEOUT_MS);
        pending.set(request.requestId, (result) => {
          clearTimeout(timer);
          resolve(result);
        });
        window.webContents.send(REQUEST_CHANNEL, request);
      });
    },
    onCancelled(listener) {
      const callback = (id: string, reason: string) => listener(id, reason);
      cancellationListeners.add(callback);
      return () => cancellationListeners.delete(callback);
    },
  };
}

export function bindAgentBrokerIpc(
  ipc: AgentIpcMain,
  broker: AgentBroker,
  getWindow: () => AgentWindow | undefined,
  acceptedUrl: () => string | undefined,
): () => void {
  const trusted = (event: AgentIpcEvent): boolean => {
    const window = getWindow();
    const url = acceptedUrl();
    return (
      !!window &&
      !window.isDestroyed() &&
      !window.webContents.isDestroyed() &&
      event.sender.id === window.webContents.id &&
      !!url &&
      !!event.senderFrame &&
      !event.senderFrame.parent &&
      isAcceptedUrl(event.senderFrame.url, url)
    );
  };
  ipc.removeHandler('agent:request');
  ipc.handle('agent:request', async (event, value) =>
    trusted(event)
      ? broker.handle(value)
      : {
          protocol: 1,
          requestId: '',
          ok: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'Untrusted IPC sender',
            retryable: false,
          },
        },
  );
  return () => ipc.removeHandler('agent:request');
}
function isAcceptedUrl(actual: string, expected: string): boolean {
  try {
    const a = new URL(actual);
    const e = new URL(expected);
    return (
      a.origin === e.origin &&
      a.pathname === e.pathname &&
      a.search === e.search &&
      (a.hash === e.hash || !e.hash)
    );
  } catch {
    return actual === expected;
  }
}
export function sendAgentStatus(
  window: AgentWindow | undefined,
  event: AgentBridgeStatusEvent,
): void {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
    window.webContents.send(STATUS_CHANNEL, event);
}
function isResult(value: unknown): value is AgentBridgeResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  if (result.ok === false)
    return (
      typeof result.code === 'string' && typeof result.message === 'string'
    );
  if (result.ok === true && result.inspected === true)
    return (
      result.open === false ||
      (result.open === true &&
        typeof result.content === 'string' &&
        Number.isSafeInteger(result.documentVersion) &&
        typeof result.diskRevision === 'string' &&
        (result.saveState === 'pending' ||
          result.saveState === 'saved' ||
          result.saveState === 'failed'))
    );
  return (
    result.ok === true &&
    Number.isSafeInteger(result.documentVersion) &&
    typeof result.diskRevision === 'string' &&
    (result.content === undefined || typeof result.content === 'string') &&
    (result.saveState === undefined ||
      result.saveState === 'pending' ||
      result.saveState === 'saved' ||
      result.saveState === 'failed')
  );
}
