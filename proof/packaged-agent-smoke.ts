// Exercises the packaged app and its own bundled runtime/CLI in a disposable profile.
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = await mkdtemp('/tmp/storm-agent-smoke-');
const profile = join(root, 'profile');
await mkdir(profile);
const app = resolve('out/storm-darwin-arm64/Storm.app');
const cli = join(app, 'Contents/Resources/cli/storm');
const timestamp = new Date().toISOString();
const text = 'café 🧠: explain speed using distance and time.';
const session = {
  id: 'packaged-recovery',
  agentToken: 'synthetic-fixture',
  revision: 4,
  eventCursor: 4,
  status: 'waiting-agent',
  transcript: [{ id: 'm4', role: 'learner', text, createdAt: timestamp }],
  currentQuestion: null,
  freeChatDraft: '',
  pendingLearnerCursor: 4,
  respondedThroughCursor: 3,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const feedback = {
  ...session,
  id: 'packaged-feedback',
  transcript: [],
  currentQuestion: {
    id: 'q1',
    kind: 'multiple-choice',
    prompt: 'Which answer?',
    choices: [{ id: 'a', text: 'A' }],
    status: 'feedback',
    selectedChoiceId: 'a',
    reasoningDraft: '',
    feedback: 'Correct.',
    verdict: 'correct',
  },
};
await writeFile(
  join(profile, 'cli-setup.json'),
  JSON.stringify({ version: 1, choice: 'declined' }),
);
await writeFile(
  join(profile, 'quiz-sessions.json'),
  JSON.stringify({
    version: 1,
    sessions: [session, feedback],
    events: {
      [session.id]: [
        {
          cursor: 4,
          revision: 4,
          type: 'message',
          data: { text },
          createdAt: timestamp,
        },
      ],
      [feedback.id]: [],
    },
    idempotency: {},
  }),
);
const child = spawn(
  join(app, 'Contents/MacOS/Storm'),
  [`--user-data-dir=${profile}`],
  { stdio: 'ignore' },
);
const endpoint = join(profile, 'storm-agent.json');
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function command(args: string[], token?: string, payload?: unknown) {
  return await new Promise<any>((resolve, reject) => {
    const command = spawn(cli, ['--endpoint', endpoint, 'quiz', ...args], {
      env: { ...process.env, ...(token ? { STORM_QUIZ_TOKEN: token } : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    command.stdout.setEncoding('utf8').on('data', (part) => {
      stdout += part;
    });
    command.stderr.setEncoding('utf8').on('data', (part) => {
      stderr += part;
    });
    command.on('error', reject);
    command.on('close', (code) => {
      if (code)
        return reject(new Error(`Bundled CLI failed (${code}): ${stderr}`));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error('Invalid bundled CLI JSON'));
      }
    });
    command.stdin.end(payload ? JSON.stringify(payload) + '\n' : undefined);
  });
}
try {
  for (let attempt = 0; ; attempt++) {
    try {
      await readFile(endpoint);
      break;
    } catch {
      if (attempt > 200 || child.exitCode !== null)
        throw new Error('Packaged app did not expose its isolated endpoint.');
      await pause(50);
    }
  }
  const attached = (await command(['attach', session.id, '--compact'])).result
    .value;
  const token = attached.agentToken;
  assert.equal(attached.snapshot.recovery.pendingAction, 'reply');
  assert.equal(attached.snapshot.recovery.history.entries[0].text, text);
  const result = (
    await command(['request', session.id], token, {
      type: 'agent-message',
      expectedRevision: attached.snapshot.session.revision,
      handledThroughCursor: attached.snapshot.session.eventCursor,
      idempotencyKey: 'smoke-reply',
      text: 'Speed is distance divided by elapsed time. Units such as km/h express that relationship.',
    })
  ).result;
  assert.equal(result.ok, true);
  const revision = result.value.revision;
  const chunk = (
    await command(
      [
        'context',
        session.id,
        '--section',
        'history',
        '--before',
        '1',
        '--offset',
        '0',
      ],
      token,
    )
  ).result.value;
  assert.equal(JSON.parse(chunk.text).text, text);
  const status = await command(['status', session.id, '--compact'], token);
  const idle = await command(
    [
      'wait',
      session.id,
      '--after',
      String(status.snapshot.session.eventCursor),
      '--timeout',
      '0',
      '--compact',
    ],
    token,
  );
  assert.equal(idle.timedOut, true);
  assert.deepEqual(idle.snapshot.session.transcript, []);
  assert.deepEqual(idle.snapshot.events, []);
  assert.equal(idle.snapshot.recovery, undefined);
  const other = (await command(['attach', feedback.id, '--compact'])).result
    .value;
  const rejected = (
    await command(['request', feedback.id], other.agentToken, {
      type: 'pose-question',
      expectedRevision: other.snapshot.session.revision,
      idempotencyKey: 'must-wait',
      question: 'Another question?',
      choices: [{ id: 'b', text: 'B' }],
    })
  ).result;
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'invalid-state');
  await command(['detach', feedback.id], other.agentToken);
  await command(['detach', session.id], token);
  const saved = JSON.parse(
    await readFile(join(profile, 'quiz-sessions.json'), 'utf8'),
  );
  assert.equal(
    saved.sessions.find((item: any) => item.id === session.id).transcript[0]
      .text,
    text,
  );
  process.stdout.write(
    JSON.stringify(
      {
        app,
        platform: process.platform,
        arch: process.arch,
        recoveredUnicode: true,
        durableReplyRevision: revision,
        continueGate: 'enforced',
        contextChunks: 'verified',
        idleResponseBytes: Buffer.byteLength(JSON.stringify(idle)),
        ownedSessionsDetached: true,
        isolatedProfileRemoved: true,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  child.kill('SIGTERM');
  for (let count = 0; child.exitCode === null && count < 100; count++)
    await pause(20);
  if (child.exitCode === null && child.signalCode === null)
    child.kill('SIGKILL');
  await rm(root, { recursive: true, force: true });
}
