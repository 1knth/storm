#!/usr/bin/env bun
import { isQuizLearnerEvent } from '../src/shared/quizAgentContext';
import { isAgentEditPlan } from '../src/shared/agentEditValidation';
import {
  isAgentDiscoveryLimit,
  AGENT_DISCOVERY_LIMIT,
} from '../src/shared/agentProtocol';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import os from 'node:os';
import path from 'node:path';
import {
  inspectAgentEndpointMetadata,
  readAgentEndpoint,
  createAgentConnection,
  type AgentEndpointInfo,
} from '../src/main/agentEndpoint';
import type { AgentRequest } from '../src/shared/agentProtocol';
import {
  QUIZ_COGNITIVE_LEVELS,
  QUIZ_CONCEPT_ID,
  QUIZ_MAX_CONCEPTS,
  QUIZ_SUPPORTS,
} from '../src/shared/quizProtocol';
import { isStudyRequest, type StudyRequest } from '../src/shared/studyContext';
type RequestPayload<T> = T extends unknown
  ? Omit<T, 'protocol' | 'requestId'>
  : never;
import { helpText, knownCommands } from './stormHelp';

class CliUsageError extends Error {}

const STDIN_HIGH_WATER_MARK = 1024 * 1024;
const STDIN_LOW_WATER_MARK = STDIN_HIGH_WATER_MARK / 2;

export class BoundedStdinReader implements AsyncIterator<Buffer> {
  private queue: Buffer[] = [];
  private queuedBytes = 0;
  private ended = false;
  private failure: Error | undefined;
  private waiter: (() => void) | undefined;
  private closed = false;

  constructor(
    private readonly stream: NodeJS.ReadableStream & {
      pause(): unknown;
      resume(): unknown;
    },
  ) {
    stream.on('data', this.onData);
    stream.on('end', this.onEnd);
    stream.on('error', this.onError);
    stream.resume();
  }

  private notify = () => {
    this.waiter?.();
    this.waiter = undefined;
  };
  private onData = (chunk: Buffer | Uint8Array | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.queue.push(buffer);
    this.queuedBytes += buffer.length;
    if (this.queuedBytes >= STDIN_HIGH_WATER_MARK) this.stream.pause();
    this.notify();
  };
  private onEnd = () => {
    this.ended = true;
    this.notify();
  };
  private onError = (error: Error) => {
    this.failure = error;
    this.notify();
  };

  async next(): Promise<IteratorResult<Buffer>> {
    while (!this.queue.length && !this.ended && !this.failure && !this.closed)
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    if (this.queue.length) {
      const value = this.queue.shift()!;
      this.queuedBytes -= value.length;
      if (this.queuedBytes < STDIN_LOW_WATER_MARK && !this.ended)
        this.stream.resume();
      return { done: false, value };
    }
    if (this.failure) throw this.failure;
    return { done: true, value: undefined };
  }

  async return(): Promise<IteratorResult<Buffer>> {
    this.close();
    return { done: true, value: undefined };
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stream.pause();
    this.stream.removeListener('data', this.onData);
    this.stream.removeListener('end', this.onEnd);
    this.stream.removeListener('error', this.onError);
    this.notify();
  }
}

function cliHelp(command?: string): string {
  const executable = path.basename(process.execPath).replace(/\.exe$/i, '');
  const text = helpText(command);
  if (process.env.STORM_INSTALLED_CLI !== '1' && executable !== 'storm')
    return text;
  return text.replaceAll('bun scripts/storm.ts', 'storm');
}

export async function discoverEndpoint(
  override?: string,
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  if (override) return override;
  const appData =
    platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : platform === 'win32'
        ? path.join(home, 'AppData', 'Roaming')
        : path.join(home, '.config');
  const candidates = [
    path.join(appData, 'storm', 'storm-agent.json'),
    ...(platform === 'darwin'
      ? [path.join(appData, 'Storm', 'storm-agent.json')]
      : []),
    path.join(home, '.storm', 'storm-agent.json'),
  ];
  const found: string[] = [];
  const fileIdentities = new Set<string>();
  for (const candidate of candidates) {
    try {
      const info = await inspectAgentEndpointMetadata(candidate);
      const identity = `${info.dev}:${info.ino}`;
      if (!fileIdentities.has(identity)) {
        fileIdentities.add(identity);
        found.push(candidate);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (found.length > 1)
    throw new Error(
      'Multiple Storm endpoint profiles found; choose one with --endpoint PATH or --profile NAME',
    );
  if (found.length === 1) return found[0]!;
  throw new Error(
    'Cannot find Storm endpoint metadata; start Storm or set STORM_ENDPOINT/--endpoint',
  );
}

function formatContext(
  context: import('../src/shared/agentProtocol').AgentContext,
): string {
  const lines = ['Registered vaults:'];
  if (context.registeredVaults.length) {
    for (const vault of context.registeredVaults)
      lines.push(`  ${vault.name} (${vault.id}): ${vault.path}`);
  } else lines.push('  (none)');
  const activeVault = context.registeredVaults.find(
    (vault) => vault.id === context.activeVaultId,
  );
  lines.push(
    `Active vault: ${activeVault ? `${activeVault.name} (${activeVault.id})` : '(none)'}`,
  );
  lines.push('Active note:');
  lines.push(
    context.activeNote
      ? `  ${context.activeNote.path} [${context.activeNote.relativePath}]`
      : '  (none)',
  );
  lines.push('Open notes (open tabs only; not a full vault listing):');
  if (context.openNotes.length) {
    for (const note of context.openNotes)
      lines.push(
        `  ${note.path} [${note.relativePath}] (vault ${note.vaultId})`,
      );
  } else lines.push('  (none)');
  return lines.join('\n');
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0)!;
    return code < 32 || (code >= 127 && code <= 159);
  });
}

