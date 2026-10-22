import { test } from 'node:test';
import { PassThrough, Readable } from 'node:stream';
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
import { BoundedStdinReader, discoverEndpoint, runCli } from './storm';
import { assertNativeTarget, buildCliBinary } from './buildCli';
import { startAgentEndpoint } from '../src/main/agentEndpoint';
import { AgentBroker } from '../src/main/agentBroker';

test('activity CLI round-trips through the local endpoint and broker lifecycle', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'storm-activity-cli-'));
  const document = { version: 0, revision: 'r1' };
  const broker = new AgentBroker({
    resolveTarget: async (absolutePath) => ({
      absolutePath,
      vaultId: 'test-vault',
      vaultRoot: scratch,
      relativePath: 'note.md',
      content: '',
      diskRevision: document.revision,
    }),
    renderer: {
      dispatch: async (request) => {
        if (request.type === 'snapshot')
          return {
            ok: true,
            content: '',
            documentVersion: document.version,
            diskRevision: document.revision,
          };
        if (request.type === 'activity')
          return {
            ok: true,
            documentVersion: document.version,
            diskRevision: document.revision,
          };
        if (request.type === 'append')
          return {
            ok: true,
            documentVersion: ++document.version,
            diskRevision: document.revision,
          };
        if (request.type === 'finish')
          return {
            ok: true,
            documentVersion: document.version,
            diskRevision: document.revision,
          };
        return {
          ok: false,
          code: 'INVALID_REQUEST',
          message: 'Unexpected request',
        };
      },
    },
  });
  const endpoint = await startAgentEndpoint({
    broker,
    userDataPath: path.join(scratch, 'profile'),
  });
  const invoke = async (args: string[]) => {
    let output = '';
    let error = '';
    const code = await runCli(['--endpoint', endpoint.metadataPath, ...args], {
      home: scratch,
      stdout: (text) => {
        output += text;
      },
      stderr: (text) => {
        error += text;
      },
    });
    assert.equal(code, 0, error);
    return JSON.parse(output);
  };
  try {
    const connected = await invoke(['connect', '/vault/note.md', '--json']);
    const sessionId = connected.session.sessionId;
    assert.equal(connected.session.state, 'connected');
    const thinking = await invoke(['activity', sessionId, 'thinking']);
    assert.equal(thinking.session.activity, 'thinking');
    const drafting = await invoke(['activity', sessionId, 'drafting']);
    assert.equal(drafting.session.activity, 'drafting');
    await invoke(['activity', sessionId, 'idle']);
    const idle = await invoke(['status', sessionId, '--json']);
    assert.equal(idle.sessions[0].state, 'connected');
    assert.equal(idle.sessions[0].activity, undefined);
    await invoke(['activity', sessionId, 'thinking']);
    const finished = await invoke(['finish', sessionId]);
    assert.equal(finished.session.state, 'finished');
    assert.equal(finished.session.activity, undefined);
    let staleError = '';
    const staleCode = await runCli(
      ['--endpoint', endpoint.metadataPath, 'activity', sessionId, 'drafting'],
      {
        home: scratch,
        stderr: (text) => {
          staleError += text;
        },
      },
    );
    assert.equal(staleCode, 1);
    assert.match(staleError, /SESSION_CLOSED/);
  } finally {
    await endpoint.close();
    await rm(scratch, { recursive: true, force: true });
  }
});

test('bounded stdin reader retains all bytes while its consumer pauses', async () => {
  const stream = new PassThrough();
  const reader = new BoundedStdinReader(stream);
  const first = reader.next();
  stream.write(Buffer.from('first'));
  assert.equal((await first).value?.toString(), 'first');

  const tail = Buffer.from('remaining tail ✓');
  stream.write(tail);
  stream.end();
  const chunks: Buffer[] = [];
  while (true) {
    const next = await reader.next();
    if (next.done) break;
    chunks.push(next.value);
  }
  assert.deepEqual(Buffer.concat(chunks), tail);
  reader.close();
});

test('bounded stdin reader retains a UTF-8 character split across chunks', async () => {
  const stream = new PassThrough();
  const reader = new BoundedStdinReader(stream);
  const first = reader.next();
  stream.write(Buffer.from([0xe2, 0x82]));
  const left = await first;
  const second = reader.next();
  stream.end(Buffer.from([0xac]));
  const right = await second;
  assert.deepEqual(
    [left.value, right.value].map((chunk) => chunk?.[0]),
    [0xe2, 0xac],
  );
  reader.close();
});

