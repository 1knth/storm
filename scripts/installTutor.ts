#!/usr/bin/env bun
import {
  copyFileSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  piAgentDir,
  tutorRepo,
  tutorSourceDiagnostics,
} from './tutorDeployment';

function hash(text: string) {
  return createHash('sha256').update(text).digest('hex');
}

function replaceFile(target: string, contents: string) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** The extension was renamed from storm-quiz; Pi would otherwise load both. */
function retireLegacyWrapper(agentDir: string): string | null {
  const legacy = path.join(agentDir, 'extensions/storm-quiz.ts');
  if (!existsSync(legacy)) return null;
  const previous = readFileSync(legacy, 'utf8');
  const backup = `${legacy}.backup-${hash(previous).slice(0, 16)}`;
  if (!existsSync(backup))
    copyFileSync(legacy, backup, constants.COPYFILE_EXCL);
  else if (readFileSync(backup, 'utf8') !== previous)
    throw new Error(
      `Backup collision at ${backup}; the legacy extension was preserved.`,
    );
  rmSync(legacy);
  return backup;
}

export function installTutor(
  options: { repo?: string; agentDir?: string } = {},
) {
  const repo = path.resolve(options.repo || tutorRepo);
  const agentDir = path.resolve(options.agentDir || piAgentDir());
  // Read all sources before writing anything. Never install a broken checkout.
  const sources = tutorSourceDiagnostics(repo);
  const wrapper = `// Storm Tutor installer v${sources.integrationVersion}. Maintained source, no copied dependencies.
import stormQuiz from ${JSON.stringify(path.join(repo, 'extensions/storm.ts'))};
import { configureTutorCli } from ${JSON.stringify(path.join(repo, 'scripts/tutorDeployment.ts'))};

export default function (pi) {
  // Preserve explicit STORM_QUIZ_CLI / STORM_QUIZ_CLI_ARGS overrides.
  configureTutorCli(${JSON.stringify(repo)});
  return stormQuiz(pi);
}
`;
  const target = path.join(agentDir, 'extensions/storm.ts');
  const manifestPath = path.join(agentDir, 'storm-tutor-install.json');
  const previous = existsSync(target) ? readFileSync(target, 'utf8') : null;
  const changed = previous !== wrapper;
  let backup: string | null = null;
  if (changed && previous !== null)
    backup = `${target}.backup-${hash(previous).slice(0, 16)}`;
  const manifest = { ...sources, target, wrapperHash: hash(wrapper) };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestChanged =
    !existsSync(manifestPath) ||
    readFileSync(manifestPath, 'utf8') !== manifestText;
  if (changed || manifestChanged) {
    mkdirSync(path.dirname(target), { recursive: true });
    if (backup) {
      if (existsSync(backup)) {
        if (readFileSync(backup, 'utf8') !== previous)
          throw new Error(
            `Backup collision at ${backup}; existing files were preserved.`,
          );
      } else copyFileSync(target, backup, constants.COPYFILE_EXCL);
    }
    if (changed) replaceFile(target, wrapper);
    if (manifestChanged) replaceFile(manifestPath, manifestText);
  }
  const legacyBackup = retireLegacyWrapper(agentDir);
  return {
    changed,
    manifestChanged,
    backup,
    legacyBackup,
    manifestPath,
    ...manifest,
    restart:
      'Restart Pi to load the installed extension and updated prompt. Existing processes keep old modules. Use pnpm tutor for the maintained Tutor system prompt; installation does not change Pi settings or a running session.',
  };
}

if (import.meta.main) {
  try {
    const options: { repo?: string; agentDir?: string } = {};
    const args = process.argv.slice(2);
    if (args.includes('--help')) {
      console.log(
        'Usage: bun scripts/installTutor.ts [--pi-agent-dir PATH] [--repo PATH]\nInstalls only a backed-up extension wrapper and diagnostic manifest. Does not start Pi or contact Storm.',
      );
    } else {
      for (let i = 0; i < args.length; i++) {
        const flag = args[i];
        if (
          !['--pi-agent-dir', '--repo'].includes(flag) ||
          !args[i + 1] ||
          args[i + 1].startsWith('--')
        )
          throw new Error(`Invalid option: ${flag}. Use --help.`);
        const value = args[++i];
        if (flag === '--repo') options.repo = value;
        else options.agentDir = value;
      }
      console.log(JSON.stringify(installTutor(options), null, 2));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
