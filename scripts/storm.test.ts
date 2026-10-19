import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from './storm';
import { startAgentEndpoint } from '../src/main/agentEndpoint';

test('CLI help is available offline and invalid commands fail with usage', () => {
  const script = new URL('./storm.ts', import.meta.url).pathname;
  const home = '/tmp/storm-cli-no-endpoint';
  for (const args of [
    [],
    ['--help'],
    ['connect', '--help'],
    ['stream', '--help'],
    ['status', '--help'],
    ['finish', '--help'],
    ['cancel', '--help'],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    });
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    assert.match(result.stdout, /Usage:/);
  }
  for (const args of [
    ['not-a-command'],
    ['connect'],
    ['stream', 'session'],
    ['--unknown'],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    });
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
    assert.match(result.stderr, /Usage:/);
    assert.doesNotMatch(result.stderr, /ENOENT|storm-cli-no-endpoint/);
  }
});

test('status accepts the documented session plus --json spelling', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'storm-cli-status-'));
  const requests: any[] = [];
  const endpoint = await startAgentEndpoint({
    userDataPath: directory,
    broker: {
      async handle(value: any) {
        requests.push(value);
        return {
          protocol: 1,
          requestId: value.requestId,
          ok: true,
          type: 'status',
          sessions: [],
        };
      },
    },
  });
  try {
    assert.equal(
      await runCli(
        ['--endpoint', endpoint.metadataPath, 'status', 'session', '--json'],
        { stdout: () => {}, stderr: () => {} },
      ),
      0,
    );
    assert.deepEqual(
      requests.map((request) => [request.type, request.sessionId]),
      [['status', 'session']],
    );
  } finally {
    await endpoint.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('project-local Storm skill has portable frontmatter and resolves the CLI relatively', async () => {
  const { readFile } = await import('node:fs/promises');
  const skillPath = new URL('../.pi/skills/storm/SKILL.md', import.meta.url);
  const content = await readFile(skillPath, 'utf8');
  assert.match(content, /^---\nname: storm\ndescription: .+\n---/);
  assert.match(content, /bun scripts\/storm\.ts --help/);
  assert.ok(existsSync(new URL('../../../scripts/storm.ts', skillPath)));
});

test('CLI stream forwards a small chunk before stdin EOF', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'storm-cli-live-'));
  const received: any[] = [];
  let release!: () => void;
  const endpoint = await startAgentEndpoint({
    userDataPath: directory,
    broker: {
      async handle(value: any) {
        received.push(value);
        if (value.type === 'append')
          return {
            protocol: 1,
            requestId: value.requestId,
            ok: true,
            type: 'accepted',
            operationId: value.operationId,
            documentVersion: value.sequence,
            saveState: 'pending',
          };
        return {
          protocol: 1,
          requestId: value.requestId,
          ok: true,
          type: value.type === 'status' ? 'status' : 'closed',
          ...(value.type === 'status' ? { sessions: [] } : { session: {} }),
        };
      },
    },
  });
  let started!: () => void;
  const appendSeen = new Promise<void>((resolve) => {
    started = resolve;
  });
  const stdin = (async function* () {
    yield Buffer.from('small 🌊');
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  })();
  try {
    const running = runCli(
      ['--endpoint', endpoint.metadataPath, 'stream', 'session', '--stdin'],
      {
        stdin,
        stdout: () => {},
        stderr: () => {},
      },
    );
    // Wait for the endpoint's append request, while the iterator is deliberately
    // blocked and has not emitted EOF.
    const observed = (async () => {
      while (!received.some((request) => request.type === 'append'))
        await new Promise((resolve) => setTimeout(resolve, 2));
      started();
    })();
    await appendSeen;
    assert.equal(
      received.find((request) => request.type === 'append').text,
      'small 🌊',
    );
    assert.equal(
      received.some((request) => request.type === 'finish'),
      false,
    );
    release();
    await observed;
    assert.equal(await running, 0);
    assert.equal(received.at(-1).type, 'finish');
  } finally {
    release?.();
    await endpoint.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI child exits on cancellation while stdin remains open and never finishes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'storm-cli-child-'));
  const requests: any[] = [];
  let cancelSession = false;
  let notifyRequest!: () => void;
  const requestChanged = new Promise<void>((resolve) => {
    notifyRequest = resolve;
  });
  const endpoint = await startAgentEndpoint({
    userDataPath: directory,
    broker: {
      async handle(value: any) {
        requests.push(value);
        notifyRequest();
        if (value.type === 'append')
          return {
            protocol: 1,
            requestId: value.requestId,
            ok: true,
            type: 'accepted',
            operationId: value.operationId,
            documentVersion: value.sequence,
            saveState: 'saved',
          };
        if (value.type === 'status')
          return {
            protocol: 1,
            requestId: value.requestId,
            ok: true,
            type: 'status',
            sessions: [
              {
                sessionId: 'session',
                state: cancelSession ? 'cancelled' : 'connected',
              },
            ],
          };
        return {
          protocol: 1,
          requestId: value.requestId,
          ok: true,
          type: 'closed',
          session: {},
        };
      },
    },
  });
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const script = new URL('./storm.ts', import.meta.url).pathname;
    child = spawn(
      'bun',
      [
        script,
        '--endpoint',
        endpoint.metadataPath,
        'stream',
        'session',
        '--stdin',
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text: string) => (stderr += text));
    const exited = new Promise<number>((resolve, reject) => {
      child!.once('error', reject);
      child!.once('exit', (code) => resolve(code ?? -1));
    });
    child.stdin.write('first chunk');

    const waitFor = async (predicate: () => boolean, description: string) => {
      const deadline = Date.now() + 3000;
      while (!predicate()) {
        if (Date.now() >= deadline)
          throw new Error(`Timed out waiting for ${description}`);
        await Promise.race([
          requestChanged,
          new Promise((resolve) => setTimeout(resolve, 10)),
        ]);
      }
    };
    await waitFor(
      () => requests.some((request) => request.type === 'append'),
      'append',
    );
    cancelSession = true;
    const code = await Promise.race([
      exited,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('CLI child did not exit before stdin EOF')),
          3000,
        ),
      ),
    ]);
    assert.notEqual(code, 0, stderr);
    assert.equal(
      requests.some((request) => request.type === 'finish'),
      false,
    );
  } finally {
    child?.stdin.destroy();
    if (child && child.exitCode === null) child.kill();
    await endpoint.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI stream finishes on stdin EOF and cancellation failure exits nonzero', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'storm-cli-test-'));
  const calls: string[] = [];
  const received: any[] = [];
  const appended: string[] = [];
  let cancelFails = true;
  const endpoint = await startAgentEndpoint({
    userDataPath: directory,
    broker: {
      async handle(value: any) {
        calls.push(value.type);
        received.push(value);
        if (value.type === 'append') appended.push(value.text);
        if (value.type === 'cancel' && cancelFails)
          return {
            protocol: 1,
            requestId: value.requestId,
            ok: false,
            error: {
              code: 'SESSION_CLOSED',
              message: 'cancel rejected',
              retryable: false,
            },
          };
        if (value.type === 'append')
          return {
            protocol: 1,
            requestId: value.requestId,
            ok: true,
            type: 'accepted',
            operationId: value.operationId,
            documentVersion: value.sequence,
            saveState: 'saved',
          };
        return {
          protocol: 1,
          requestId: value.requestId,
          ok: true,
          type: value.type === 'status' ? 'status' : 'closed',
          ...(value.type === 'status' ? { sessions: [] } : { session: {} }),
        };
      },
    },
  });
  try {
    assert.equal(
      await runCli(
        [
          '--endpoint',
          endpoint.metadataPath,
          'connect',
          '/vault/note.md',
          '--json',
        ],
        { stdout: () => {}, stderr: () => {} },
      ),
      0,
    );
    assert.equal(received[0]?.type, 'connect');
    assert.equal(received[0]?.absolutePath, '/vault/note.md');
    calls.length = 0;
    received.length = 0;
    const stdin = (async function* () {
      yield Buffer.from('one');
      yield Buffer.from('two');
      yield Buffer.from([0xf0, 0x9f]);
      yield Buffer.from([0x8c, 0x8a]);
    })();
    assert.equal(
      await runCli(
        ['--endpoint', endpoint.metadataPath, 'stream', 'session', '--stdin'],
        {
          stdin,
          stdout: () => {},
          stderr: () => {},
        },
      ),
      0,
    );
    assert.deepEqual(calls, ['append', 'append', 'append', 'finish']);
    assert.equal(appended.join(''), 'onetwo🌊');
    calls.length = 0;
    const errors: string[] = [];
    assert.equal(
      await runCli(['--endpoint', endpoint.metadataPath, 'cancel', 'session'], {
        stdout: () => {},
        stderr: (text) => errors.push(text),
      }),
      1,
    );
    assert.deepEqual(calls, ['cancel']);
    assert.match(errors.join(''), /cancel rejected/);
  } finally {
    cancelFails = false;
    await endpoint.close();
    await rm(directory, { recursive: true, force: true });
  }
});
