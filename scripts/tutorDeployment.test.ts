import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { installTutor } from './installTutor';
import {
  checkTutorCapabilities,
  configureTutorCli,
  piAgentDir,
  resolveTutorCli,
  TUTOR_SOURCES,
  tutorDoctor,
  tutorRepo,
} from './tutorDeployment';
import {
  QUIZ_INTEGRATION_VERSION,
  QUIZ_REQUIRED_FEATURES,
  quizIntegrationCompatibilityError,
} from '../src/shared/quizIntegrationVersion';

function temporary(run: (dir: string) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), 'storm-tutor-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function put(file: string, contents: string, executable = false) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
  if (executable) chmodSync(file, 0o755);
  return file;
}
function fakeRepo(dir: string) {
  const repo = path.join(dir, 'maintained checkout');
  for (const source of TUTOR_SOURCES)
    put(path.join(repo, source), `// ${source}\n`);
  put(
    path.join(repo, 'extensions/storm-quiz.ts'),
    'export default function () { return "current-source"; }\n',
  );
  put(
    path.join(repo, 'scripts/tutorDeployment.ts'),
    `export {configureTutorCli} from ${JSON.stringify(path.join(tutorRepo, 'scripts/tutorDeployment.ts'))};\n`,
  );
  return repo;
}
function fakeCli(dir: string) {
  return put(
    path.join(dir, 'fake CLI.js'),
    `
import fs from 'node:fs';
const args = process.argv.slice(2);
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({args, endpoint:process.env.STORM_ENDPOINT})+'\\n');
if (process.env.FAKE_MODE === 'exit') { console.error('SECRET_TOKEN'); process.exit(1); }
if (process.env.FAKE_MODE === 'invalid') { console.log('not json SECRET_TOKEN'); process.exit(0); }
const quiz = { integrationVersion: 2, features: ['learning','support-update','answer-confidence'] };
if (process.env.FAKE_MODE === 'missing') quiz.features = ['learning','answer-confidence'];
if (process.env.FAKE_MODE === 'version') quiz.integrationVersion = 1;
console.log(JSON.stringify({ok:true,result:{ok:true,value: args.includes('quiz') ? quiz : {schemaVersion: process.env.FAKE_MODE === 'study' ? 0 : 1}}}));
`,
  );
}
function cliConfig(dir: string) {
  return { executable: process.execPath, args: [fakeCli(dir)] };
}

test('quiz negotiation requires explicit contract and every learning feature, independent of app version', () => {
  const good = {
    integrationVersion: QUIZ_INTEGRATION_VERSION,
    features: [...QUIZ_REQUIRED_FEATURES, 'extra'],
  };
  assert.equal(quizIntegrationCompatibilityError(good), null);
  assert.match(
    quizIntegrationCompatibilityError({ ...good, integrationVersion: 1 })!,
    /incompatible/,
  );
  assert.match(
    quizIntegrationCompatibilityError({
      ...good,
      features: ['learning', 'answer-confidence'],
    })!,
    /support-update/,
  );
  assert.match(
    quizIntegrationCompatibilityError({ version: '1.0.0', schemaVersion: 1 })!,
    /incompatible/,
  );
  for (const malformed of [
    null,
    false,
    '2',
    [],
    { integrationVersion: 2, features: {} },
  ])
    assert.equal(typeof quizIntegrationCompatibilityError(malformed), 'string');
});

test('default CLI prefers executable local bundle then Applications, with actionable missing-build error', () =>
  temporary((dir) => {
    const apps = path.join(dir, 'Applications');
    const installed = put(
      path.join(apps, 'Storm.app/Contents/Resources/cli/storm'),
      '',
      true,
    );
    assert.equal(
      resolveTutorCli(dir, {}, apps, 'darwin', 'arm64').executable,
      installed,
    );
    const local = put(
      path.join(
        dir,
        'out/Storm-darwin-arm64/Storm.app/Contents/Resources/cli/storm',
      ),
      '',
      true,
    );
    assert.equal(
      resolveTutorCli(dir, {}, apps, 'darwin', 'arm64').executable,
      local,
    );
    chmodSync(local, 0o644);
    assert.equal(
      resolveTutorCli(dir, {}, apps, 'darwin', 'arm64').executable,
      installed,
    );
    rmSync(installed);
    assert.throws(
      () => resolveTutorCli(dir, {}, apps, 'darwin', 'arm64'),
      /pnpm package.*STORM_TUTOR_CLI/,
    );
  }));

