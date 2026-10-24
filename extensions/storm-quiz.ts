import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  attachStateMessage,
  createWaitRuntime,
  parseWaitResponse,
  refreshSnapshot,
  responseValue,
  snapshotValue,
  attachPrompt,
  learnerNotification,
  modelSession,
} from './storm-quiz-runtime';

type QuizSnapshot = {
  session: {
    id: string;
    revision: number;
    eventCursor: number;
    status: string;
    scope?: unknown;
    [key: string]: unknown;
  };
  events: QuizEvent[];
};
type QuizEvent = { cursor: number; type: string; [key: string]: unknown };
type QuizState = {
  sessionId: string;
  token: string;
  revision: number;
  cursor: number;
  snapshot: QuizSnapshot['session'];
  stopped: boolean;
  generation: number;
  deliveredImages: Map<string, string>;
  isIdle: () => boolean;
};

function cliConfig(): { executable: string; args: string[] } {
  const executable = process.env.STORM_QUIZ_CLI;
  if (!executable)
    throw new Error(
      'Set STORM_QUIZ_CLI to the Storm CLI executable (for example: bun).',
    );
  let args: unknown = [];
  try {
    args = process.env.STORM_QUIZ_CLI_ARGS
      ? JSON.parse(process.env.STORM_QUIZ_CLI_ARGS)
      : [];
  } catch {
    throw new Error('STORM_QUIZ_CLI_ARGS must be a JSON string array.');
  }
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
    throw new Error('STORM_QUIZ_CLI_ARGS must be a JSON string array.');
  }
  return { executable, args };
}

function cliArgs(operation: string, id: string, after?: number): string[] {
  return [
    'quiz',
    operation,
    id,
    ...(after === undefined ? [] : ['--after', String(after)]),
  ];
}

