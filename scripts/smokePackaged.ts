import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AgentResponse } from '../src/shared/agentProtocol';

if (process.platform !== 'darwin')
  throw new Error('The packaged smoke check currently supports macOS.');

// A short path keeps the private Unix socket within the platform path limit.
const root = await mkdtemp('/tmp/st-smoke-');
const profile = join(root, 'profile');
let vault = join(root, 'vault');
await mkdir(profile, { mode: 0o700 });
await mkdir(vault);
vault = await realpath(vault);
await writeFile(
  join(profile, 'cli-setup.json'),
  JSON.stringify({ version: 1, choice: 'declined' }),
);
const vaultId = randomUUID();
await writeFile(
  join(profile, 'settings.json'),
  JSON.stringify({
    vaults: [{ id: vaultId, name: 'Smoke vault', path: vault }],
    activeVaultId: vaultId,
    lastVaultPath: vault,
  }),
);
const note = join(vault, 'probe.md');
await writeFile(note, '');
const quizId = randomUUID();
await writeFile(
  join(profile, 'quiz-sessions.json'),
  JSON.stringify({
    version: 1,
    sessions: [
      {
        id: quizId,
        agentToken: 'synthetic-before-attach',
        revision: 0,
        eventCursor: 0,
        scope: {
          vaultId,
          notePath: 'probe.md',
          folderPath: null,
          selectedNotePaths: [],
        },
        status: 'waiting-agent',
        transcript: [],
        currentQuestion: null,
        freeChatDraft: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
    events: { [quizId]: [] },
    idempotency: {},
  }),
);
const bundle = resolve(`out/Storm-darwin-${process.arch}/Storm.app/Contents`);
const child = spawn(
  join(bundle, 'MacOS/Storm'),
  [`--user-data-dir=${profile}`],
  {
    stdio: ['ignore', 'ignore', 'pipe'],
  },
);
let appErrors = '';
child.on('error', (error) => {
  appErrors += String(error);
});
child.stderr.on('data', (chunk) => {
  appErrors += String(chunk);
});
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function run(
  args: string[],
  input?: string,
  token?: string,
): Promise<string> {
  return new Promise((done, reject) => {
    const cli = spawn(
      join(bundle, 'Resources/cli/storm'),
      ['--endpoint', join(profile, 'storm-agent.json'), ...args],
      {
        stdio: 'pipe',
        env: { ...process.env, ...(token ? { STORM_QUIZ_TOKEN: token } : {}) },
      },
    );
    let stdout = '',
      stderr = '';
    const timer = setTimeout(() => {
      cli.kill('SIGKILL');
      reject(new Error(`CLI timed out: ${args[0]}`));
    }, 20_000);
    cli.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    cli.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    cli.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    cli.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) done(stdout);
      else reject(new Error(`CLI ${args[0]} failed (${code}): ${stderr}`));
    });
    cli.stdin.end(input);
  });
}
const json = async (args: string[]) =>
  JSON.parse(await run([...args, '--json'])) as AgentResponse;

