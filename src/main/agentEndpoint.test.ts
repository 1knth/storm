import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, createServer } from 'node:net';
import {
  startAgentEndpoint,
  readAgentEndpoint,
  sendAgentRequest,
} from './agentEndpoint';
import { AgentBroker } from './agentBroker';

describe('agent endpoint', () => {
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