test('CLI and JSON argument overrides survive configuration unchanged, including paths with spaces', () =>
  temporary((dir) => {
    const repo = fakeRepo(dir);
    const args = [
      'a path/with spaces.ts',
      '--endpoint',
      'endpoint with spaces',
      '$(do-not-execute)',
    ];
    const env = {
      STORM_QUIZ_CLI: 'custom-runtime',
      STORM_QUIZ_CLI_ARGS: JSON.stringify(args),
      STORM_ENDPOINT: 'chosen endpoint',
      STORM_TUTOR_DIAGNOSTICS: '',
    };
    const config = configureTutorCli(repo, env);
    assert.deepEqual(config, { executable: 'custom-runtime', args });
    assert.equal(env.STORM_ENDPOINT, 'chosen endpoint');
    assert.deepEqual(JSON.parse(env.STORM_QUIZ_CLI_ARGS), args);
    assert.equal(JSON.parse(env.STORM_TUTOR_DIAGNOSTICS).integrationVersion, 2);
    assert.equal(
      resolveTutorCli(repo, { ...env, STORM_TUTOR_CLI: 'tutor-override' })
        .executable,
      'tutor-override',
    );
    for (const invalid of ['{', '{}', '[2]', 'null'])
      assert.throws(
        () =>
          resolveTutorCli(repo, {
            STORM_QUIZ_CLI: 'bun',
            STORM_QUIZ_CLI_ARGS: invalid,
          }),
        /JSON string array/,
      );
    assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: dir }), dir);
  }));

test('installer backs up old wrapper, preserves settings, is idempotent, and records extension/prompt hashes', () =>
  temporary((dir) => {
    const repo = fakeRepo(dir),
      agentDir = path.join(dir, 'fake pi home');
    const target = put(
      path.join(agentDir, 'extensions/storm-quiz.ts'),
      "import stale from '../storm-integration/old.ts';\nexport default stale;\n",
    );
    const settings = put(
      path.join(agentDir, 'settings.json'),
      '{"defaultModel":"unchanged"}',
    );
    const old = readFileSync(target, 'utf8');
    const result = installTutor({ repo, agentDir });
    assert.equal(result.changed, true);
    assert.equal(readFileSync(result.backup!, 'utf8'), old);
    assert.equal(
      readFileSync(settings, 'utf8'),
      '{"defaultModel":"unchanged"}',
    );
    assert.equal(existsSync(path.join(agentDir, 'storm-integration')), false);
    const wrapper = readFileSync(target, 'utf8');
    assert.ok(
      wrapper.includes(
        JSON.stringify(path.join(repo, 'extensions/storm-quiz.ts')),
      ),
    );
    assert.ok(!wrapper.includes('storm-integration'));
    assert.match(result.hashes['skills/storm/TUTOR.md'], /^[a-f0-9]{64}$/);
    const before = statSync(target).mtimeMs;
    const repeated = installTutor({ repo, agentDir });
    assert.equal(repeated.changed, false);
    assert.equal(repeated.manifestChanged, false);
    assert.equal(repeated.backup, null);
    assert.equal(statSync(target).mtimeMs, before);
    assert.equal(readdirSync(path.dirname(target)).length, 2);
    put(path.join(repo, 'skills/storm/TUTOR.md'), 'updated teaching guidance');
    const refreshed = installTutor({ repo, agentDir });
    assert.equal(refreshed.changed, false);
    assert.equal(refreshed.manifestChanged, true);
    assert.notEqual(
      refreshed.hashes['skills/storm/TUTOR.md'],
      result.hashes['skills/storm/TUTOR.md'],
    );
  }));

test('installed wrapper executes maintained source, preserves overrides, and reflects source updates after restart', () =>
  temporary((dir) => {
    const repo = fakeRepo(dir),
      agentDir = path.join(dir, 'pi');
    const installed = installTutor({ repo, agentDir });
    const runner = put(
      path.join(dir, 'runner.ts'),
      `import extension from ${JSON.stringify(installed.target)}; console.log(extension({})); console.log(process.env.STORM_QUIZ_CLI); console.log(process.env.STORM_QUIZ_CLI_ARGS);`,
    );
    const env = {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      STORM_TUTOR_CLI: '',
      STORM_QUIZ_CLI: 'my-explicit-cli',
      STORM_QUIZ_CLI_ARGS: '["keep these args"]',
    };
    const run = () =>
      execFileSync(process.execPath, [runner], { env, encoding: 'utf8' });
    assert.equal(
      run().trim(),
      'current-source\nmy-explicit-cli\n["keep these args"]',
    );
    put(
      path.join(repo, 'extensions/storm-quiz.ts'),
      'export default function () { return "updated-source"; }',
    );
    assert.match(run(), /^updated-source/);
  }));

