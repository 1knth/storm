#!/usr/bin/env bun
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import {
  readAgentEndpoint,
  sendAgentRequest,
  type AgentEndpointInfo,
} from '../src/main/agentEndpoint';
import type { AgentRequest } from '../src/shared/agentProtocol';
import { helpText, knownCommands } from './stormHelp';

class CliUsageError extends Error {}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0)!;
    return code < 32 || (code >= 127 && code <= 159);
  });
}

export async function runCli(
  args: string[],
  io: {
    stdin?: AsyncIterable<Uint8Array>;
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
        .find((arg) => knownCommands.includes(arg));
      out(`${helpText(command)}\n`);
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
        arg !== '--name'
      ) {
        throw new CliUsageError(`Unknown option: ${arg}`);
      } else rest.push(arg);
    }
    const command = rest[0];
    if (!command) {
      out(`${helpText()}\n`);
      return 0;
    }
    if (!knownCommands.includes(command))
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
    if (command === 'connect' && (rest.length !== 3 || rest[2] !== '--json'))
      throw new CliUsageError('connect requires ABS_PATH --json');
    if (command === 'stream' && (rest.length !== 3 || rest[2] !== '--stdin'))
      throw new CliUsageError('stream requires SESSION --stdin');
    if (
      command === 'status' &&
      (rest.length > 3 || (rest[2] && rest[2] !== '--json'))
    )
      throw new CliUsageError('status accepts at most SESSION [--json]');
    if ((command === 'finish' || command === 'cancel') && rest.length !== 2)
      throw new CliUsageError(`${command} requires SESSION`);
    const endpoint =
      endpointPath ??
      (profileName
        ? `${process.env.HOME}/.storm/${profileName}/storm-agent.json`
        : `${process.env.HOME}/.storm/storm-agent.json`);
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
    if (command === 'connect' && rest[1] && rest[2] === '--json')
      result = await request({
        type: 'connect',
        absolutePath: rest[1],
        ...(agentName ? { name: agentName } : {}),
      });
    else if (command === 'status') {
      const sessionId = rest[1] === '--json' ? undefined : rest[1];
      result = await request({
        type: 'status',
        ...(sessionId ? { sessionId } : {}),
      });
    } else if (command === 'finish' || command === 'cancel')
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
      const input = stdin[Symbol.asyncIterator]();
      const stopInput = () => {
        void input.return?.();
        // Bun's process.stdin async iterator can retain the event loop even
        // after return(); destroy the CLI-owned Node stdin stream to release it.
        if (stdin === process.stdin && 'destroy' in stdin)
          (stdin as NodeJS.ReadStream).destroy();
      };
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
          const status = (await request({ type: 'status', sessionId })) as any;
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
    } else throw new CliUsageError(`Invalid arguments for ${command}`);
    if ((result as any)?.ok === false) {
      err(`${JSON.stringify(result)}\n`);
      return 1;
    }
    out(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof CliUsageError) {
      err(`${error.message}\n\n${helpText()}\n`);
      return 2;
    }
    err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
if (import.meta.main) process.exitCode = await runCli(process.argv.slice(2));