async function runCli(
  args: string[],
  input?: unknown,
  token?: string,
): Promise<unknown> {
  const config = cliConfig();
  return await new Promise((resolve, reject) => {
    const child = spawn(config.executable, [...config.args, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(token ? { STORM_QUIZ_TOKEN: token } : {}) },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (part: string) => {
      stdout += part;
    });
    // Parse only the structured error code; never expose raw CLI output.
    child.stderr.setEncoding('utf8').on('data', (part: string) => {
      stderr += part;
    });
    child.once('error', () =>
      reject(new Error('Could not start the configured Storm CLI.')),
    );
    child.once('close', (code) => {
      if (code !== 0) {
        let errorCode: unknown;
        try {
          errorCode = JSON.parse(stderr.trim()).error?.code;
        } catch {
          // Keep ordinary CLI failures generic and secret-safe.
        }
        const error = new Error(`Storm CLI exited with ${code ?? 'an error'}.`);
        if (typeof errorCode === 'string')
          Object.assign(error, { code: errorCode });
        return reject(error);
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error('Storm CLI returned invalid JSON.'));
      }
    });
    if (input === undefined) child.stdin.end();
    else child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

function isLearnerActivity(event: QuizEvent): boolean {
  return (
    event.type === 'answer' ||
    event.type === 'message' ||
    event.type === 'continue' ||
    event.type === 'respond-prompt' ||
    event.type.startsWith('learner-')
  );
}

export default function (pi: ExtensionAPI) {
  let state: QuizState | undefined;
  let lastWaitError: string | undefined;
  let waitOwner: QuizState | undefined;
  let pendingQuizTurn: QuizState | undefined;
  // A learner event can arrive while Pi is already in a turn. That turn's
  // agent_end is not the response to the learner event; the queued follow-up
  // starts afterward. Ignore that one end so the thinking indicator survives.
  let ignoreNextAgentEnd = false;
  let activityGeneration = 0;
  let sessionGeneration = 0;
  let activityQueue = Promise.resolve();
  let notifyUi:
    | ((message: string, level: 'info' | 'warning') => void)
    | undefined;

  const publishActivity = (
    owner: QuizState,
    phase: 'thinking' | 'drafting' | 'idle',
  ) => {
    const generation = ++activityGeneration;
    activityQueue = activityQueue.then(async () => {
      if (generation !== activityGeneration || state !== owner || owner.stopped)
        return;
      try {
        await runCli(
          ['quiz', 'activity', owner.sessionId, '--state', phase],
          undefined,
          owner.token,
        );
      } catch {
        // Activity is best-effort UI telemetry and never blocks tutoring.
      }
    });
  };

  const waitRuntime = createWaitRuntime<QuizSnapshot>({
    spawnWait(after, token) {
      const config = cliConfig();
      const child = spawn(
        config.executable,
        [...config.args, ...cliArgs('wait', state!.sessionId, after)],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, STORM_QUIZ_TOKEN: token },
        },
      );
      let output = '';
      let errorOutput = '';
      child.stdout.setEncoding('utf8').on('data', (part: string) => {
        output += part;
      });
      child.stderr.setEncoding('utf8').on('data', (part: string) => {
        errorOutput += part;
      });
      return {
        kill: () => child.kill(),
        result: new Promise((resolve, reject) => {
          child.once('error', () => reject(new Error('wait process error')));
          child.once('close', (code) => {
            if (code !== 0 || !output.trim()) {
              let errorCode: unknown;
              try {
                errorCode = JSON.parse(errorOutput.trim()).error?.code;
              } catch {
                // Do not infer revocation from arbitrary stderr text.
              }
              const revoked = errorCode === 'INVALID_REQUEST';
              const deleted = errorCode === 'SESSION_NOT_FOUND';
              const error = new Error(
                deleted
                  ? 'wait not-found'
                  : revoked
                    ? 'wait unauthorized'
                    : 'wait failed',
              );
              return reject(error);
            }

            try {
              resolve(parseWaitResponse<QuizSnapshot>(output));
            } catch {
              reject(new Error('invalid wait JSON'));
            }
          });
        }),
      };
    },
    onError() {
      lastWaitError = 'listener failed; use status or reconnect';
    },
    isConfirmedDisconnect(error) {
      return (
        error instanceof Error &&
        ['wait unauthorized', 'wait not-found'].includes(error.message)
      );
    },
    onDisconnect(reason) {
      const owner = waitOwner;
      if (!owner || state !== owner) return;
      void reconcile(owner, reason);
    },
    deliver(snapshot) {
      lastWaitError = undefined;
      const active = state;
      if (!active || active.stopped) return;
      active.snapshot = snapshot.session;
      active.revision = snapshot.session.revision;
      const previousCursor = active.cursor;
      const events = snapshot.events.filter(
        (event) => event.cursor > previousCursor && isLearnerActivity(event),
      );
      active.cursor = Math.max(
        active.cursor,
        snapshot.session.eventCursor,
        ...snapshot.events.map((event) => Number(event.cursor) || 0),
      );
      if (!events.length) return;
      pendingQuizTurn = active;
      ignoreNextAgentEnd = !active.isIdle();
      publishActivity(active, 'thinking');
      void deliverLearnerEvents(
        active,
        events,
        snapshot.session.currentQuestion,
      );
    },
  });

  const releaseImages = async (owner: QuizState, ids: string[]) => {
    for (const id of ids) {
      if ((state && state !== owner) || owner.generation !== sessionGeneration)
        return;
      if (!owner.deliveredImages.has(id)) continue;
      try {
        responseValue(
          await runCli(
            ['quiz', 'image-release', owner.sessionId, '--image-id', id],
            undefined,
            owner.token,
          ),
        );
        if (
          (!state || state === owner) &&
          owner.generation === sessionGeneration
        )
          owner.deliveredImages.delete(id);
      } catch {
        // Keep the path for retry or detach cleanup; the server applies its TTL.
      }
    }
  };

  const deliverLearnerEvents = async (
    owner: QuizState,
    events: QuizEvent[],
    currentQuestion: unknown,
  ) => {
    const images: Array<{ path: string; mimeType: string }> = [];
    for (const event of events) {
      const data = event.data as Record<string, unknown> | undefined;
      const attachments = Array.isArray(data?.attachments)
        ? data.attachments
        : [];
      const ids = attachments.map((item) =>
        typeof item === 'string'
          ? item
          : item &&
              typeof item === 'object' &&
              typeof (item as Record<string, unknown>).id === 'string'
            ? (item as Record<string, string>).id
            : undefined,
      );
      for (const id of ids) {
        if (typeof id !== 'string' || owner.deliveredImages.has(id)) continue;
        try {
          const value = responseValue(
            await runCli(
              ['quiz', 'image', owner.sessionId, '--image-id', id],
              undefined,
              owner.token,
            ),
          );
          if (
            typeof value.path !== 'string' ||
            typeof value.mimeType !== 'string' ||
            !/^image\/[a-zA-Z0-9.+-]+$/.test(value.mimeType)
          )
            throw new Error('Invalid image metadata');
          if (state !== owner || owner.stopped) return;
          owner.deliveredImages.set(id, value.path);
          images.push({ path: value.path, mimeType: value.mimeType });
        } catch {
          if (state === owner && !owner.stopped)
            notifyUi?.(
              'A learner image is no longer available. Reattach or ask the learner to resend it.',
              'warning',
            );
        }
      }
    }
    if (state !== owner || owner.stopped) return;
    const text = learnerNotification(events, currentQuestion, images);
    pi.sendUserMessage(
      text,
      owner.isIdle() ? undefined : { deliverAs: 'followUp' },
    );
    if (
      images.length &&
      !pi.getActiveTools().some((name) => name === 'read' || name === 'image')
    )
      notifyUi?.(
        'Image path attached; enable an image-reading tool to inspect it. Terminal-only agents may not be able to read images.',
        'warning',
      );
  };

  const removeQuizTool = () => {
    const activeTools = pi.getActiveTools();
    if (activeTools.includes('storm_quiz'))
      pi.setActiveTools(activeTools.filter((name) => name !== 'storm_quiz'));
  };

  const stop = () => {
    const previous = state;
    state = undefined;
    if (previous?.deliveredImages.size)
      void releaseImages(previous, [...previous.deliveredImages.keys()]);
    pendingQuizTurn = undefined;
    ignoreNextAgentEnd = false;
    activityGeneration++;
    if (previous) {
      previous.stopped = true;
      void runCli(
        ['quiz', 'activity', previous.sessionId, '--state', 'idle'],
        undefined,
        previous.token,
      ).catch(() => {});
    }
    waitRuntime.stop();
    return previous;
  };

  const reconcile = async (
    owner: QuizState,
    reason: 'revoked' | 'disconnected',
  ): Promise<boolean> => {
    try {
      const listing = responseValue(await runCli(['quiz', 'list']));
      const matching = Array.isArray(listing)
        ? listing.find((session) => session?.id === owner.sessionId)
        : undefined;
      if (state !== owner) return false;
      if (!matching) {
        // The broker list includes unsaved drafts, so a confirmed not-found
        // wait plus an absent row means the selected session was deleted.
        stop();
        removeQuizTool();
        lastWaitError = undefined;
        forgetToken(owner);
        notifyUi?.('Storm stopped the quiz; Pi detached.', 'info');
        return true;
      }
      if (matching.status === 'connected') {
        lastWaitError = 'listener failed; quiz still connected';
        return false;
      }
      if (
        reason === 'disconnected' &&
        matching &&
        matching.status !== 'disconnected' &&
        matching.status !== 'complete'
      ) {
        lastWaitError = 'listener failed; quiz status changed';
        return false;
      }
      stop();
      removeQuizTool();
      lastWaitError = undefined;
      forgetToken(owner);
      notifyUi?.('Storm stopped the quiz; Pi detached.', 'info');
      return true;
    } catch {
      if (state === owner)
        lastWaitError = 'listener failed; use status or reconnect';
      return false;
    }
  };

  const forgetToken = (owner: QuizState) => {
    owner.token = '';
  };

  const detach = async (previous: QuizState | undefined) => {
    if (!previous) return;
    try {
      responseValue(
        await runCli(
          ['quiz', 'detach', previous.sessionId],
          undefined,
          previous.token,
        ),
      );
    } catch {
      // Storm's GUI Stop rotates the token. Confirm that the backend is no
      // longer connected before treating that expected unauthorized result as done.
      const listing = responseValue(await runCli(['quiz', 'list']));
      const matching = Array.isArray(listing)
        ? listing.find((session) => session?.id === previous.sessionId)
        : undefined;
      if (matching?.status === 'connected')
        throw new Error(
          'Storm did not confirm quiz disconnection; it remains connected.',
        );
      if (!matching)
        throw new Error('Could not confirm quiz disconnection in Storm.');
    }
  };

  const toolSchema = Type.Object({
    action: Type.Union([
      Type.Literal('question'),
      Type.Literal('feedback'),
      Type.Literal('message'),
      Type.Literal('prompt'),
      Type.Literal('status'),
    ]),
    text: Type.Optional(Type.String()),
    kind: Type.Optional(
      Type.Union([
        Type.Literal('multiple-choice'),
        Type.Literal('matching'),
        Type.Literal('short-answer'),
        Type.Literal('long-answer'),
        Type.Literal('next-steps'),
        Type.Literal('clarification'),
      ]),
    ),
    choices: Type.Optional(
      Type.Array(Type.Object({ id: Type.String(), text: Type.String() }), {
        minItems: 1,
        maxItems: 6,
      }),
    ),
    verdict: Type.Optional(
      Type.Union([
        Type.Literal('correct'),
        Type.Literal('incorrect'),
        Type.Literal('partial'),
      ]),
    ),
    promptId: Type.Optional(Type.String()),
    leftItems: Type.Optional(
      Type.Array(Type.Object({ id: Type.String(), text: Type.String() })),
    ),
    rightItems: Type.Optional(
      Type.Array(Type.Object({ id: Type.String(), text: Type.String() })),
    ),
  });

  pi.registerTool({
    name: 'storm_quiz',
    label: 'Storm Quiz',
    description:
      'Operate the explicitly attached Storm quiz. After /storm-quiz attach, use question after Continue, feedback for an answer, message for tutoring chat, prompt with kind next-steps or clarification and 1–6 choices for genuine learner choices, and status to inspect state. Feedback must set its explicit verdict field (correct, partial, or incorrect); Storm displays the verdict and selected option, so do not repeat a verdict heading or selected option in feedback text. Explain why and address supplied reasoning without duplicating Continue instructions. Continue only through explicit Continue. Do not use em dashes in original learner-facing prose; preserve exact source quotations. Format question stems with readable Markdown paragraphs and real newlines, and use structured choices instead of duplicating options in the stem. This tool is available only in the Pi session where the Storm quiz extension is loaded; attaching activates it in that session without changing other active tools.',
    parameters: toolSchema,
    executionMode: 'sequential',
    async execute(_id, params) {
      const active = state;
      if (!active || active.stopped)
        throw new Error(
          'No Storm quiz attached; use /storm-quiz attach SESSION_ID.',
        );
      if (params.action === 'status') {
        let response: unknown;
        try {
          response = await runCli(
            cliArgs('status', active.sessionId),
            undefined,
            active.token,
          );
        } catch (error) {
          if (
            (error as { code?: string })?.code === 'INVALID_REQUEST' ||
            (error as { code?: string })?.code === 'SESSION_NOT_FOUND'
          ) {
            const detached = await reconcile(active, 'revoked');
            if (detached) {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'Storm quiz stopped or detached in Storm; Pi is detached.',
                  },
                ],
                details: { status: 'detached' },
              };
            }
          }
          throw error;
        }
        const snapshot = snapshotValue(response) as QuizSnapshot;
        if (state !== active)
          throw new Error('Storm quiz was detached during the request.');
        const refreshed = refreshSnapshot(active, snapshot);
        return {
          content: [
            { type: 'text', text: JSON.stringify(modelSession(refreshed)) },
          ],
          details: undefined,
        };
      }
      if (typeof params.text !== 'string' || !params.text.trim())
        throw new Error('Provide non-empty text.');
      const consumedImageIds = [...active.deliveredImages.keys()];
      const type =
        params.action === 'question'
          ? 'pose-question'
          : params.action === 'prompt'
            ? 'pose-prompt'
            : params.action === 'feedback'
              ? 'feedback'
              : 'agent-message';
      const fields =
        type === 'pose-question'
          ? {
              question: params.text,
              kind: params.kind ?? 'multiple-choice',
              ...(params.kind === 'matching'
                ? { leftItems: params.leftItems, rightItems: params.rightItems }
                : params.kind === 'short-answer' ||
                    params.kind === 'long-answer'
                  ? {}
                  : { choices: params.choices }),
            }
          : type === 'pose-prompt'
            ? {
                kind: params.kind,
                prompt: params.text,
                choices: params.choices,
                ...(params.promptId ? { promptId: params.promptId } : {}),
              }
            : {
                text: params.text,
                ...(params.verdict ? { verdict: params.verdict } : {}),
              };
      const result = responseValue(
        await runCli(
          cliArgs('request', active.sessionId),
          {
            type,
            expectedRevision: active.revision,
            idempotencyKey: randomUUID(),
            ...fields,
          },
          active.token,
        ),
      );
      if (state !== active)
        throw new Error('Storm quiz was detached during the request.');
      if (typeof result.revision === 'number')
        active.revision = result.revision;
      await releaseImages(active, consumedImageIds);
      active.snapshot = result;
      return {
        content: [{ type: 'text', text: `Storm quiz updated (${type}).` }],
        details: { revision: result.revision },
      };
    },
  });

  pi.registerCommand('storm-quiz', {
    description: 'Attach/status/disconnect an existing Storm quiz session',
    handler: async (args, ctx) => {
      const [action, id] = args.trim().split(/\s+/, 2);
      try {
        if (action === 'disconnect') {
          const previous = stop();
          await detach(previous);
          ctx.ui.notify('Storm quiz detached.', 'info');
          return;
        }
        if (action === 'status') {
          if (!state) throw new Error('No Storm quiz attached.');
          ctx.ui.notify(
            `Quiz ${state.sessionId}: revision ${state.revision}, cursor ${state.cursor}; listener ${lastWaitError ?? 'running'}; storm_quiz ${pi.getActiveTools().includes('storm_quiz') ? 'active' : 'inactive'}.`,
            lastWaitError || !pi.getActiveTools().includes('storm_quiz')
              ? 'warning'
              : 'info',
          );
          return;
        }
        if (action !== 'attach' || !id)
          throw new Error(
            'Usage: /storm-quiz attach SESSION_ID | status | disconnect',
          );
        await detach(stop());
        let attached: any;
        try {
          attached = responseValue(await runCli(cliArgs('attach', id)));
        } catch (error) {
          if (error instanceof Error && error.message === 'invalid-state') {
            let status: unknown;
            try {
              const listing = responseValue(await runCli(['quiz', 'list']));
              const matching = Array.isArray(listing)
                ? listing.find((session) => session?.id === id)
                : undefined;
              status = matching?.status;
            } catch {
              // Keep the attach error actionable even if the read-only lookup fails.
            }
            throw new Error(attachStateMessage(status));
          }
          throw error;
        }
        const snapshot = attached.snapshot as QuizSnapshot | undefined;
        if (
          typeof attached.agentToken !== 'string' ||
          !attached.agentToken ||
          !snapshot?.session
        )
          throw new Error(
            'Attach response did not include a quiz capability and snapshot.',
          );
        const activeTools = pi.getActiveTools();
        if (!activeTools.includes('storm_quiz')) {
          pi.setActiveTools([...activeTools, 'storm_quiz']);
        }
        state = {
          sessionId: id,
          token: attached.agentToken,
          revision: snapshot.session.revision,
          cursor: snapshot.session.eventCursor,
          snapshot: snapshot.session,
          stopped: false,
          generation: ++sessionGeneration,
          deliveredImages: new Map(),
          isIdle: ctx.isIdle,
        };
        const active = state;
        notifyUi = (message, level) => ctx.ui.notify(message, level);
        ctx.ui.notify(`Attached to Storm quiz ${id}.`, 'info');
        const prompt = attachPrompt(snapshot.session);
        pi.sendUserMessage(
          prompt,
          ctx.isIdle() ? undefined : { deliverAs: 'followUp' },
        );
        waitOwner = active;
        waitRuntime.start(active.cursor, active.token);
      } catch (error) {
        stop();
        ctx.ui.notify(
          error instanceof Error
            ? error.message
            : 'Storm quiz operation failed.',
          'error',
        );
      }
    },
  });

  pi.on('agent_start', () => {
    const active = pendingQuizTurn;
    if (active && state === active) publishActivity(active, 'thinking');
  });
  pi.on('tool_execution_start', (event) => {
    const active = pendingQuizTurn;
    if (
      active &&
      state === active &&
      event.toolName === 'storm_quiz' &&
      event.args?.action !== 'status'
    ) {
      publishActivity(active, 'drafting');
    }
  });
  pi.on('agent_end', () => {
    if (ignoreNextAgentEnd) {
      ignoreNextAgentEnd = false;
      return;
    }
    const active = pendingQuizTurn;
    pendingQuizTurn = undefined;
    if (active && state === active) publishActivity(active, 'idle');
  });

  pi.on('session_before_switch', async () => {
    const previous = stop();
    await detach(previous);
  });
  pi.on('session_shutdown', async () => {
    const previous = stop();
    await detach(previous);
  });
}