test('installer refuses incomplete source without creating a Pi directory', () =>
  temporary((dir) => {
    const agentDir = path.join(dir, 'untouched');
    assert.throws(
      () => installTutor({ repo: path.join(dir, 'missing'), agentDir }),
      /ENOENT/,
    );
    assert.equal(existsSync(agentDir), false);
  }));

test('capability preflight uses only read-only commands and preserves endpoint/argv, without a shell', () =>
  temporary((dir) => {
    const config = cliConfig(dir),
      log = path.join(dir, 'requests');
    config.args.push('--endpoint', 'endpoint with spaces', '$(literal)');
    const result = checkTutorCapabilities(config, {
      ...process.env,
      FAKE_LOG: log,
      STORM_ENDPOINT: 'selected endpoint',
    });
    assert.equal(result.quiz.integrationVersion, 2);
    assert.equal(result.study.schemaVersion, 1);
    const requests = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      requests.map((request) => request.args),
      [
        [
          '--endpoint',
          'endpoint with spaces',
          '$(literal)',
          'quiz',
          'capabilities',
        ],
        [
          '--endpoint',
          'endpoint with spaces',
          '$(literal)',
          'study',
          'capabilities',
        ],
      ],
    );
    assert.ok(
      requests.every((request) => request.endpoint === 'selected endpoint'),
    );
  }));

test('capability preflight rejects study-only/old/malformed/failing clients and never exposes their stderr', () =>
  temporary((dir) => {
    const config = cliConfig(dir);
    for (const mode of ['missing', 'version', 'study', 'exit', 'invalid']) {
      assert.throws(
        () =>
          checkTutorCapabilities(config, { ...process.env, FAKE_MODE: mode }),
        (error: Error) => {
          assert.ok(!error.message.includes('SECRET_TOKEN'));
          return true;
        },
      );
    }
  }));

test('doctor reports install and current hashes plus read-only capability diagnostics, omitting private argv', () =>
  temporary((dir) => {
    const repo = fakeRepo(dir),
      agentDir = path.join(dir, 'pi');
    installTutor({ repo, agentDir });
    const config = cliConfig(dir);
    const result = tutorDoctor(repo, {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      STORM_TUTOR_CLI: '',
      STORM_QUIZ_CLI: config.executable,
      STORM_QUIZ_CLI_ARGS: JSON.stringify([...config.args, 'PRIVATE_ARG']),
    });
    assert.equal(result.integrationVersion, 2);
    assert.match(result.wrapperHash!, /^[a-f0-9]{64}$/);
    assert.ok(result.installed);
    assert.match(result.restart, /Restart Pi/);
    assert.ok(!JSON.stringify(result).includes('PRIVATE_ARG'));
  }));

test('shell launcher blocks incompatible app before starting Pi or creating session directory', () =>
  temporary((dir) => {
    const config = cliConfig(dir),
      sessions = path.join(dir, 'sessions');
    const result = spawnSync(
      'sh',
      [path.join(tutorRepo, 'scripts/startTutor.sh')],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: path.join(dir, 'pi'),
          STORM_TUTOR_CLI: config.executable,
          STORM_QUIZ_CLI_ARGS: JSON.stringify(config.args),
          STORM_TUTOR_SESSION_DIR: sessions,
          FAKE_MODE: 'missing',
        },
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /support-update/);
    assert.match(result.stderr, /Tutor was not started/);
    assert.equal(existsSync(sessions), false);
  }));

