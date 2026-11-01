import {
  createServer,
  connect as connectSocket,
  type Server,
  type Socket,
} from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentBroker } from './agentBroker';
import { AGENT_TRANSPORT, type AgentRequest } from '../shared/agentProtocol';

export interface AgentEndpointInfo {
  endpoint: string;
  token: string;
}
export interface StartedAgentEndpoint extends AgentEndpointInfo {
  close(): Promise<void>;
  metadataPath: string;
}

/** Starts the private local socket adapter for an already-configured broker. */
export async function startAgentEndpoint(options: {
  broker: Pick<AgentBroker, 'handle'>;
  userDataPath: string;
  authenticationTimeoutMs?: number;
  idleTimeoutMs?: number;
}): Promise<StartedAgentEndpoint> {
  await mkdir(options.userDataPath, { recursive: true, mode: 0o700 });
  await chmod(options.userDataPath, 0o700);
  const endpoint = join(options.userDataPath, 'storm-agent.sock');
  const metadataPath = join(options.userDataPath, 'storm-agent.json');
  try {
    const info = await lstat(endpoint);
    if (!info.isSocket())
      throw new Error('Refusing to replace a non-socket agent endpoint');
    const active = await new Promise<boolean>((resolve) => {
      const probe = connectSocket(endpoint);
      probe.once('connect', () => {
        probe.destroy();
        resolve(true);
      });
      probe.once('error', () => resolve(false));
    });
    if (active) throw new Error('Storm agent endpoint is already active');
    await rm(endpoint);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const token = randomBytes(32).toString('hex');
  const sockets = new Set<Socket>();
  let closing: Promise<void> | undefined;
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    serveSocket(socket, token, options.broker, {
      authenticationTimeoutMs: options.authenticationTimeoutMs ?? 5_000,
      idleTimeoutMs: options.idleTimeoutMs ?? 60_000,
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, resolve);
  });
  await chmod(endpoint, 0o600);
  await writeFile(metadataPath, JSON.stringify({ endpoint, token }), {
    mode: 0o600,
  });
  await chmod(metadataPath, 0o600);
  return {
    endpoint,
    token,
    metadataPath,
    close: () =>
      (closing ??= (async () => {
        const stopped = new Promise<void>((resolve) =>
          server.close(() => resolve()),
        );
        for (const socket of sockets) socket.destroy();
        await stopped;
        const metadata = await readAgentEndpoint(metadataPath).catch(
          () => null,
        );
        if (metadata?.endpoint === endpoint && metadata.token === token) {
          await rm(endpoint, { force: true });
          await rm(metadataPath, { force: true });
        }
      })()),
  };
}
function serveSocket(
  socket: Socket,
  token: string,
  broker: Pick<AgentBroker, 'handle'>,
  timeouts: { authenticationTimeoutMs: number; idleTimeoutMs: number },
): void {
  let buffer = Buffer.alloc(0);
  let authenticated = false;
  let pendingFrames = 0;
  let draining = false;
  let deadline: NodeJS.Timeout;
  const armIdleDeadline = () => {
    clearTimeout(deadline);
    if (socket.destroyed) return;
    deadline = setTimeout(() => socket.destroy(), timeouts.idleTimeoutMs);
  };
  deadline = setTimeout(
    () => socket.destroy(),
    timeouts.authenticationTimeoutMs,
  );
  socket.on('error', () => socket.destroy());
  socket.once('close', () => clearTimeout(deadline));
  socket.on('data', (chunk) => {
    if (typeof chunk === 'string') chunk = Buffer.from(chunk);
    if (buffer.length + chunk.length > 2 * AGENT_TRANSPORT.maxFrameBytes) {
      socket.destroy();
      return;
    }
    const incomingFrames = chunk.reduce(
      (count, byte) => count + Number(byte === 10),
      0,
    );
    if (
      pendingFrames + incomingFrames >
      AGENT_TRANSPORT.maxPendingOperationsPerSession
    ) {
      socket.destroy();
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    pendingFrames += incomingFrames;
    if (authenticated) armIdleDeadline();
    if (
      buffer.length > AGENT_TRANSPORT.maxFrameBytes &&
      buffer.indexOf(10) < 0
    ) {
      socket.destroy();
      return;
    }
    if (!draining) void drain();
  });

  async function drain(): Promise<void> {
    draining = true;
    try {
      while (!socket.destroyed) {
        const newline = buffer.indexOf(10);
        if (newline < 0) break;
        if (newline > AGENT_TRANSPORT.maxFrameBytes) {
          socket.destroy();
          break;
        }
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        pendingFrames -= 1;
        try {
          const envelope = JSON.parse(line.toString('utf8')) as {
            token?: unknown;
            request?: unknown;
          };
          if (!authenticated) {
            if (
              typeof envelope.token !== 'string' ||
              !safeEqual(envelope.token, token)
            ) {
              socket.destroy();
              break;
            }
            authenticated = true;
            armIdleDeadline();
            if (envelope.request === undefined) continue;
          }
          if (envelope.request === undefined) {
            socket.destroy();
            break;
          }
          const response = await broker.handle(envelope.request);
          if (!socket.destroyed) {
            const writable = socket.write(`${JSON.stringify(response)}\n`);
            if (!writable) await waitForDrain(socket);
          }
        } catch {
          socket.destroy();
          break;
        }
        armIdleDeadline();
      }
    } finally {
      draining = false;
      if (!socket.destroyed && buffer.includes(10)) void drain();
    }
  }
}
function waitForDrain(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      socket.removeListener('drain', done);
      socket.removeListener('close', done);
      resolve();
    };
    socket.once('drain', done);
    socket.once('close', done);
    if (socket.destroyed) done();
  });
}
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function readAgentEndpoint(
  path: string,
): Promise<AgentEndpointInfo> {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    (process.getuid && metadata.uid !== process.getuid()) ||
    (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0)
  )
    throw new Error('Unsafe endpoint metadata permissions');
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as AgentEndpointInfo).endpoint !== 'string' ||
    !(value as AgentEndpointInfo).endpoint ||
    typeof (value as AgentEndpointInfo).token !== 'string' ||
    !/^[a-f0-9]{64}$/.test((value as AgentEndpointInfo).token)
  )
    throw new Error('Invalid endpoint metadata');
  return value as AgentEndpointInfo;
}
const AGENT_REQUEST_TIMEOUT_MS = 30_000;

export function sendAgentRequest(
  info: AgentEndpointInfo,
  request: AgentRequest,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connectSocket(info.endpoint);
    let buffer = '';
    const decoder = new StringDecoder('utf8');
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeListener('connect', onConnect);
      socket.removeListener('data', onData);
      socket.removeListener('end', onEnd);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    };
    const finish = (error?: unknown, value?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      if (error !== undefined) reject(error);
      else resolve(value);
    };
    const onConnect = () =>
      socket.write(`${JSON.stringify({ token: info.token, request })}\n`);
    const onData = (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      const end = buffer.indexOf('\n');
      if (end >= 0) {
        try {
          finish(undefined, JSON.parse(buffer.slice(0, end)));
        } catch (error) {
          finish(error);
        }
      }
    };
    const onEnd = () =>
      finish(new Error('Agent endpoint closed before completing its response'));
    const onError = (error: Error) => finish(error);
    const onClose = () =>
      finish(new Error('Agent endpoint closed before completing its response'));
    const timeout = setTimeout(
      () => finish(new Error('Agent request timed out')),
      AGENT_REQUEST_TIMEOUT_MS,
    );
    socket.once('connect', onConnect);
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}
