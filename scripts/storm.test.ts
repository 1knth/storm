import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverEndpoint, runCli } from './storm';
import { assertNativeTarget, buildCliBinary } from './buildCli';
import { startAgentEndpoint } from '../src/main/agentEndpoint';

test('CLI compiler rejects cross-platform targets instead of downloading a runtime', async () => {
  assert.throws(
    () => assertNativeTarget('linux', 'x64', 'darwin', 'arm64'),
    /only for the current host/,
  );
  let invoked = false;
  await assert.rejects(
    buildCliBinary('linux', 'x64', {
      root: '/tmp/storm-cli-build-test',
      hostPlatform: 'darwin',
      hostArch: 'arm64',
      run: (() => {
        invoked = true;
        return { status: 0 };
      }) as any,
    }),
    /only for the current host/,
  );
  assert.equal(invoked, false);
});

test('CLI compiler packages the matching host target into the resource directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'storm-cli-compile-'));
  try {
    const output = await buildCliBinary(process.platform, os.arch(), {
      root,
      sourceRoot: process.cwd(),
      hostPlatform: process.platform,
      hostArch: os.arch(),
    });
    assert.equal(
      path.relative(root, output),
      path.join('build', 'cli', 'storm'),
    );
    assert.ok(existsSync(output));
    assert.ok(existsSync(path.join(root, 'build', 'cli', 'storm.mjs')));
    assert.ok(existsSync(path.join(root, 'build', 'cli', 'runtime', 'bun')));
    const result = spawnSync(output, ['--help'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: '/usr/bin:/bin' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('standalone CLI works from a spaced path without development tools or an installed app', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'Storm CLI Test '));
  const home = path.join(scratch, 'isolated home');
  const root = path.join(scratch, 'bundle');
  const bin = path.join(scratch, 'bin');
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
  let endpoint: Awaited<ReturnType<typeof startAgentEndpoint>> | undefined;
  const requests: any[] = [];
  try {
    const bundledCli = await buildCliBinary(process.platform, os.arch(), {
      root,
      sourceRoot: process.cwd(),
    });
    const installedCli = path.join(bin, 'storm');
    await symlink(bundledCli, installedCli);
    const env = { PATH: '/usr/bin:/bin', HOME: home };
    const run = (args: string[]) =>
      spawnSync(installedCli, args, {
        cwd: scratch,
        encoding: 'utf8',
        env,
      });

    for (const args of [[], ['--help'], ['connect', '--help']]) {
      const result = run(args);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Usage:/);
      assert.match(result.stdout, /storm/);
      assert.doesNotMatch(result.stdout, /bun scripts\/storm\.ts/);
      assert.doesNotMatch(
        result.stdout,
        /there is not yet an installed storm executable/i,
      );
      if (args.length === 0 || args[0] === '--help')
        assert.match(result.stdout, /Application Support\/Storm/);
    }
    for (const args of [['--unknown'], ['not-a-command']]) {
      const result = run(args);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /Usage:/);
      assert.doesNotMatch(result.stderr, /ENOENT|isolated home/);
    }

    const appData = path.join(home, 'Library', 'Application Support', 'Storm');
    endpoint = await startAgentEndpoint({
      userDataPath: appData,
      broker: {
        async handle(value: any) {
          requests.push(value);
          return {
            protocol: 1,
            requestId: value.requestId,
            ok: true,
            type: value.type === 'connect' ? 'connected' : value.type,
            name: value.name,
            sessionId:
              value.type === 'connect' ? 'packaged-session' : undefined,
            sessions: [],
          };
        },
      },
    });
    const child = spawn(
      installedCli,
      ['connect', '/vault/note.md', '--name', 'OpenAI', '--json'],
      { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout
      .setEncoding('utf8')
      .on('data', (text: string) => (stdout += text));
    child.stderr
      .setEncoding('utf8')
      .on('data', (text: string) => (stderr += text));
    const code = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (status) => resolve(status ?? -1));
    });
    assert.equal(code, 0, stderr);
    const response = JSON.parse(stdout);
    assert.equal(response.ok, true);
    assert.equal(response.type, 'connected');
    assert.equal(response.name, 'OpenAI');
    assert.doesNotMatch(stdout, /token|secret/i);

    const stream = spawn(
      installedCli,
      ['stream', 'packaged-session', '--stdin'],
      {
        cwd: scratch,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let streamOut = '';
    let streamError = '';
    stream.stdout
      .setEncoding('utf8')
      .on('data', (text: string) => (streamOut += text));
    stream.stderr
      .setEncoding('utf8')
      .on('data', (text: string) => (streamError += text));
    stream.stdin.end('bundled stream ✓');
    const streamCode = await new Promise<number>((resolve, reject) => {
      stream.once('error', reject);
      stream.once('exit', (status) => resolve(status ?? -1));
    });
    assert.equal(streamCode, 0, streamError);
    assert.match(streamOut, /"ok":true/);
    assert.ok(
      requests.some(
        (request) =>
          request.type === 'append' && request.text === 'bundled stream ✓',
      ),
    );
    assert.ok(requests.some((request) => request.type === 'finish'));
  } finally {
    await endpoint?.close();
    await rm(scratch, { recursive: true, force: true });
  }
});

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

test('CLI endpoint discovery follows each platform app-data path', async () => {
  const home = await mkdtemp(
    path.join(os.tmpdir(), 'storm-cli-platform-home-'),
  );
  try {
    const cases = [
      ['darwin', path.join(home, 'Library', 'Application Support', 'storm')],
      ['win32', path.join(home, 'AppData', 'Roaming', 'storm')],
      ['linux', path.join(home, '.config', 'storm')],
    ] as const;
    for (const [platform, directory] of cases) {
      const metadata = path.join(directory, 'storm-agent.json');
      await mkdir(directory, { recursive: true });
      await writeFile(metadata, '{}', { mode: 0o600 });
      await chmod(metadata, 0o600);
      assert.equal(await discoverEndpoint(undefined, home, platform), metadata);
      await rm(metadata);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('CLI discovers installed app metadata and rejects ambiguous profile discovery', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'storm-cli-home-'));
  const appData = path.join(home, 'Library', 'Application Support', 'Storm');
  await mkdir(appData, { recursive: true });
  const requests: any[] = [];
  const endpoint = await startAgentEndpoint({
    userDataPath: appData,
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
    const output: string[] = [];
    const firstErrors: string[] = [];
    assert.equal(
      await runCli(['status'], {
        home,
        stdout: (text) => output.push(text),
        stderr: (text) => firstErrors.push(text),
      }),
      0,
      firstErrors.join(''),
    );
    assert.equal(requests[0]?.type, 'status');
    assert.match(output.join(''), /"ok":true/);

    const legacy = path.join(home, '.storm', 'storm-agent.json');
    await mkdir(path.dirname(legacy), { recursive: true });
    await writeFile(legacy, await readFile(endpoint.metadataPath), {
      mode: 0o600,
    });
    await chmod(legacy, 0o600);
    const errors: string[] = [];
    assert.equal(
      await runCli(['status'], {
        home,
        stdout: () => {},
        stderr: (text) => errors.push(text),
      }),
      1,
    );
    assert.match(errors.join(''), /Multiple Storm endpoint profiles/);
  } finally {
    await endpoint.close();
    await rm(home, { recursive: true, force: true });
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
  assert.match(content, /storm --help/);
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