try {
  const deadline = Date.now() + 15_000;
  while (true) {
    try {
      await readFile(join(profile, 'storm-agent.json'));
      break;
    } catch {
      /* wait for startup */
    }
    if (child.exitCode !== null || Date.now() > deadline)
      throw new Error(`Packaged app did not start: ${appErrors}`);
    await delay(100);
  }
  let context: AgentResponse | undefined;
  while (!context?.ok) {
    try {
      context = await json(['context']);
    } catch (error) {
      if (Date.now() > deadline)
        throw new Error(
          `Renderer did not become ready: ${String(error)}\n${appErrors}`,
        );
    }
    if (!context) {
      await delay(100);
      continue;
    }
    if (context.ok) break;
    if (Date.now() > deadline)
      throw new Error(`Renderer did not become ready: ${appErrors}`);
    await delay(100);
  }
  assert.ok(context.ok && context.type === 'context');
  assert.ok(
    context.context.registeredVaults.some((entry) => entry.id === vaultId),
  );
  const inspected = await json(['inspect', note]);
  assert.ok(inspected.ok && inspected.type === 'inspected');
  assert.equal(inspected.content, '');
  const connected = await json(['connect', note]);
  assert.ok(connected.ok && connected.type === 'connected');
  const sessionId = connected.session.sessionId;
  const expected = 'Packaged smoke: naïve — exact UTF-8.\n';
  await run(['stream', sessionId, '--stdin'], expected);
  const status = await json(['status', sessionId]);
  assert.ok(status.ok && status.type === 'status');
  assert.equal(status.sessions[0].state, 'finished');
  const verified = await json(['inspect', note]);
  assert.ok(verified.ok && verified.type === 'inspected');
  assert.equal(verified.content, expected);
  const actual = await readFile(note, 'utf8');
  assert.equal(actual, expected);
  const study = async (value: unknown) => {
    const response = JSON.parse(
      await run(['study', '--stdin'], JSON.stringify(value)),
    );
    assert.ok(response.ok && response.type === 'study');
    return response.result.value;
  };
  const studyOpened = await study({
    action: 'open',
    scope: {
      vaultId,
      notePath: 'probe.md',
      folderPath: null,
      selectedNotePaths: [],
    },
  });
  const packet = await study({
    action: 'retrieve',
    studyId: studyOpened.studyId,
    query: 'naïve',
  });
  assert.equal(packet.chunks[0].text, expected);
  const snapshotId = packet.snapshotId;
  const attached = JSON.parse(
    await run(['quiz', 'attach', quizId, '--compact']),
  ).result.value;
  const posed = JSON.parse(
    await run(
      ['quiz', 'request', quizId],
      JSON.stringify({
        type: 'pose-question',
        expectedRevision: attached.snapshot.session.revision,
        kind: 'short-answer',
        question: 'Explain the original source.',
        studyBasis: snapshotId,
      }),
      attached.agentToken,
    ),
  );
  assert.equal(posed.result.value.currentQuestion.studyBasis, snapshotId);
  const replacement = 'Changed source for study freshness.\n';
  const reconnect = await json(['connect', note]);
  assert.ok(reconnect.ok && reconnect.type === 'connected');
  await run(['stream', reconnect.session.sessionId, '--stdin'], replacement);
  const freshness = await study({
    action: 'validate',
    studyId: studyOpened.studyId,
    snapshotId,
  });
  assert.equal(freshness.sources[0].state, 'changed');
  const historical = await study({
    action: 'read',
    studyId: studyOpened.studyId,
    snapshotId,
  });
  assert.equal(historical.chunks[0].text, expected);
  await run(['quiz', 'detach', quizId], undefined, attached.agentToken);
  const reattached = JSON.parse(
    await run(['quiz', 'attach', quizId, '--compact']),
  ).result.value;
  assert.equal(
    reattached.snapshot.session.currentQuestion.studyBasis,
    snapshotId,
  );
  await run(['quiz', 'detach', quizId], undefined, reattached.agentToken);
  // Exercise launch wiring without starting a model or reading Pi credentials.
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(
    join(bin, 'pi'),
    '#!/bin/sh\nprintf "%s\\n" "$STORM_QUIZ_CLI" "$@"\n',
    { mode: 0o700 },
  );
  const launch = spawnSync('sh', [resolve('scripts/startTutor.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      STORM_ENDPOINT: join(profile, 'storm-agent.json'),
      STORM_TUTOR_CLI: join(bundle, 'Resources/cli/storm'),
      STORM_TUTOR_SESSION_DIR: join(root, 'tutor', 'sessions'),
    },
  });
  assert.equal(launch.status, 0, launch.stderr);
  assert.ok(launch.stdout.includes(resolve('extensions/storm-quiz.ts')));
  assert.ok(launch.stdout.includes(resolve('skills/storm/TUTOR.md')));
  console.log(
    JSON.stringify({
      packagedApp: true,
      bundledCli: true,
      isolatedProfile: true,
      context: true,
      inspect: true,
      connect: true,
      stream: true,
      studyContext: true,
      studyChangeDetection: true,
      immutableSourceRead: true,
      questionBasisPersistence: true,
      quizReattach: true,
      tutorLauncherWiring: true,
      finished: true,
      expectedBytes: Buffer.byteLength(expected),
      savedBytes: Buffer.byteLength(actual),
      savedSha256: createHash('sha256').update(actual).digest('hex'),
    }),
  );
} finally {
  child.kill('SIGTERM');
  await delay(250);
  if (child.exitCode === null) child.kill('SIGKILL');
  await rm(root, { recursive: true, force: true });
}
