#!/usr/bin/env bun
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  readAgentEndpoint,
  sendAgentRequest,
  type AgentEndpointInfo,
} from '../src/main/agentEndpoint';
import type { AgentRequest } from '../src/shared/agentProtocol';
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
      const info = await lstat(candidate);
      if (
        !info.isFile() ||
        (process.getuid && info.uid !== process.getuid()) ||
        (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
      )
        throw new Error(
          'Storm endpoint metadata has unsafe ownership or permissions',
        );
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
        arg !== '--vault' &&
        arg !== '--limit' &&
        arg !== '--source' &&
        arg !== '--target' &&
        arg !== '--depth' &&
        arg !== '--include-source'
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
      command !== 'search'
    )
      throw new CliUsageError(`Unknown command: ${command}`);
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
            !Number.isSafeInteger(Number(value))
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
            !Number.isSafeInteger(Number(value))
          )
            throw new CliUsageError('--limit requires a positive safe integer');
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
    const request = async (
      value: Omit<AgentRequest, 'protocol' | 'requestId'>,
    ) => {
      try {
        return await sendAgentRequest(info, {
          ...value,
          protocol: 1,
          requestId: randomUUID(),
        } as AgentRequest);
      } catch {
        throw new Error(
          'Could not communicate with Storm; confirm the app is running',
        );
      }
    };
    let result: any;
    if (command === 'context') result = await request({ type: 'context' });
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
      for await (const chunk of stdin as AsyncIterable<Uint8Array>)
        source += Buffer.from(chunk).toString('utf8');
      let plan: import('../src/shared/agentProtocol').AgentEditPlan;
      try {
        plan =
          command === 'replace'
            ? { type: 'replace', content: source }
            : { type: 'replaceText', replacements: JSON.parse(source) };
        if (
          command === 'patch' &&
          (!Array.isArray((plan as any).replacements) ||
            (plan as any).replacements.some(
              (item: any) =>
                !item ||
                typeof item !== 'object' ||
                Array.isArray(item) ||
                Object.keys(item).length !== 2 ||
                typeof item.find !== 'string' ||
                !item.find ||
                typeof item.replace !== 'string',
            ))
        )
          throw new Error('invalid patch');
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
          let text = '';
          let bytes = 0;
          for (const character of buffered) {
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
      err(`${error.message}\n\n${cliHelp()}\n`);
      return 2;
    }
    err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
if (import.meta.main) process.exitCode = await runCli(process.argv.slice(2));