export async function runCli(
  args: string[],
  io: {
    home?: string;
    stdin?:
      | (NodeJS.ReadableStream & { pause(): unknown; resume(): unknown })
      | AsyncIterable<Uint8Array>;
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
  } = {},
): Promise<number> {
  const out = io.stdout ?? ((text) => process.stdout.write(text));
  const err = io.stderr ?? ((text) => process.stderr.write(text));
  let connection: ReturnType<typeof createAgentConnection> | undefined;
  try {
    const helpIndex = args.findIndex((arg) => arg === '-h' || arg === '--help');
    if (helpIndex >= 0) {
      const beforeHelp = args.slice(0, helpIndex);
      const command = [...beforeHelp]
        .reverse()
        .find(
          (arg) =>
            knownCommands.includes(arg) || arg === 'list' || arg === 'search',
        );
      out(`${cliHelp(command)}\n`);
      return 0;
    }

    let endpointPath: string | undefined;
    let profileName: string | undefined;
    const rest: string[] = [];
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      if (arg === '--endpoint' || arg === '--profile') {
        const value = args[++index];
        if (!value || value.startsWith('--'))
          throw new CliUsageError(`${arg} requires a value`);
        if (arg === '--endpoint') endpointPath = value;
        else profileName = value;
      } else if (
        arg.startsWith('-') &&
        arg !== '--json' &&
        arg !== '--stdin' &&
        arg !== '--name' &&
        arg !== '--expected-version' &&
        arg !== '--dry-run' &&
        arg !== '--operation-id' &&
        arg !== '--preview-receipt' &&
        arg !== '--vault' &&
        arg !== '--limit' &&
        arg !== '--source' &&
        arg !== '--target' &&
        arg !== '--depth' &&
        arg !== '--include-source' &&
        arg !== '--client-id' &&
        arg !== '--token' &&
        arg !== '--state' &&
        arg !== '--after' &&
        arg !== '--timeout' &&
        arg !== '--image-id' &&
        arg !== '--compact' &&
        arg !== '--section' &&
        arg !== '--before' &&
        arg !== '--offset'
      ) {
        throw new CliUsageError(`Unknown option: ${arg}`);
      } else rest.push(arg);
    }
    const command = rest[0];
    if (!command) {
      out(`${cliHelp()}\n`);
      return 0;
    }
    if (
      !knownCommands.includes(command) &&
      command !== 'list' &&
      command !== 'search' &&
      command !== 'quiz'
    )
      throw new CliUsageError(`Unknown command: ${command}`);
    let studyRequest: StudyRequest | undefined;
    if (command === 'study') {
      if (
        rest[1] === 'capabilities' &&
        rest.slice(2).every((v) => v === '--json')
      )
        studyRequest = { action: 'capabilities' };
      else {
        if (rest.length !== 2 || rest[1] !== '--stdin')
          throw new CliUsageError(
            'study requires capabilities or --stdin with a study request JSON object',
          );
        let input = '';
        const decoder = new StringDecoder('utf8');
        for await (const chunk of (io.stdin ??
          process.stdin) as AsyncIterable<Uint8Array>) {
          input += decoder.write(Buffer.from(chunk));
          if (Buffer.byteLength(input) > 64_000)
            throw new CliUsageError('Study request exceeds 64 KB');
        }
        input += decoder.end();
        let parsed: unknown;
        try {
          parsed = JSON.parse(input);
        } catch {
          throw new CliUsageError('Study input must be valid JSON');
        }
        if (!isStudyRequest(parsed))
          throw new CliUsageError('Invalid study request');
        studyRequest = parsed;
      }
    }
    const nameFlag = rest.indexOf('--name');
    if (
      nameFlag >= 0 &&
      (!rest[nameFlag + 1] || rest[nameFlag + 1]!.startsWith('-'))
    )
      throw new CliUsageError('--name requires a value');
    const agentName = nameFlag >= 0 ? rest[nameFlag + 1]?.trim() : undefined;
    if (nameFlag >= 0) rest.splice(nameFlag, 2);
    if (agentName && (agentName.length > 64 || hasControlCharacter(agentName)))
      throw new CliUsageError(
        'Agent name must be at most 64 characters on one line',
      );
    let editVersion: number | undefined;
    let editOperationId: string | undefined;
    if (command === 'replace' || command === 'patch') {
      const sessionId = rest[1];
      if (!sessionId || sessionId.startsWith('-'))
        throw new CliUsageError(
          `${command} requires SESSION --expected-version N --stdin`,
        );
      let sawVersion = false;
      let sawStdin = false;
      let sawDryRun = false;
      let sawJson = false;
      let sawOperationId = false;
      let previewReceipt: string | undefined;
      for (let index = 2; index < rest.length; index++) {
        const flag = rest[index]!;
        if (flag === '--expected-version') {
          if (sawVersion)
            throw new CliUsageError('Duplicate --expected-version');
          sawVersion = true;
          const value = rest[++index];
          if (
            !value ||
            !/^(0|[1-9]\d*)$/.test(value) ||
            !isAgentDiscoveryLimit(Number(value))
          )
            throw new CliUsageError(
              '--expected-version requires a nonnegative safe integer',
            );
          editVersion = Number(value);
        } else if (flag === '--operation-id') {
          if (sawOperationId)
            throw new CliUsageError('Duplicate --operation-id');
          sawOperationId = true;
          editOperationId = rest[++index];
          if (!editOperationId || editOperationId.startsWith('-'))
            throw new CliUsageError('--operation-id requires a value');
        } else if (flag === '--preview-receipt') {
          if (previewReceipt !== undefined)
            throw new CliUsageError('Duplicate --preview-receipt');
          previewReceipt = rest[++index];
          if (!previewReceipt || previewReceipt.startsWith('-'))
            throw new CliUsageError('--preview-receipt requires a value');
        } else if (flag === '--stdin') {
          if (sawStdin) throw new CliUsageError('Duplicate --stdin');
          sawStdin = true;
        } else if (flag === '--dry-run') {
          if (sawDryRun) throw new CliUsageError('Duplicate --dry-run');
          sawDryRun = true;
        } else if (flag === '--json') {
          if (sawJson) throw new CliUsageError('Duplicate --json');
          sawJson = true;
        } else throw new CliUsageError(`Unknown ${command} argument: ${flag}`);
      }
      if (!sawVersion || !sawStdin)
        throw new CliUsageError(
          `${command} requires SESSION --expected-version N --stdin`,
        );
      if (command === 'patch' && !sawDryRun && !previewReceipt)
        throw new CliUsageError(
          'patch requires --preview-receipt ID before applying. First run the same patch with --dry-run, inspect the preview, then apply with its receipt.',
        );
    }
    let quizOperation:
      | 'capabilities'
      | 'list'
      | 'attach'
      | 'detach'
      | 'activity'
      | 'status'
      | 'learner'
      | 'wait'
      | 'request'
      | 'image'
      | 'image-release'
      | 'context'
      | undefined;
    let quizSession: string | undefined;
    let quizImageId: string | undefined;
    let quizToken: string | undefined;
    let quizCompact = false;
    let quizSection = 'history';
    let quizBefore: number | undefined;
    let quizOffset: number | undefined;
    let quizAfter: number | undefined;
    let quizTimeout: number | undefined;
    let quizClientId: string | undefined;
    let quizPayload: any;
    if (command === 'quiz') {
      quizOperation = rest[1] as typeof quizOperation;
      if (
        ![
          'capabilities',
          'list',
          'attach',
          'detach',
          'activity',
          'status',
          'learner',
          'context',
          'wait',
          'request',
          'image',
          'image-release',
        ].includes(quizOperation ?? '')
      )
        throw new CliUsageError(
          'quiz requires capabilities|list|attach|detach|activity|status|learner|context|wait|request|image|image-release',
        );
      quizSession = rest[2] && !rest[2]!.startsWith('--') ? rest[2] : undefined;
      const tail = rest.slice(quizSession ? 3 : 2);
      for (let i = 0; i < tail.length; i++) {
        const flag = tail[i]!;
        if (quizOperation === 'capabilities') {
          if (flag === '--json') continue;
          throw new CliUsageError('quiz capabilities accepts only --json');
        }
        if (quizOperation === 'learner' && flag !== '--token')
          throw new CliUsageError(`Invalid quiz learner argument: ${flag}`);
        if (
          flag === '--compact' &&
          ['attach', 'status', 'wait'].includes(quizOperation ?? '')
        ) {
          quizCompact = true;
          continue;
        }
        const value = tail[++i];
        if (quizOperation === 'learner' && (!value || value.startsWith('--')))
          throw new CliUsageError('quiz learner --token requires TOKEN');
        if (
          quizOperation === 'context' &&
          flag === '--section' &&
          ['history', 'question', 'prompt', 'scope', 'event'].includes(
            value ?? '',
          )
        ) {
          quizSection = value!;
          continue;
        }
        if (
          quizOperation === 'context' &&
          ['--before', '--offset'].includes(flag) &&
          value &&
          /^(0|[1-9]\d*)$/.test(value) &&
          Number.isSafeInteger(Number(value))
        ) {
          if (flag === '--before') quizBefore = Number(value);
          else quizOffset = Number(value);
          continue;
        }
        if (flag === '--token') quizToken = value;
        else if (flag === '--client-id') quizClientId = value;
        else if (flag === '--state') quizPayload = value;
        else if (flag === '--json' && quizOperation === 'image') continue;
        else if (flag === '--image-id') quizImageId = value;
        else if (flag === '--offset')
          throw new CliUsageError(
            '--offset is obsolete; quiz images are fetched whole',
          );
        else if (flag === '--timeout' && value && /^\d+(?:\.\d+)?$/.test(value))
          quizTimeout = Number(value);
        else if (
          flag === '--after' &&
          value &&
          /^(0|[1-9]\d*)$/.test(value) &&
          Number.isSafeInteger(Number(value))
        )
          quizAfter = Number(value);
        else throw new CliUsageError(`Invalid quiz argument: ${flag}`);
      }
      if (quizOperation === 'capabilities' && quizSession)
        throw new CliUsageError('quiz capabilities does not take a session');
      if (
        !['list', 'capabilities'].includes(quizOperation ?? '') &&
        !quizSession
      )
        throw new CliUsageError(`quiz ${quizOperation} requires SESSION_ID`);
      if (
        quizOperation === 'wait' &&
        quizTimeout !== undefined &&
        (!Number.isFinite(quizTimeout) || quizTimeout < 0 || quizTimeout > 300)
      )
        throw new CliUsageError(
          'quiz wait --timeout must be from 0 to 300 seconds',
        );
      if (quizOperation === 'wait' && quizAfter === undefined)
        throw new CliUsageError('quiz wait requires --after CURSOR');
      if (
        ['image', 'image-release'].includes(quizOperation ?? '') &&
        !quizImageId
      )
        throw new CliUsageError(`quiz ${quizOperation} requires --image-id ID`);
      if (
        [
          'status',
          'learner',
          'context',
          'wait',
          'detach',
          'activity',
          'image',
          'image-release',
        ].includes(quizOperation ?? '') &&
        !(quizToken ?? process.env.STORM_QUIZ_TOKEN)
      )
        throw new CliUsageError(
          `quiz ${quizOperation} requires --token TOKEN or STORM_QUIZ_TOKEN`,
        );
      if (quizOperation === 'activity') {
        if (!quizToken && !process.env.STORM_QUIZ_TOKEN)
          throw new CliUsageError('quiz activity requires --token TOKEN');
        if (!quizPayload)
          throw new CliUsageError(
            'quiz activity requires --state idle|thinking|drafting',
          );
      }
      if (quizOperation === 'request') {
        let text = '';
        const stdinDecoder = new StringDecoder('utf8');
        for await (const chunk of (io.stdin ??
          process.stdin) as AsyncIterable<Uint8Array>)
          text += stdinDecoder.write(Buffer.from(chunk));
        text += stdinDecoder.end();
        try {
          quizPayload = JSON.parse(text);
        } catch {
          throw new CliUsageError('quiz request stdin must be a JSON object');
        }
        if (
          !quizPayload ||
          typeof quizPayload !== 'object' ||
          Array.isArray(quizPayload)
        )
          throw new CliUsageError('quiz request stdin must be a JSON object');
        quizPayload = {
          ...quizPayload,
          sessionId: quizSession,
          agentToken:
            quizPayload.agentToken ?? quizToken ?? process.env.STORM_QUIZ_TOKEN,
          idempotencyKey: quizPayload.idempotencyKey ?? randomUUID(),
        };
        if (!quizPayload.agentToken)
          throw new CliUsageError(
            'quiz request requires payload agentToken or --token TOKEN',
          );
        if (
          ![
            'pose-question',
            'pose-prompt',
            'feedback',
            'agent-message',
            'skip-question',
            'support-update',
            'lesson-map',
            'practice-test',
            'tutor-notes',
          ].includes(quizPayload.type)
        )
          throw new CliUsageError(
            'quiz request type must be pose-question, pose-prompt, feedback, agent-message, skip-question, support-update, lesson-map, practice-test, or tutor-notes',
          );
        if (
          quizPayload.type === 'practice-test' &&
          !['start', 'end', 'cancel'].includes(quizPayload.action)
        )
          throw new CliUsageError(
            'practice-test requires action start (with concepts), end, or cancel',
          );
        if (
          !Number.isSafeInteger(quizPayload.expectedRevision) ||
          quizPayload.expectedRevision < 0
        )
          throw new CliUsageError(
            'quiz request requires a nonnegative safe integer expectedRevision',
          );
        if (
          quizPayload.type === 'skip-question' &&
          (typeof quizPayload.questionId !== 'string' ||
            !quizPayload.questionId.trim() ||
            quizPayload.questionId.length > 128 ||
            typeof quizPayload.text !== 'string' ||
            !quizPayload.text.trim() ||
            quizPayload.text.length > 10000)
        )
          throw new CliUsageError(
            'skip-question requires questionId and explanation text of 1-10000 characters',
          );
        if (
          quizPayload.type === 'support-update' &&
          (typeof quizPayload.questionId !== 'string' ||
            !quizPayload.questionId.trim() ||
            quizPayload.questionId.length > 128 ||
            !QUIZ_SUPPORTS.includes(quizPayload.support) ||
            typeof quizPayload.text !== 'string' ||
            !quizPayload.text.trim() ||
            quizPayload.text.length > 10000)
        )
          throw new CliUsageError(
            'support-update requires questionId, support independent|hinted|worked, and the help text of 1-10000 characters',
          );
        if (quizPayload.type === 'pose-prompt') {
          const choices = quizPayload.choices;
          const validChoices =
            Array.isArray(choices) &&
            choices.length >= 1 &&
            choices.length <= 6 &&
            choices.every(
              (choice: any) =>
                choice &&
                typeof choice.id === 'string' &&
                choice.id.trim() &&
                typeof choice.text === 'string' &&
                choice.text.trim(),
            ) &&
            new Set(choices.map((choice: { id: string }) => choice.id)).size ===
              choices.length;
          if (
            !['next-steps', 'clarification'].includes(quizPayload.kind) ||
            typeof quizPayload.prompt !== 'string' ||
            !quizPayload.prompt.trim() ||
            quizPayload.prompt.length > 4000 ||
            !validChoices ||
            (quizPayload.promptId !== undefined &&
              (typeof quizPayload.promptId !== 'string' ||
                !quizPayload.promptId.trim() ||
                quizPayload.promptId.length > 128))
          )
            throw new CliUsageError(
              'pose-prompt requires kind, prompt text of 1-4000 characters, and 1-6 choices with unique ids',
            );
        }
        if (quizPayload.type === 'pose-question') {
          const { concepts, level, support, unmodelledReason } = quizPayload;
          if (
            unmodelledReason !== undefined &&
            (typeof unmodelledReason !== 'string' ||
              !unmodelledReason.trim() ||
              unmodelledReason.length > 500 ||
              concepts !== undefined ||
              level !== undefined ||
              support !== undefined)
          )
            throw new CliUsageError(
              'unmodelledReason must be 1-500 characters and used without learning tags',
            );
          if ((concepts !== undefined) !== (level !== undefined))
            throw new CliUsageError(
              'pose-question concepts and level must be supplied together',
            );
          if (
            concepts !== undefined &&
            (!Array.isArray(concepts) ||
              concepts.length < 1 ||
              concepts.length > QUIZ_MAX_CONCEPTS ||
              concepts.some(
                (id: unknown) =>
                  typeof id !== 'string' || !QUIZ_CONCEPT_ID.test(id),
              ) ||
              new Set(concepts).size !== concepts.length)
          )
            throw new CliUsageError(
              `pose-question concepts must be 1-${QUIZ_MAX_CONCEPTS} unique lowercase slugs matching ${QUIZ_CONCEPT_ID.source}`,
            );
          if (level !== undefined && !QUIZ_COGNITIVE_LEVELS.includes(level))
            throw new CliUsageError(
              `pose-question level must be ${QUIZ_COGNITIVE_LEVELS.join('|')}`,
            );
          if (support !== undefined && concepts === undefined)
            throw new CliUsageError(
              'pose-question support requires concepts and level',
            );
          if (support !== undefined && !QUIZ_SUPPORTS.includes(support))
            throw new CliUsageError(
              `pose-question support must be ${QUIZ_SUPPORTS.join('|')}`,
            );
          const question = quizPayload.question;
          const kind = quizPayload.kind ?? 'multiple-choice';
          const validItems = (items: unknown) =>
            Array.isArray(items) &&
            items.length >= 2 &&
            items.length <= 12 &&
            items.every(
              (item) =>
                item &&
                typeof item.id === 'string' &&
                item.id.trim() &&
                typeof item.text === 'string' &&
                item.text.trim(),
            ) &&
            new Set(items.map((item: { id: string }) => item.id)).size ===
              items.length;
          const choices = quizPayload.choices;
          const validChoices =
            Array.isArray(choices) &&
            choices.length >= 1 &&
            choices.length <= 6 &&
            choices.every(
              (item: any) =>
                item &&
                typeof item.id === 'string' &&
                item.id.trim() &&
                typeof item.text === 'string' &&
                item.text.trim(),
            ) &&
            new Set(choices.map((item: { id: string }) => item.id)).size ===
              choices.length;
          const validQuestion =
            typeof question === 'string' &&
            question.trim() &&
            question.length <= 4000 &&
            (kind === 'multiple-choice'
              ? validChoices &&
                quizPayload.leftItems === undefined &&
                quizPayload.rightItems === undefined
              : kind === 'matching'
                ? choices === undefined &&
                  validItems(quizPayload.leftItems) &&
                  validItems(quizPayload.rightItems) &&
                  quizPayload.leftItems.length ===
                    quizPayload.rightItems.length &&
                  new Set(
                    [...quizPayload.leftItems, ...quizPayload.rightItems].map(
                      (item: { id: string }) => item.id,
                    ),
                  ).size ===
                    quizPayload.leftItems.length + quizPayload.rightItems.length
                : kind === 'short-answer' || kind === 'long-answer'
                  ? choices === undefined &&
                    quizPayload.leftItems === undefined &&
                    quizPayload.rightItems === undefined
                  : false);
          if (!validQuestion)
            throw new CliUsageError(
              'pose-question requires question text of 1-4000 characters and valid fields for its kind: multiple-choice (1-6 choices), matching (2-12 unique pairs), or short-answer/long-answer (no choices/items)',
            );
        }
      }
    }
    let discoveryVaultId: string | undefined;
    let discoveryQuery: string | undefined;
    let discoveryLimit: number | undefined;
    let discoverySourcePath: string | undefined;
    let discoveryDepth: number | undefined;
    let discoveryIncludeSource = false;
    let discoveryJson = false;
    let resolveVaultId: string | undefined;
    let resolveSource: string | undefined;
    let resolveTarget: string | undefined;
    let resolveJson = false;
    if (command === 'resolve-link') {
      for (let index = 1; index < rest.length; index++) {
        const flag = rest[index]!;
        if (flag === '--vault') resolveVaultId = rest[++index];
        else if (flag === '--source') resolveSource = rest[++index];
        else if (flag === '--target') resolveTarget = rest[++index];
        else if (flag === '--json') resolveJson = true;
        else throw new CliUsageError(`Unknown resolve-link argument: ${flag}`);
      }
      if (!resolveVaultId || !resolveSource || !resolveTarget)
        throw new CliUsageError(
          'resolve-link requires --vault VAULT_ID --source NOTE_PATH --target WIKILINK_TARGET',
        );
    }
    if (command === 'list' || command === 'search') {
      const required = command === 'search' ? 2 : 1;
      if (
        rest.length < required + 1 ||
        (command === 'search' && (!rest[1] || rest[1].startsWith('-')))
      )
        throw new CliUsageError(
          command === 'search'
            ? 'search requires QUERY --vault VAULT_ID [--limit N] [--json]'
            : 'list requires --vault VAULT_ID [--limit N] [--json]',
        );
      discoveryQuery = command === 'search' ? rest[1] : undefined;
      for (let index = required; index < rest.length; index++) {
        const flag = rest[index]!;
        if (flag === '--vault') {
          if (discoveryVaultId) throw new CliUsageError('Duplicate --vault');
          discoveryVaultId = rest[++index];
          if (!discoveryVaultId || discoveryVaultId.startsWith('-'))
            throw new CliUsageError('--vault requires a vault ID');
        } else if (flag === '--limit') {
          if (discoveryLimit !== undefined)
            throw new CliUsageError('Duplicate --limit');
          const value = rest[++index];
          if (
            !value ||
            !/^[1-9]\d*$/.test(value) ||
            !isAgentDiscoveryLimit(Number(value))
          )
            throw new CliUsageError(
              `--limit requires an integer from 1 to ${AGENT_DISCOVERY_LIMIT.max}`,
            );
          discoveryLimit = Number(value);
        } else if (flag === '--source') {
          if (discoverySourcePath)
            throw new CliUsageError('Duplicate --source');
          discoverySourcePath = rest[++index];
          if (!discoverySourcePath || discoverySourcePath.startsWith('-'))
            throw new CliUsageError('--source requires a note path');
        } else if (flag === '--depth') {
          if (discoveryDepth !== undefined)
            throw new CliUsageError('Duplicate --depth');
          const value = rest[++index];
          if (!value || !/^[0-5]$/.test(value))
            throw new CliUsageError('--depth requires an integer from 0 to 5');
          discoveryDepth = Number(value);
        } else if (flag === '--include-source') {
          if (discoveryIncludeSource)
            throw new CliUsageError('Duplicate --include-source');
          discoveryIncludeSource = true;
        } else if (flag === '--json') {
          if (discoveryJson) throw new CliUsageError('Duplicate --json');
          discoveryJson = true;
        } else throw new CliUsageError(`Unknown ${command} argument: ${flag}`);
      }
      if (!discoveryVaultId)
        throw new CliUsageError(`${command} requires --vault VAULT_ID`);
      if (
        command !== 'search' &&
        (discoverySourcePath ||
          discoveryDepth !== undefined ||
          discoveryIncludeSource)
      )
        throw new CliUsageError(
          'Linked discovery options are supported only by search',
        );
      if (
        (discoveryDepth !== undefined || discoveryIncludeSource) &&
        !discoverySourcePath
      )
        throw new CliUsageError(
          '--depth and --include-source require --source NOTE_PATH',
        );
    }
    if (
      command === 'context' &&
      (rest.length > 2 || (rest[1] && rest[1] !== '--json'))
    )
      throw new CliUsageError('context accepts only optional --json');
    if (command === 'inspect' && (rest.length !== 3 || rest[2] !== '--json'))
      throw new CliUsageError('inspect requires ABS_PATH --json');
    if (command === 'connect' && (rest.length !== 3 || rest[2] !== '--json'))
      throw new CliUsageError('connect requires ABS_PATH --json');
    if (command === 'stream' && (rest.length !== 3 || rest[2] !== '--stdin'))
      throw new CliUsageError('stream requires SESSION --stdin');
    if (
      command === 'status' &&
      (rest.length > 3 || (rest[2] && rest[2] !== '--json'))
    )
      throw new CliUsageError('status accepts at most SESSION [--json]');
    if (
      command === 'activity' &&
      (rest.length !== 3 ||
        !['thinking', 'drafting', 'idle'].includes(rest[2]!))
    )
      throw new CliUsageError(
        'activity requires SESSION thinking|drafting|idle',
      );
    if ((command === 'finish' || command === 'cancel') && rest.length !== 2)
      throw new CliUsageError(`${command} requires SESSION`);
    const home = io.home ?? os.homedir();
    const endpoint =
      endpointPath ??
      (profileName
        ? path.join(home, '.storm', profileName, 'storm-agent.json')
        : await discoverEndpoint(process.env.STORM_ENDPOINT, home));
    let info: AgentEndpointInfo;
    try {
      info = await readAgentEndpoint(endpoint);
    } catch {
      throw new Error(
        'Cannot read Storm endpoint metadata; start Storm or check --endpoint/--profile',
      );
    }
    connection = createAgentConnection(info);
    const request = async (value: RequestPayload<AgentRequest>) => {
      try {
        return await connection!.request({
          ...value,
          protocol: 1 as const,
          requestId: randomUUID(),
        });
      } catch {
        throw new Error(
          'Could not communicate with Storm; confirm the app is running',
        );
      }
    };
    if (command === 'quiz' && quizOperation === 'wait') {
      const deadline =
        quizTimeout === undefined ? undefined : Date.now() + quizTimeout * 1000;
      let cursor = quizAfter!;
      let latest: any;
      while (true) {
        latest = await request({
          type: 'quiz',
          operation: 'wait',
          waitMs:
            deadline === undefined
              ? 20000
              : Math.max(0, Math.min(20000, deadline - Date.now())),
          sessionId: quizSession!,
          agentToken: quizToken ?? process.env.STORM_QUIZ_TOKEN!,
          after: cursor,
          ...(quizCompact ? { compact: true } : {}),
        } as any);
        const value = latest?.snapshot;
        if (!latest?.ok)
          throw new Error(latest?.error ?? 'Quiz snapshot request failed');
        if (!value?.session)
          throw new Error('Quiz snapshot did not include a session');
        const events = Array.isArray(value.events) ? value.events : [];
        cursor = Math.max(
          cursor,
          Number(value.after) || 0,
          ...events.map((event: any) => Number(event.cursor) || 0),
        );
        const learnerEvents = events.filter(isQuizLearnerEvent);
        if (learnerEvents.length) {
          out(
            `${JSON.stringify({ ...latest, timedOut: false, after: cursor })}\n`,
          );
          return 0;
        }
        if (value.session.status === 'disconnected') {
          out(
            `${JSON.stringify({ ...latest, timedOut: false, disconnected: true, after: cursor, message: 'Quiz session is disconnected.' })}\n`,
          );
          return 0;
        }
        if (value.session.status === 'complete') {
          out(
            `${JSON.stringify({ ...latest, timedOut: false, after: cursor })}\n`,
          );
          return 0;
        }
        const remaining = deadline === undefined ? 1000 : deadline - Date.now();
        if (remaining <= 0) {
          out(
            `${JSON.stringify({ ...latest, timedOut: true, after: cursor, message: 'Timed out waiting for learner activity; call quiz wait again to continue.' })}\n`,
          );
          return 0;
        }
      }
    }
    let result: any;
    if (command === 'study')
      result = await request({ type: 'study', study: studyRequest! });
    else if (command === 'quiz') {
      const operation =
        quizOperation === 'status' || quizOperation === 'wait'
          ? 'snapshot'
          : quizOperation === 'image'
            ? 'image-fetch'
            : quizOperation === 'image-release'
              ? 'image-release'
              : quizOperation!;
      result = await request({
        type: 'quiz',
        operation,
        ...(quizSession ? { sessionId: quizSession } : {}),
        ...(operation === 'attach'
          ? {
              clientId: quizClientId ?? 'storm-cli',
              ...(quizCompact ? { compact: true } : {}),
            }
          : {}),
        ...(operation === 'detach' || operation === 'learner'
          ? { agentToken: quizToken ?? process.env.STORM_QUIZ_TOKEN! }
          : {}),
        ...(operation === 'snapshot'
          ? {
              agentToken: quizToken ?? process.env.STORM_QUIZ_TOKEN!,
              ...(quizAfter !== undefined ? { after: quizAfter } : {}),
              ...(quizCompact
                ? { compact: true, recover: quizOperation === 'status' }
                : {}),
            }
          : {}),
        ...(operation === 'activity'
          ? {
              agentToken: quizToken ?? process.env.STORM_QUIZ_TOKEN!,
              state: quizPayload,
            }
          : {}),
        ...(operation === 'image-fetch' || operation === 'image-release'
          ? {
              agentToken: quizToken ?? process.env.STORM_QUIZ_TOKEN!,
              imageId: quizImageId,
            }
          : {}),
        ...(operation === 'context'
          ? {
              agentToken: quizToken ?? process.env.STORM_QUIZ_TOKEN!,
              section: quizSection,
              before: quizBefore,
              offset: quizOffset,
            }
          : {}),
        ...(operation === 'request' ? { request: quizPayload } : {}),
      } as any);
    } else if (command === 'context')
      result = await request({ type: 'context' });
    else if (command === 'resolve-link')
      result = await request({
        type: 'resolve-link',
        vaultId: resolveVaultId!,
        sourcePath: resolveSource!,
        target: resolveTarget!,
      });
    else if (command === 'list' || command === 'search')
      result = await request({
        type: 'discover',
        vaultId: discoveryVaultId!,
        ...(discoveryQuery !== undefined ? { query: discoveryQuery } : {}),
        ...(discoveryLimit !== undefined ? { limit: discoveryLimit } : {}),
        ...(discoverySourcePath !== undefined
          ? { sourcePath: discoverySourcePath }
          : {}),
        ...(discoveryDepth !== undefined ? { depth: discoveryDepth } : {}),
        ...(discoveryIncludeSource ? { includeSource: true } : {}),
      });
    else if (command === 'inspect' && rest[1] && rest[2] === '--json')
      result = await request({ type: 'inspect', absolutePath: rest[1] });
    else if (command === 'connect' && rest[1] && rest[2] === '--json')
      result = await request({
        type: 'connect',
        absolutePath: rest[1],
        ...(agentName ? { name: agentName } : {}),
      });
    else if (command === 'replace' || command === 'patch') {
      const stdin = io.stdin ?? process.stdin;
      let source = '';
      const stdinDecoder = new StringDecoder('utf8');
      for await (const chunk of stdin as AsyncIterable<Uint8Array>)
        source += stdinDecoder.write(Buffer.from(chunk));
      source += stdinDecoder.end();
      let plan: import('../src/shared/agentProtocol').AgentEditPlan;
      try {
        plan =
          command === 'replace'
            ? { type: 'replace', content: source }
            : { type: 'replaceText', replacements: JSON.parse(source) };
        if (!isAgentEditPlan(plan)) throw new Error('invalid patch');
      } catch {
        throw new CliUsageError(
          'patch stdin must be a JSON array of {"find":"non-empty string","replace":"string"} edits',
        );
      }
      const preview = rest.includes('--dry-run');
      result = await request({
        type: preview ? 'edit-preview' : 'edit-apply',
        sessionId: rest[1]!,
        operationId: editOperationId ?? randomUUID(),
        expectedVersion: editVersion!,
        plan,
        ...(command === 'patch' && !preview
          ? { previewReceipt: rest[rest.indexOf('--preview-receipt') + 1] }
          : {}),
      });
    } else if (command === 'status') {
      const sessionId = rest[1] === '--json' ? undefined : rest[1];
      result = await request({
        type: 'status',
        ...(sessionId ? { sessionId } : {}),
      });
    } else if (command === 'activity')
      result = await request({
        type: 'activity',
        sessionId: rest[1]!,
        activity:
          rest[2] === 'idle' ? null : (rest[2] as 'thinking' | 'drafting'),
      });
    else if (command === 'finish' || command === 'cancel')
      result = await request({ type: command, sessionId: rest[1] });
    else if (command === 'stream' && rest[1]) {
      const sessionId = rest[1];
      let sequence = 0;
      const decoder = new StringDecoder('utf8');
      let buffered = '';
      const send = async (text: string) => {
        result = await request({
          type: 'append',
          sessionId,
          operationId: randomUUID(),
          sequence: ++sequence,
          text,
        });
        if (!(result as any)?.ok) {
          err(`${JSON.stringify(result)}\n`);
          return false;
        }
        return true;
      };
      const sendBuffered = async () => {
        // Split by Unicode code point, respecting the protocol's byte limit.
        // Each available stdin chunk is forwarded immediately; awaiting each
        // request also applies socket backpressure without accumulating input.
        while (buffered) {
          let text = Buffer.byteLength(buffered) <= 262144 ? buffered : '';
          let bytes = 0;
          for (const character of text ? '' : buffered) {
            const size = Buffer.byteLength(character);
            if (bytes + size > 262144) break;
            text += character;
            bytes += size;
          }
          if (!text) throw new Error('Unable to frame stdin text');
          if (!(await send(text))) return false;
          buffered = buffered.slice(text.length);
        }
        return true;
      };
      const stdin = io.stdin ?? process.stdin;
      const input =
        'on' in stdin && 'pause' in stdin && 'resume' in stdin
          ? new BoundedStdinReader(
              stdin as NodeJS.ReadableStream & {
                pause(): unknown;
                resume(): unknown;
              },
            )
          : stdin[Symbol.asyncIterator]();
      const stopInput = () => {
        void input.return?.();
      };
      try {
        let nextInput = input.next();
        while (true) {
          let pollTimer: ReturnType<typeof setTimeout> | undefined;
          const outcome = await Promise.race([
            nextInput.then((value) => ({ kind: 'input' as const, value })),
            new Promise<{ kind: 'poll' }>((resolve) => {
              pollTimer = setTimeout(() => resolve({ kind: 'poll' }), 250);
            }),
          ]);
          if (pollTimer) clearTimeout(pollTimer);
          if (outcome.kind === 'poll') {
            const status = (await request({
              type: 'status',
              sessionId,
            })) as any;
            const state = status?.sessions?.[0]?.state;
            if (state && state !== 'connected' && state !== 'writing') {
              stopInput();
              err(
                `${JSON.stringify({ ok: false, error: { code: 'SESSION_CLOSED', message: `Session is ${state}` } })}\n`,
              );
              return 1;
            }
            continue;
          }
          if (outcome.value.done) break;
          buffered += decoder.write(outcome.value.value);
          if (!(await sendBuffered())) {
            stopInput();
            return 1;
          }
          nextInput = input.next();
        }
        buffered += decoder.end();
        if (!(await sendBuffered())) return 1;
        result = await request({ type: 'finish', sessionId });
      } finally {
        if (input instanceof BoundedStdinReader) input.close();
      }
    } else throw new CliUsageError(`Invalid arguments for ${command}`);
    if ((result as any)?.ok === false) {
      err(`${JSON.stringify(result)}\n`);
      return 1;
    }
    if (command === 'context' && rest[1] !== '--json')
      out(`${formatContext(result.context)}\n`);
    else if (command === 'resolve-link' && !resolveJson)
      out(
        result.path
          ? `${result.path}\n`
          : `Unresolved (${result.reason}): [[${result.target}]] from ${result.sourcePath}\n`,
      );
    else if ((command === 'list' || command === 'search') && !discoveryJson) {
      const notes = result.results.length
        ? `${result.results.map((note: { path: string; name: string; excerpt?: string }) => `${note.name}\t${note.path}${note.excerpt ? `\n${note.excerpt}` : ''}`).join('\n')}\n`
        : '(no notes)\n';
      const links = result.unresolved?.length
        ? `Unresolved links:\n${result.unresolved.map((link: { sourcePath: string; target: string; reason: string }) => `  ${link.reason}: [[${link.target}]] from ${link.sourcePath}`).join('\n')}\n`
        : '';
      const truncated = result.truncated
        ? 'Traversal truncated at its safety limit.\n'
        : '';
      out(notes + links + truncated);
    } else out(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof CliUsageError) {
      if (args.includes('quiz'))
        err(
          `${JSON.stringify({ error: { code: 'INVALID_ARGUMENT', message: error.message } })}\n`,
        );
      else err(`${error.message}\n\n${cliHelp()}\n`);
      return 2;
    }
    err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    connection?.close();
  }
}
if (import.meta.main) process.exitCode = await runCli(process.argv.slice(2));