test('bounded stdin reader propagates stream errors', async () => {
  const stream = new PassThrough();
  const reader = new BoundedStdinReader(stream);
  const failure = new Error('input failed');
  const pending = reader.next();
  stream.destroy(failure);
  await assert.rejects(pending, failure);
  reader.close();
});

test('bounded stdin reader pauses at its high-water mark and resumes below low-water mark', async () => {
  const stream = new PassThrough();
  const reader = new BoundedStdinReader(stream);
  const pause = stream.pause.bind(stream);
  const resume = stream.resume.bind(stream);
  let pauses = 0;
  let resumes = 0;
  stream.pause = () => {
    pauses++;
    return pause();
  };
  stream.resume = () => {
    resumes++;
    return resume();
  };
  const queued = Buffer.alloc(1024 * 1024);
  stream.write(queued);
  assert.ok(pauses > 0);
  const chunk = await reader.next();
  assert.equal(chunk.value?.length, queued.length);
  assert.ok(resumes > 0);
  stream.end();
  assert.equal((await reader.next()).done, true);
  reader.close();
});

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

test('CLI compiler starts under Node 24 without misidentifying Node as Bun', async () => {
  const scratch = await mkdtemp(
    path.join(os.tmpdir(), 'storm-node-cli-build-'),
  );
  const modulePath = path.join(scratch, 'buildCli.mjs');
  const root = path.join(scratch, 'output');
  const sourceRoot = process.cwd();
  const nodeDirectory = process.env.PATH?.split(path.delimiter).find(
    (directory) => existsSync(path.join(directory, 'node')),
  );
  assert.ok(nodeDirectory, 'Node must be available through PATH');
  try {
    const compile = spawnSync(
      'bun',
      [
        '-e',
        `import ts from 'typescript'; import { readFileSync, writeFileSync } from 'node:fs'; const source = readFileSync(${JSON.stringify(path.join(sourceRoot, 'scripts', 'buildCli.ts'))}, 'utf8'); const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }); writeFileSync(${JSON.stringify(modulePath)}, output.outputText);`,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(compile.status, 0, compile.stderr);

    const invoke = spawnSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `import { buildCliBinary } from ${JSON.stringify(new URL(`file://${modulePath}`).href)};\nawait buildCliBinary(process.platform, process.arch, { root: ${JSON.stringify(root)}, sourceRoot: ${JSON.stringify(sourceRoot)} });`,
      ],
      {
        cwd: scratch,
        encoding: 'utf8',
        env: {
          PATH: `${nodeDirectory}${path.delimiter}${path.dirname(process.execPath)}`,
        },
      },
    );
    assert.equal(invoke.status, 0, invoke.stderr);
    const runtimePath = path.join(root, 'build', 'cli', 'runtime', 'bun');
    assert.ok(existsSync(runtimePath));
    assert.notEqual(path.basename(runtimePath), 'node');
    const runtimeVersion = spawnSync(runtimePath, ['--version'], {
      encoding: 'utf8',
    });
    assert.equal(runtimeVersion.status, 0, runtimeVersion.stderr);
    assert.match(runtimeVersion.stdout, /1\.3\.12/);

    const help = spawnSync(
      path.join(root, 'build', 'cli', 'storm'),
      ['--help'],
      {
        cwd: scratch,
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin' },
      },
    );
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage:/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
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

    for (const args of [
      [],
      ['--help'],
      ['connect', '--help'],
      ['activity', '--help'],
    ]) {
      const result = run(args);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Usage:/);
      assert.match(result.stdout, /storm/);
      assert.doesNotMatch(result.stdout, /bun scripts\/storm\.ts/);
      assert.doesNotMatch(
        result.stdout,
        /there is not yet an installed storm executable/i,
      );
      if (args.length === 0 || args[0] === '--help') {
        assert.match(result.stdout, /Application Support\/Storm/);
        assert.match(result.stdout, /REQUIRED agent workflow guidance/);
        assert.match(result.stdout, /best-effort UI telemetry/);
        assert.match(result.stdout, /do not block valid work/);
      }
      if (args[0] === 'activity') {
        assert.match(result.stdout, /REQUIRED workflow guidance/);
        assert.match(result.stdout, /best-effort telemetry/);
        assert.match(
          result.stdout,
          /Closed-session responses require reconnect/,
        );
      }
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

    const runActivity = async (phase: string) => {
      const child = spawn(
        installedCli,
        ['activity', 'packaged-session', phase],
        {
          cwd: scratch,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      let error = '';
      child.stdout
        .setEncoding('utf8')
        .on('data', (text: string) => (output += text));
      child.stderr
        .setEncoding('utf8')
        .on('data', (text: string) => (error += text));
      const code = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (status) => resolve(status ?? -1));
      });
      assert.equal(code, 0, error);
      return output;
    };
    assert.match(await runActivity('thinking'), /"ok":true/);
    assert.ok(
      requests.some(
        (request) =>
          request.type === 'activity' &&
          request.sessionId === 'packaged-session' &&
          request.activity === 'thinking',
      ),
    );
    assert.match(await runActivity('idle'), /"ok":true/);
    assert.ok(
      requests.some(
        (request) => request.type === 'activity' && request.activity === null,
      ),
    );
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
    assert.doesNotMatch(
      result.stdout,
      /there is not yet an installed storm executable/i,
    );
    if (args.length === 0 || args[0] === '--help') {
      assert.match(
        result.stdout,
        /discovers metadata in the platform's app-data/,
      );
      assert.match(
        result.stdout,
        /packaged launcher includes its own Bun runtime/,
      );
      assert.match(result.stdout, /Application Support\/Storm/);
      assert.match(result.stdout, /inspect\ncontent and live version/);
      assert.match(result.stdout, /guarded patch for focused corrections/);
      assert.match(result.stdout, /Choose the teaching depth, structure/);
      assert.match(result.stdout, /docs\/AGENT-AUTHORING\.md/);
      assert.match(result.stdout, /append-only write requirement/);
    }
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

test('inspect sends a read-only request and prints the live-or-disk JSON response', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'storm-cli-inspect-'));
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
          type: 'inspected',
          open: true,
          source: 'live',
          content: 'unsaved editor text',
          documentVersion: 7,
          diskRevision: 'disk-r6',
          saveState: 'pending',
        };
      },
    },
  });
  try {
    const output: string[] = [];
    assert.equal(
      await runCli(
        [
          '--endpoint',
          endpoint.metadataPath,
          'inspect',
          '/vault/note.md',
          '--json',
        ],
        { stdout: (text) => output.push(text), stderr: () => {} },
      ),
      0,
    );
    assert.equal(requests.length, 1);
    assert.deepEqual(
      { ...requests[0], requestId: undefined },
      {
        protocol: 1,
        requestId: undefined,
        type: 'inspect',
        absolutePath: '/vault/note.md',
      },
    );
    assert.equal(JSON.parse(output.join('')).content, 'unsaved editor text');
    assert.match(output.join(''), /"documentVersion":7/);
    assert.match(output.join(''), /"saveState":"pending"/);
  } finally {
    await endpoint.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('replace and patch CLI requests forward plans, versions, previews, and saved confirmations', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'storm-cli-edit-'));
  const requests: any[] = [];
  const endpoint = await startAgentEndpoint({
    userDataPath: directory,
    broker: {
      async handle(value: any) {
        requests.push(value);
        const preview = value.type === 'edit-preview';
        return {
          protocol: 1,
          requestId: value.requestId,
          ok: true,
          type: preview ? 'preview' : 'edited',
          operationId: value.operationId,
          content: preview ? 'preview text' : 'saved text',
          changed: true,
          documentVersion: 8,
          diskRevision: 'rev-8',
          ...(!preview ? { saveState: 'saved' } : {}),
        };
      },
    },
  });
  try {
    const invoke = async (args: string[], text: string) => {
      const output: string[] = [];
      const errors: string[] = [];
      const code = await runCli(
        ['--endpoint', endpoint.metadataPath, ...args],
        {
          stdin: Readable.from([text]),
          stdout: (value) => output.push(value),
          stderr: (value) => errors.push(value),
        },
      );
      assert.equal(code, 0, errors.join(''));
      return JSON.parse(output.join(''));
    };
    assert.equal(
      (
        await invoke(
          [
            'replace',
            'session-a',
            '--expected-version',
            '7',
            '--stdin',
            '--json',
          ],
          'whole note',
        )
      ).saveState,
      'saved',
    );
    assert.equal(
      (
        await invoke(
          [
            'replace',
            'session-a',
            '--expected-version',
            '8',
            '--stdin',
            '--dry-run',
            '--json',
          ],
          'draft',
        )
      ).type,
      'preview',
    );
    assert.equal(
      (
        await invoke(
          [
            'patch',
            'session-a',
            '--expected-version',
            '8',
            '--stdin',
            '--json',
          ],
          '[{"find":"old","replace":"new"}]',
        )
      ).type,
      'edited',
    );
    assert.equal(
      (
        await invoke(
          [
            'patch',
            'session-a',
            '--expected-version',
            '8',
            '--stdin',
            '--dry-run',
            '--json',
          ],
          '[{"find":"a","replace":"b"}]',
        )
      ).type,
      'preview',
    );
    assert.deepEqual(
      requests.map(({ type, sessionId, expectedVersion, plan }) => ({
        type,
        sessionId,
        expectedVersion,
        plan,
      })),
      [
        {
          type: 'edit-apply',
          sessionId: 'session-a',
          expectedVersion: 7,
          plan: { type: 'replace', content: 'whole note' },
        },
        {
          type: 'edit-preview',
          sessionId: 'session-a',
          expectedVersion: 8,
          plan: { type: 'replace', content: 'draft' },
        },
        {
          type: 'edit-apply',
          sessionId: 'session-a',
          expectedVersion: 8,
          plan: {
            type: 'replaceText',
            replacements: [{ find: 'old', replace: 'new' }],
          },
        },
        {
          type: 'edit-preview',
          sessionId: 'session-a',
          expectedVersion: 8,
          plan: {
            type: 'replaceText',
            replacements: [{ find: 'a', replace: 'b' }],
          },
        },
      ],
    );
  } finally {
    await endpoint.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('replace and patch report broker save failures as failures, not saved output', async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'storm-cli-edit-fail-'),
  );
  const endpoint = await startAgentEndpoint({
    userDataPath: directory,
    broker: {
      async handle(value: any) {
        return {
          protocol: 1,
          requestId: value.requestId,
          ok: false,
          error: { code: 'SAVE_FAILED', message: 'save failed' },
        };
      },
    },
  });
  try {
    for (const [command, text] of [
      ['replace', 'new'],
      ['patch', '[]'],
    ] as const) {
      const errors: string[] = [];
      const code = await runCli(
        [
          '--endpoint',
          endpoint.metadataPath,
          command,
          'session-a',
          '--expected-version',
          '1',
          '--stdin',
          '--json',
        ],
        {
          stdin: Readable.from([text]),
          stdout: () => {},
          stderr: (value) => errors.push(value),
        },
      );
      assert.equal(code, 1);
      assert.match(errors.join(''), /SAVE_FAILED/);
      assert.doesNotMatch(errors.join(''), /"saveState":"saved"/);
    }
  } finally {
    await endpoint.close();
    await rm(directory, { recursive: true, force: true });
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

test('tool-neutral Storm skill has portable frontmatter and resolves the CLI relatively', async () => {
  const { readFile } = await import('node:fs/promises');
  const skillPath = new URL('../skills/storm/SKILL.md', import.meta.url);
  const content = await readFile(skillPath, 'utf8');
  assert.match(content, /^---\nname: storm\ndescription: .+\n---/);
  assert.match(content, /Read `storm --help`/);
  assert.match(content, /agent authoring guide/);
  assert.match(content, /Use guarded `patch` for focused corrections/);
  assert.match(
    content,
    /complete source review and one coordinated append-only write/,
  );
  assert.match(content, /Prefer the official installed `storm` CLI/);
  assert.match(
    content,
    /for source development with the development app, use `bun scripts\/storm\.ts`/,
  );
  assert.ok(existsSync(new URL('../../scripts/storm.ts', skillPath)));
  const authoringGuide = await readFile(
    new URL('../docs/AGENT-AUTHORING.md', import.meta.url),
    'utf8',
  );
  assert.match(
    authoringGuide,
    /atomicity protects the write but does not prescribe its scope/,
  );
  assert.match(authoringGuide, /## Write for understanding/);
  assert.match(authoringGuide, /```mermaid/);
  assert.match(authoringGuide, /inline math or `\$\$\.\.\.\$\$` display math/);
  assert.match(authoringGuide, /raw HTML is not rendered/);
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
