import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, createServer } from 'node:net';
import { AGENT_TRANSPORT } from '../shared/agentProtocol';
import {
  startAgentEndpoint,
  readAgentEndpoint,
  sendAgentRequest,
} from './agentEndpoint';
import { AgentBroker } from './agentBroker';

describe('agent endpoint', () => {
  async function socketClosed(
    endpoint: string,
    write?: (socket: ReturnType<typeof connect>) => void,
  ) {
    await new Promise<void>((resolve) => {
      const socket = connect(endpoint, () => write?.(socket));
      socket.once('close', resolve);
      socket.once('error', () => resolve());
    });
  }

  test('settles on peer close and rejects an incomplete response at EOF', async () => {
    for (const response of ['', '{"partial":']) {
      const server = createServer((socket) => {
        socket.once('data', () => {
          if (response) socket.write(response);
          socket.end();
        });
      });
      const socketPath = join(
        await mkdtemp(join(tmpdir(), 'storm-agent-client-')),
        'endpoint.sock',
      );
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      try {
        await assert.rejects(
          sendAgentRequest(
            { endpoint: socketPath, token: 'x' },
            {
              protocol: 1,
              requestId: 'eof',
              type: 'connect',
              absolutePath: '/fake.md',
            },
          ),
          /closed before completing its response/,
        );
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
  });

  test(
    'times out when a peer remains connected without responding',
    { timeout: 35_000 },
    async () => {
      const server = createServer((socket) => socket.on('data', () => {}));
      const dir = await mkdtemp(join(tmpdir(), 'storm-agent-timeout-'));
      const socketPath = join(dir, 'endpoint.sock');
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      try {
        await assert.rejects(
          sendAgentRequest(
            { endpoint: socketPath, token: 'x' },
            {
              protocol: 1,
              requestId: 'timeout',
              type: 'connect',
              absolutePath: '/fake.md',
            },
          ),
          /Agent request timed out/,
        );
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  test('authenticates then dispatches bounded framed broker requests', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'storm-agent-'));
    const broker = new AgentBroker({
      resolveTarget: async () => {
        throw Error('not reached');
      },
      renderer: {
        dispatch: async () => ({ ok: false, code: 'NO', message: 'fake' }),
      },
    });
    const endpoint = await startAgentEndpoint({ broker, userDataPath: dir });
    try {
      assert.deepEqual(await readAgentEndpoint(endpoint.metadataPath), {
        endpoint: endpoint.endpoint,
        token: endpoint.token,
      });
      const response = await sendAgentRequest(endpoint, {
        protocol: 1,
        requestId: 'x',
        type: 'connect',
        absolutePath: '/fake.md',
      });
      assert.equal((response as any).ok, false);
      assert.equal((await readFile(endpoint.metadataPath)).length > 0, true);
    } finally {
      await endpoint.close();
    }
  });

  test('preserves fragmented UTF-8 and dispatches multiple frames in order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'storm-agent-'));
    const requests: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const broker = {
      handle: async (request: any) => {
        requests.push(request.requestId);
        if (request.requestId === 'one') await gate;
        return {
          protocol: 1 as const,
          requestId: request.requestId,
          ok: false as const,
          error: {
            code: 'INVALID_REQUEST' as const,
            message: request.requestId,
            retryable: false,
          },
        };
      },
    };
    const endpoint = await startAgentEndpoint({ broker, userDataPath: dir });
    const socket = connect(endpoint.endpoint);
    try {
      await new Promise<void>((resolve) => socket.once('connect', resolve));
      const first = `${JSON.stringify({ token: endpoint.token, request: { requestId: 'one', text: '🙂' } })}\n`;
      const second = `${JSON.stringify({ request: { requestId: 'two' } })}\n`;
      const bytes = Buffer.from(first + second);
      const split = bytes.indexOf(Buffer.from('🙂')) + 2;
      socket.write(bytes.subarray(0, split));
      socket.write(bytes.subarray(split));
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(requests, ['one']);
      release();
      const lines: unknown[] = [];
      socket.on('data', (chunk) => {
        for (const line of chunk.toString().split('\n').filter(Boolean))
          lines.push(JSON.parse(line));
      });
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (lines.length === 2) {
            clearInterval(check);
            resolve();
          }
        }, 5);
      });
      assert.deepEqual(requests, ['one', 'two']);
      assert.deepEqual(
        lines.map((line: any) => line.requestId),
        ['one', 'two'],
      );
    } finally {
      socket.destroy();
      await endpoint.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('caps aggregate bytes and complete pending frames during broker work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'storm-agent-'));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const endpoint = await startAgentEndpoint({
      broker: {
        handle: async () => {
          await gate;
          return {
            protocol: 1 as const,
            requestId: 'test',
            ok: false as const,
            error: {
              code: 'INVALID_REQUEST' as const,
              message: 'test',
              retryable: false,
            },
          };
        },
      },
      userDataPath: dir,
    });
    try {
      await socketClosed(endpoint.endpoint, (socket) => {
        socket.write(
          `${JSON.stringify({ token: endpoint.token, request: {} })}\n`,
        );
        setTimeout(
          () =>
            socket.write(
              'x\n'.repeat(AGENT_TRANSPORT.maxPendingOperationsPerSession + 1),
            ),
          10,
        );
      });
      release();
    } finally {
      release();
      await endpoint.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('caps aggregate buffered bytes with newlines while broker is blocked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'storm-agent-'));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const endpoint = await startAgentEndpoint({
      broker: {
        handle: async () => {
          await gate;
          return {
            protocol: 1 as const,
            requestId: 'test',
            ok: false as const,
            error: {
              code: 'INVALID_REQUEST' as const,
              message: 'test',
              retryable: false,
            },
          };
        },
      },
      userDataPath: dir,
    });
    try {
      await socketClosed(endpoint.endpoint, (socket) => {
        socket.write(
          `${JSON.stringify({ token: endpoint.token, request: {} })}\n`,
        );
        setTimeout(
          () =>
            socket.write(`x\n${'x'.repeat(2 * AGENT_TRANSPORT.maxFrameBytes)}`),
          10,
        );
      });
    } finally {
      release();
      await endpoint.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('enforces authentication and idle deadlines and closes idle or busy clients', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'storm-agent-'));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const endpoint = await startAgentEndpoint({
      broker: {
        handle: async () => {
          await gate;
          return {
            protocol: 1 as const,
            requestId: 'test',
            ok: false as const,
            error: {
              code: 'INVALID_REQUEST' as const,
              message: 'test',
              retryable: false,
            },
          };
        },
      },
      userDataPath: dir,
      authenticationTimeoutMs: 30,
      idleTimeoutMs: 30,
    });
    try {
      await socketClosed(endpoint.endpoint);
      await socketClosed(endpoint.endpoint, (socket) =>
        socket.write(`${JSON.stringify({ token: endpoint.token })}\n`),
      );
      await socketClosed(endpoint.endpoint, (socket) =>
        socket.write(`${JSON.stringify({ token: endpoint.token })}\n`),
      );
      const quiet = connect(endpoint.endpoint);
      await new Promise<void>((resolve) => quiet.once('connect', resolve));
      const busy = connect(endpoint.endpoint);
      await new Promise<void>((resolve) => busy.once('connect', resolve));
      busy.write(`${JSON.stringify({ token: endpoint.token, request: {} })}\n`);
      await endpoint.close();
      assert.equal(quiet.destroyed, true);
      assert.equal(busy.destroyed, true);
    } finally {
      release();
      await endpoint.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('rejects invalid authentication and oversized unterminated frames', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'storm-agent-'));
    const broker = {
      handle: async () => {
        throw Error('must not dispatch');
      },
    };
    const endpoint = await startAgentEndpoint({ broker, userDataPath: dir });
    try {
      await new Promise<void>((resolve) => {
        const s = connect(endpoint.endpoint, () =>
          s.write('{"token":"bad"}\n'),
        );
        s.on('close', resolve);
      });
      await new Promise<void>((resolve) => {
        const s = connect(endpoint.endpoint, () =>
          s.write('x'.repeat(1_048_577)),
        );
        s.on('close', resolve);
      });
    } finally {
      await endpoint.close();
    }
  });
});
