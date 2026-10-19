import {
  createServer,
  connect as connectSocket,
  type Server,
  type Socket,
} from 'node:net';
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
  const server: Server = createServer((socket) =>
    serveSocket(socket, token, options.broker),
  );
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
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const metadata = await readAgentEndpoint(metadataPath).catch(() => null);
      if (metadata?.endpoint === endpoint && metadata.token === token) {
        await rm(endpoint, { force: true });
        await rm(metadataPath, { force: true });
      }
    },
  };
}
function serveSocket(
  socket: Socket,
  token: string,
  broker: Pick<AgentBroker, 'handle'>,
): void {
  let buffer = Buffer.alloc(0);
  let authenticated = false;
  let busy = false;
  socket.on('data', async (chunk) => {
    if (typeof chunk === 'string') chunk = Buffer.from(chunk);
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > AGENT_TRANSPORT.maxFrameBytes && !buffer.includes(10)) {
      socket.destroy();
      return;
    }
    while (!busy) {
      const newline = buffer.indexOf(10);
      if (newline < 0) break;
      if (newline > AGENT_TRANSPORT.maxFrameBytes) {
        socket.destroy();
        return;
      }
      const line = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
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
            return;
          }
          authenticated = true;
          if (envelope.request === undefined) continue;
        }
        if (envelope.request === undefined) {
          socket.destroy();
          return;
        }
        busy = true;
        const response = await broker.handle(envelope.request);
        if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
      } catch {
        socket.destroy();
        return;
      } finally {
        busy = false;
      }
    }
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
export function sendAgentRequest(
  info: AgentEndpointInfo,
  request: AgentRequest,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connectSocket(info.endpoint);
    let buffer = '';
    socket.once('error', reject);
    socket.on('connect', () =>
      socket.write(`${JSON.stringify({ token: info.token, request })}\n`),
    );
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const end = buffer.indexOf('\n');
      if (end >= 0) {
        socket.end();
        try {
          resolve(JSON.parse(buffer.slice(0, end)));
        } catch (error) {
          reject(error);
        }
      }
    });
  });
}
