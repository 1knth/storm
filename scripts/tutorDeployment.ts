import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  QUIZ_INTEGRATION_VERSION,
  QUIZ_REQUIRED_FEATURES,
  quizIntegrationCompatibilityError,
} from '../src/shared/quizIntegrationVersion';

type Environment = Record<string, string | undefined>;
export const tutorRepo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
export const TUTOR_SOURCES = [
  'extensions/storm.ts',
  'extensions/storm-runtime.ts',
  'src/shared/quizProtocol.ts',
  'src/shared/quizAgentContext.ts',
  'src/shared/quizIntegrationVersion.ts',
  'skills/storm/TUTOR.md',
  'scripts/tutorDeployment.ts',
  'scripts/runTutor.ts',
] as const;

export function piAgentDir(env: Environment = process.env): string {
  return path.resolve(
    env.PI_CODING_AGENT_DIR || path.join(homedir(), '.pi/agent'),
  );
}

export function tutorSourceDiagnostics(repo = tutorRepo) {
  const hashes = Object.fromEntries(
    TUTOR_SOURCES.map((file) => [
      file,
      createHash('sha256')
        .update(readFileSync(path.join(repo, file)))
        .digest('hex'),
    ]),
  );
  return {
    integrationVersion: QUIZ_INTEGRATION_VERSION,
    requiredFeatures: [...QUIZ_REQUIRED_FEATURES],
    repo,
    hashes,
  };
}

function executable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Respect explicit executable/argument configuration; no shell evaluation. */
export function resolveTutorCli(
  repo = tutorRepo,
  env: Environment = process.env,
  applicationsDir = '/Applications',
  platform = process.platform,
  arch = process.arch,
): { executable: string; args: string[] } {
  let args: unknown;
  try {
    args = JSON.parse(env.STORM_QUIZ_CLI_ARGS || '[]');
  } catch {
    throw new Error('STORM_QUIZ_CLI_ARGS must be a JSON string array.');
  }
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string'))
    throw new Error('STORM_QUIZ_CLI_ARGS must be a JSON string array.');
  const explicit = env.STORM_TUTOR_CLI || env.STORM_QUIZ_CLI;
  if (explicit) return { executable: explicit, args };
  const candidates = [
    path.join(
      repo,
      `out/Storm-${platform}-${arch}/Storm.app/Contents/Resources/cli/storm`,
    ),
    path.join(applicationsDir, 'Storm.app/Contents/Resources/cli/storm'),
  ];
  const selected = candidates.find(executable);
  if (!selected)
    throw new Error(
      'No bundled Storm CLI found. Run pnpm package, install /Applications/Storm.app, or set STORM_TUTOR_CLI (or STORM_QUIZ_CLI and JSON STORM_QUIZ_CLI_ARGS).',
    );
  return { executable: selected, args };
}

/** Used by the installed wrapper as well as the dedicated Tutor launcher. */
export function configureTutorCli(
  repo = tutorRepo,
  env: Environment = process.env,
) {
  const config = resolveTutorCli(repo, env);
  env.STORM_QUIZ_CLI = config.executable;
  env.STORM_QUIZ_CLI_ARGS = JSON.stringify(config.args);
  env.STORM_TUTOR_DIAGNOSTICS = JSON.stringify(tutorSourceDiagnostics(repo));
  return config;
}

export function checkTutorCapabilities(
  config: { executable: string; args: string[] },
  env: Environment = process.env,
) {
  const read = (command: string[]) => {
    let response: any;
    try {
      response = JSON.parse(
        execFileSync(config.executable, [...config.args, ...command], {
          env,
          encoding: 'utf8',
          timeout: 10_000,
          maxBuffer: 64 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      );
    } catch {
      // CLI stderr/JSON can contain endpoint data. Keep diagnostics secret-safe.
      throw new Error(
        `Could not read ${command.join(' ')} from the selected CLI/running app.`,
      );
    }
    if (response?.ok !== true || response.result?.ok !== true)
      throw new Error(
        `${command.join(' ')} did not return a successful capability response.`,
      );
    return response.result.value;
  };
  const quiz = read(['quiz', 'capabilities']);
  const error = quizIntegrationCompatibilityError(quiz);
  if (error) throw new Error(error);
  const study = read(['study', 'capabilities']);
  if (study?.schemaVersion !== 1)
    throw new Error(
      'Storm study schema is incompatible; expected schemaVersion 1.',
    );
  return { quiz, study };
}

export function tutorDoctor(repo = tutorRepo, env: Environment = process.env) {
  const sources = tutorSourceDiagnostics(repo);
  const target = path.join(piAgentDir(env), 'extensions/storm.ts');
  const manifest = path.join(piAgentDir(env), 'storm-tutor-install.json');
  let installed: unknown = null;
  if (existsSync(manifest))
    installed = JSON.parse(readFileSync(manifest, 'utf8'));
  const wrapperHash = existsSync(target)
    ? createHash('sha256').update(readFileSync(target)).digest('hex')
    : null;
  let cli: string | null = null;
  let capabilities: ReturnType<typeof checkTutorCapabilities> | null = null;
  let capabilityError: string | null = null;
  try {
    const config = resolveTutorCli(repo, env);
    cli = config.executable;
    capabilities = checkTutorCapabilities(config, env);
  } catch (error) {
    capabilityError = error instanceof Error ? error.message : String(error);
  }
  const recorded = installed as {
    wrapperHash?: string;
    hashes?: Record<string, string>;
    repo?: string;
  } | null;
  return {
    ...sources,
    cli,
    // Arguments may contain secrets; diagnostics intentionally omit them.
    installed,
    wrapperHash,
    wrapperMatchesManifest:
      recorded?.wrapperHash === wrapperHash && wrapperHash !== null,
    installedRepoMatchesCheckout: recorded?.repo === repo,
    sourcesChangedSinceInstall: TUTOR_SOURCES.filter(
      (file) => recorded?.hashes?.[file] !== sources.hashes[file],
    ),
    capabilities,
    compatible: capabilities !== null,
    capabilityError,
    restart:
      'Loaded Pi code cannot be inferred from files on disk. Restart Pi after installing or changing extension, shared helpers, or Tutor prompt; then explicitly reattach when appropriate.',
  };
}