test('shell launcher starts only fake Pi with maintained extension/prompt, overrides, and forwarded options', () =>
  temporary((dir) => {
    const config = cliConfig(dir),
      bin = path.join(dir, 'bin'),
      output = path.join(dir, 'pi-call.json');
    put(
      path.join(bin, 'pi'),
      `#!${process.execPath}\nimport fs from 'node:fs'; fs.writeFileSync(process.env.FAKE_PI_OUTPUT, JSON.stringify({args:process.argv.slice(2),cli:process.env.STORM_QUIZ_CLI,cliArgs:process.env.STORM_QUIZ_CLI_ARGS,cwd:process.cwd(),diagnostics:JSON.parse(process.env.STORM_TUTOR_DIAGNOSTICS)}));`,
      true,
    );
    const sessions = path.join(dir, 'tutor/sessions');
    const result = spawnSync(
      'sh',
      [
        path.join(tutorRepo, 'scripts/startTutor.sh'),
        '--resume',
        'chosen session',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: path.join(dir, 'pi'),
          PATH: `${bin}:${process.env.PATH}`,
          STORM_TUTOR_CLI: config.executable,
          STORM_QUIZ_CLI_ARGS: JSON.stringify(config.args),
          STORM_TUTOR_SESSION_DIR: sessions,
          FAKE_PI_OUTPUT: output,
          FAKE_MODE: '',
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const called = JSON.parse(readFileSync(output, 'utf8'));
    assert.deepEqual(called.args, [
      '--no-extensions',
      '--extension',
      path.join(tutorRepo, 'extensions/storm-quiz.ts'),
      '--system-prompt',
      path.join(tutorRepo, 'skills/storm/TUTOR.md'),
      '--session-dir',
      sessions,
      '--name',
      'Tutor',
      '--resume',
      'chosen session',
    ]);
    assert.equal(called.cli, config.executable);
    assert.deepEqual(JSON.parse(called.cliArgs), config.args);
    assert.equal(called.cwd, realpathSync(path.dirname(sessions)));
    assert.equal(called.diagnostics.integrationVersion, 2);
  }));

const piLoader = path.join(
  process.env.PI_PACKAGE_ROOT ||
    path.join(
      homedir(),
      '.bun/install/global/node_modules/@earendil-works/pi-coding-agent',
    ),
  'dist/core/extensions/loader.js',
);
test(
  'installed wrapper loads with real Pi loader without starting a listener or CLI',
  { skip: !existsSync(piLoader) },
  () =>
    temporary((dir) => {
      const agentDir = path.join(dir, 'pi');
      const installed = installTutor({ agentDir });
      const config = cliConfig(dir),
        log = path.join(dir, 'cli-calls');
      const runner = put(
        path.join(dir, 'load-wrapper.ts'),
        `
import {pathToFileURL} from 'node:url';
const {loadExtensions} = await import(pathToFileURL(${JSON.stringify(piLoader)}).href);
const result = await loadExtensions([${JSON.stringify(installed.target)}], ${JSON.stringify(tutorRepo)});
console.log(JSON.stringify({errors:result.errors.map(e=>({...e,error:e.error.slice(0,300)})),tools:[...result.extensions[0]?.tools.keys()??[]],diagnostics:!!process.env.STORM_TUTOR_DIAGNOSTICS}));
`,
      );
      const result = JSON.parse(
        execFileSync(process.execPath, [runner], {
          encoding: 'utf8',
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: agentDir,
            STORM_TUTOR_CLI: config.executable,
            STORM_QUIZ_CLI_ARGS: JSON.stringify(config.args),
            FAKE_LOG: log,
          },
        }),
      );
      assert.deepEqual(result.errors, []);
      assert.ok(result.tools.includes('storm_quiz'));
      assert.ok(result.tools.includes('storm_study'));
      assert.equal(result.diagnostics, true);
      assert.equal(existsSync(log), false);
    }),
);

test('doctor preserves source diagnostics when app is incompatible and detects disk drift', () =>
  temporary((dir) => {
    const repo = fakeRepo(dir),
      agentDir = path.join(dir, 'pi');
    const installed = installTutor({ repo, agentDir });
    put(installed.target, 'a manually changed wrapper');
    put(path.join(repo, 'skills/storm/TUTOR.md'), 'changed prompt');
    const config = cliConfig(dir);
    const result = tutorDoctor(repo, {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      STORM_TUTOR_CLI: config.executable,
      STORM_QUIZ_CLI_ARGS: JSON.stringify(config.args),
      FAKE_MODE: 'missing',
    });
    assert.equal(result.compatible, false);
    assert.match(result.capabilityError!, /support-update/);
    assert.equal(result.wrapperMatchesManifest, false);
    assert.equal(result.installedRepoMatchesCheckout, true);
    assert.ok(
      result.sourcesChangedSinceInstall.includes('skills/storm/TUTOR.md'),
    );
    assert.match(result.hashes['extensions/storm-quiz.ts'], /^[a-f0-9]{64}$/);
  }));
