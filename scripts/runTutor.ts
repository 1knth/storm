#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { QUIZ_INTEGRATION_VERSION } from '../src/shared/quizIntegrationVersion';
import {
  configureTutorCli,
  checkTutorCapabilities,
  piAgentDir,
  tutorRepo,
  tutorDoctor,
} from './tutorDeployment';

function launchTutor() {
  const config = configureTutorCli();
  checkTutorCapabilities(config);
  console.error(
    `Tutor integration v${QUIZ_INTEGRATION_VERSION}; CLI ${config.executable}`,
  );
  console.error(`Sources: ${process.env.STORM_TUTOR_DIAGNOSTICS}`);
  const sessions = path.resolve(
    process.env.STORM_TUTOR_SESSION_DIR ||
      path.join(piAgentDir(), 'tutor/sessions'),
  );
  // Only create the session directory after all read-only preflight checks pass.
  mkdirSync(sessions, { recursive: true });
  const child = spawn(
    'pi',
    [
      '--no-extensions',
      '--extension',
      path.join(tutorRepo, 'extensions/storm-quiz.ts'),
      '--system-prompt',
      path.join(tutorRepo, 'skills/storm/TUTOR.md'),
      '--session-dir',
      sessions,
      '--name',
      'Tutor',
      ...process.argv.slice(2),
    ],
    { cwd: path.dirname(sessions), stdio: 'inherit', env: process.env },
  );
  const forwardInt = () => child.kill('SIGINT');
  const forwardTerm = () => child.kill('SIGTERM');
  process.on('SIGINT', forwardInt);
  process.on('SIGTERM', forwardTerm);
  child.once('error', () => {
    console.error('Could not start Pi. Install pi and ensure it is on PATH.');
    process.exitCode = 1;
  });
  child.once('close', (code, signal) => {
    process.removeListener('SIGINT', forwardInt);
    process.removeListener('SIGTERM', forwardTerm);
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1);
  });
}

try {
  if (process.argv[2] === '--doctor') {
    const diagnostics = tutorDoctor();
    console.log(JSON.stringify(diagnostics, null, 2));
    if (!diagnostics.compatible) process.exitCode = 1;
  } else launchTutor();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(
    'Build and launch the updated Storm app (pnpm package), select it with STORM_ENDPOINT if needed, and use its matching CLI. Tutor was not started.',
  );
  process.exitCode = 1;
}
