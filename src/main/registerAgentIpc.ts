import type {
  AgentBroker,
  AgentRendererRequest,
  AgentRendererResult,
} from './agentBroker';
import { isAgentResult } from '../shared/agentBridgeValidation';
import { rendererAuthorizer } from './rendererSecurity';

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
  removeListener?(channel: string, listener: (...args: any[]) => void): void;
  handle(
    channel: string,
    listener: (event: AgentIpcEvent, ...args: unknown[]) => unknown,
  ): void;
}
export interface AgentWebContents {
  id: number;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
  on?(event: string, listener: (...args: any[]) => void): void;
  removeListener?(event: string, listener: (...args: any[]) => void): void;
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
  dispose?(): void;
}
const REQUEST_CHANNEL = 'agent:renderer-request';
const RESPONSE_CHANNEL = 'agent:renderer-response';
const CANCEL_CHANNEL = 'agent:renderer-cancel';
const READY_CHANNEL = 'agent:renderer-ready';
const UNAVAILABLE_CHANNEL = 'agent:renderer-unavailable';
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
  onRendererState: (ready: boolean) => void = () => undefined,
): AgentRendererTransport {
  const pending = new Map<string, (result: AgentRendererResult) => void>();
  let ready = false;
  const teardown = () => {
    if (!ready) return;
    ready = false;
    onRendererState(false);
    for (const resolve of pending.values())
      resolve({
        ok: false,
        code: 'RENDERER_UNAVAILABLE',
        message: 'Storm renderer was torn down; write outcome may be uncertain',
      });
    pending.clear();
  };
  let lifecycleContents: AgentWebContents | undefined;
  const didStartNavigation = (
    _event: unknown,
    _url: string,
    _inPlace: boolean,
    isMainFrame: boolean,
  ) => {
    if (isMainFrame) teardown();
  };
  const attachLifecycle = () => {
    const contents = getWindow()?.webContents;
    if (!contents || contents === lifecycleContents) return;
    lifecycleContents = contents;
    contents.on?.('did-start-navigation', didStartNavigation);
    contents.on?.('render-process-gone', teardown);
    contents.on?.('destroyed', teardown);
  };
  const trusted = rendererAuthorizer(getWindow, acceptedUrl);
  const onReady = (event: AgentIpcEvent) => {
    if (!trusted(event)) return;
    attachLifecycle();
    if (!ready) {
      ready = true;
      onRendererState(true);
    }
  };
  const onUnavailable = (event: AgentIpcEvent) => {
    if (trusted(event)) teardown();
  };
  ipc.on(READY_CHANNEL, onReady);
  ipc.on(UNAVAILABLE_CHANNEL, onUnavailable);
  const onResponse = (
    event: AgentIpcEvent,
    requestId: unknown,
    payload: unknown,
  ) => {
    if (!trusted(event) || typeof requestId !== 'string') return;
    const resolve = pending.get(requestId);
    if (!resolve || !isAgentResult(payload)) return;
    pending.delete(requestId);
    resolve(payload);
  };
  ipc.on(RESPONSE_CHANNEL, onResponse);
  const onCancelEvent = (
    event: AgentIpcEvent,
    sessionId: unknown,
    reason: unknown,
  ) => {
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
  };
  ipc.on(CANCEL_CHANNEL, onCancelEvent);
  return {
    dispatch(request) {
      const window = getWindow();
      if (
        !ready ||
        !window ||
        window.isDestroyed() ||
        window.webContents.isDestroyed()
      )
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
    dispose() {
      teardown();
      ipc.removeListener?.(READY_CHANNEL, onReady);
      ipc.removeListener?.(UNAVAILABLE_CHANNEL, onUnavailable);
      ipc.removeListener?.(RESPONSE_CHANNEL, onResponse);
      ipc.removeListener?.(CANCEL_CHANNEL, onCancelEvent);
      if (lifecycleContents) {
        lifecycleContents.removeListener?.(
          'did-start-navigation',
          didStartNavigation,
        );
        lifecycleContents.removeListener?.('render-process-gone', teardown);
        lifecycleContents.removeListener?.('destroyed', teardown);
        lifecycleContents = undefined;
      }
    },
  };
}

export function bindAgentBrokerIpc(
  ipc: AgentIpcMain,
  broker: AgentBroker,
  getWindow: () => AgentWindow | undefined,
  acceptedUrl: () => string | undefined,
): () => void {
  const trusted = rendererAuthorizer(getWindow, acceptedUrl);
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
