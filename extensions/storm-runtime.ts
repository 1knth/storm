import { isAbsolute, relative, resolve } from 'node:path';
import { quizIntegrationCompatibilityError } from '../src/shared/quizIntegrationVersion';
import { quizLearningFromRequest } from '../src/shared/quizProtocol';

/** New Tutor questions require deliberate metadata; direct legacy protocol clients remain compatible. */
export function validateTutorQuestionLearning(
  request: Record<string, unknown>,
): void {
  const learning = quizLearningFromRequest(request);
  if (
    learning === null ||
    (learning && request.support === undefined) ||
    (!learning && typeof request.unmodelledReason !== 'string')
  )
    throw new Error(
      'Question requires complete concepts, level, and support tags, or an explicit unmodelledReason without tags.',
    );
}

export function assertQuizCapabilities(value: unknown): void {
  const error = quizIntegrationCompatibilityError(value);
  if (error)
    throw new Error(
      `${error} Update the installed Storm app/CLI before attaching this Tutor extension.`,
    );
}

export type QuizEvent = {
  cursor: number;
  type: string;
  [key: string]: unknown;
};

import {
  quizAgentEvent,
  quizAgentQuestion,
  quizAgentSession,
} from '../src/shared/quizAgentContext';

export function modelSession(
  session: Record<string, unknown>,
): Record<string, any> {
  return quizAgentSession(session);
}

/**
 * Write results stay in the conversation for good, so they carry only what the
 * tutor needs next (revision, cursors and the stored question/prompt order),
 * not the lesson map, notes or scope it already holds. status returns those.
 */
export function writeAck(
  session: Record<string, unknown>,
): Record<string, any> {
  const {
    lessonMap: _lessonMap,
    tutorNotes: _tutorNotes,
    scope: _scope,
    ...rest
  } = modelSession(session);
  return rest;
}

/**
 * Learner reads list every concept with the same flag set, mostly false or
 * null. Omitting those defaults keeps every value recoverable.
 */
export function compactLearnerState(state: unknown): unknown {
  if (
    !state ||
    typeof state !== 'object' ||
    !Array.isArray((state as any).concepts)
  )
    return state;
  const value = state as Record<string, any>;
  return {
    ...value,
    conceptDefaults:
      'Concept fields that are false or null are omitted: a missing flag means false, a missing value means none yet (null).',
    concepts: value.concepts.map((concept: unknown) =>
      concept && typeof concept === 'object'
        ? Object.fromEntries(
            Object.entries(concept).filter(
              ([, item]) => item !== false && item !== null,
            ),
          )
        : concept,
    ),
  };
}

export function modelEvent(event: QuizEvent): Record<string, unknown> {
  return quizAgentEvent(event);
}

export function learnerNotification(
  events: QuizEvent[],
  currentQuestion: unknown,
  images: Array<{ path: string; mimeType: string }> = [],
  context: Record<string, unknown> = {},
): string {
  const compact = events.map(modelEvent);
  const isContinue =
    compact.length > 0 && compact.every((event) => event.type === 'continue');
  const attachments = images.length
    ? ` Attached images: ${JSON.stringify(images)}. Read these attached images with your local image-reading tool before responding; files are temporary.`
    : '';
  return `Storm quiz learner activity (preserve exact learner messages and reasoning; advance only after explicit Continue, Skip, or a learner request to skip/clear/replace): ${JSON.stringify({ ...context, events: compact, ...(isContinue ? {} : { currentQuestion: quizAgentQuestion(currentQuestion) }) })}${attachments}`;
}

export function attachPrompt(
  session: Record<string, unknown>,
  context: Record<string, unknown> = {},
): string {
  return `Storm quiz attachment: ${JSON.stringify({ ...modelSession(session), ...context })}`;
}

export function attachStateMessage(status: unknown): string {
  if (status === 'connected')
    return 'This quiz is already connected. If a previous Pi extension left it attached, use Storm’s Stop agent control once, then attach again. Do not reset or take over an active session.';
  if (status === 'complete')
    return 'This quiz is complete and cannot be attached. Choose a waiting quiz session.';
  return 'Storm rejected the quiz attach because its state does not allow attaching. Check the quiz status in Storm.';
}

function responseError(response: any): never {
  const error = response?.error ?? response?.result?.error;
  // Storm explains rejections it can act on (map, mastery, test rules).
  const detail = response?.result?.message;
  const failure = new Error(
    typeof error?.message === 'string'
      ? error.message
      : typeof detail === 'string'
        ? detail
        : typeof error === 'string'
          ? error
          : 'Storm quiz request failed.',
  );
  Object.assign(failure, {
    code: typeof error === 'string' ? error : error?.code,
  });
  throw failure;
}

/** Decode CLI operations whose successful broker response contains result.value. */
export function responseValue(response: any): any {
  if (response?.ok !== true) responseError(response);
  const result = response.result;
  if (result?.ok === false) responseError(response);
  if (result?.ok !== true || result.value === undefined)
    throw new Error('Storm quiz response did not include result.value.');
  return result.value;
}

/** `quiz status` maps to the broker's snapshot operation, whose CLI output
 * deliberately exposes `snapshot` at the top level rather than result.value. */
export function snapshotValue(response: any): any {
  if (response?.ok !== true) responseError(response);
  if (response.operation !== 'snapshot' || !response.snapshot?.session)
    throw new Error(
      'Storm quiz snapshot response did not include snapshot.session.',
    );
  return response.snapshot;
}

export type WaitResult<T> = {
  value?: T;
  cursor?: number;
  timedOut?: boolean;
  disconnected?: boolean;
};

export type WaitBoundary<T> = {
  spawnWait(
    after: number,
    token: string,
  ): { kill(): void; result: Promise<WaitResult<T>> };
  deliver(value: T): void | Promise<void>;
  retryDelays?: number[];
  onError?(
    error: unknown,
    state?: { retrying: boolean; attempt: number },
  ): void;
  isConfirmedDisconnect?(error: unknown): boolean;
  onDisconnect?(reason?: 'revoked' | 'disconnected'): void;
};

/** Parse the actual `quiz wait` CLI envelope. Older/current CLI builds may emit a
 * literal `\\n` suffix on learner-event responses; accept that framing typo. */
export function parseWaitResponse<
  T extends {
    session: { eventCursor: number; status: string; [key: string]: unknown };
    events: Array<{ cursor: number; type: string; [key: string]: unknown }>;
  } = {
    session: { eventCursor: number; status: string; [key: string]: unknown };
    events: Array<{ cursor: number; type: string; [key: string]: unknown }>;
  },
>(responseText: string): WaitResult<T> {
  const json = responseText.trim().replace(/\\n$/, '');
  const response = JSON.parse(json);
  const snapshot = response?.snapshot;
  if (!response?.ok || !snapshot?.session || !Array.isArray(snapshot.events))
    throw new Error('invalid wait response');
  return {
    value: snapshot as T,
    cursor: Number(response.after ?? snapshot.session.eventCursor) || 0,
    timedOut: response.timedOut,
    disconnected:
      response.disconnected ||
      ['complete', 'disconnected'].includes(snapshot.session.status),
  };
}

/** One waiter, ordered async delivery, and bounded local retry. No idle model calls. */
export function createWaitRuntime<T>(boundary: WaitBoundary<T>) {
  let generation = 0;
  let child: { kill(): void } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = false;
  let health: 'stopped' | 'running' | 'retrying' | 'failed' = 'stopped';
  function stop() {
    generation++;
    active = false;
    health = 'stopped';
    if (timer) clearTimeout(timer);
    timer = undefined;
    const pending = child;
    child = undefined;
    pending?.kill();
  }
  function start(cursor: number, token: string) {
    if (active) return stop;
    active = true;
    health = 'running';
    const ownGeneration = ++generation;
    let attempt = 0;
    const current = () => active && generation === ownGeneration;
    const fail = (error: unknown, after: number) => {
      if (!current()) return;
      child = undefined;
      if (boundary.isConfirmedDisconnect?.(error)) {
        stop();
        boundary.onDisconnect?.('revoked');
        return;
      }
      const delay = (boundary.retryDelays ?? [250, 1000, 3000])[attempt++];
      if (delay === undefined) {
        active = false;
        health = 'failed';
        boundary.onError?.(error, { retrying: false, attempt });
        return;
      }
      health = 'retrying';
      boundary.onError?.(error, { retrying: true, attempt });
      timer = setTimeout(() => {
        timer = undefined;
        if (current()) arm(after);
      }, delay);
      timer.unref?.();
    };
    const arm = (after: number) => {
      if (!current()) return;
      let process: { kill(): void; result: Promise<WaitResult<T>> };
      try {
        process = boundary.spawnWait(after, token);
      } catch (error) {
        fail(error, after);
        return;
      }
      child = process;
      void process.result
        .then((result) => {
          if (!current() || child !== process) return;
          child = undefined;
          if (result.disconnected) {
            stop();
            boundary.onDisconnect?.('disconnected');
            return;
          }
          const next = () => {
            if (current()) {
              attempt = 0;
              health = 'running';
              arm(result.cursor ?? after);
            }
          };
          if (result.timedOut) {
            next();
            return;
          }
          const delivery =
            result.value === undefined
              ? undefined
              : boundary.deliver(result.value);
          if (delivery && typeof delivery.then === 'function')
            return delivery.then(next);
          next();
        })
        .catch((error) => fail(error, after));
    };
    arm(cursor);
    return stop;
  }
  return {
    start,
    stop,
    get health() {
      return health;
    },
  };
}

type ContextMessage = { role?: string; [key: string]: any };

/** Messages before this boundary may be stubbed; it moves in steps so the
 * provider's prompt cache breaks once per step, not on every call. */
export const STORM_PRUNE_STEP = 24;

/** Structured metadata stays in the saved Pi session; projection never parses prose.
 * Full state is retained on disk and restored whenever an earlier message is removed.
 */
export type StormContextDetails = {
  storm: {
    kind: 'attach' | 'status' | 'learner';
    sessionId: string;
    scopeKey?: string;
    complete?: boolean;
    value: Record<string, any>;
  };
};

export function projectStormContext<T extends ContextMessage>(
  messages: T[],
): T[] {
  const held = new Map<string, string>();
  const latest = new Map<string, number>();
  const boundary =
    Math.floor(messages.length / STORM_PRUNE_STEP) * STORM_PRUNE_STEP;
  const key = (detail: StormContextDetails['storm']) =>
    `${detail.kind}:${detail.sessionId}:${detail.scopeKey ?? ''}`;
  messages.slice(0, boundary).forEach((message, index) => {
    const detail = message.details?.storm as
      | StormContextDetails['storm']
      | undefined;
    if (
      detail &&
      detail.kind !== 'attach' &&
      detail.complete &&
      !message.isError &&
      !detail.value.studyContextChanged
    )
      latest.set(key(detail), index);
  });
  let changed = false;
  const result = messages.map((message, index) => {
    const detail = message.details?.storm as
      | StormContextDetails['storm']
      | undefined;
    if (!detail) return message;
    if (detail.kind === 'attach') {
      const signature = JSON.stringify(detail.value);
      const previous = held.get(key(detail));
      held.set(key(detail), signature);
      if (previous !== signature) return message;
      changed = true;
      return {
        ...message,
        content: `Storm quiz attachment unchanged; current state is retained in the earlier attachment for ${detail.sessionId}.`,
      };
    }
    if (
      index < (latest.get(key(detail)) ?? -1) &&
      !detail.value.studyContextChanged
    ) {
      changed = true;
      return {
        ...message,
        content: [
          {
            type: 'text',
            text: `Earlier storm ${detail.kind} result superseded. Read status or learner for current state.`,
          },
        ],
      };
    }
    return message;
  });
  return changed ? result : messages;
}

const READER_FALLBACK =
  'storm_study reads Markdown notes only. These files are still course material in scope: open each at its path joined to root (or at the absolute paths in files) with your own file tools and skills (for example a pdf or docx skill, pdftotext, or image reading). If one approach fails, try another before telling the learner a file is unreadable. Material read this way has no snapshotId: for a question grounded only in it, set externalSource to its absolute path instead of studyBasis, and record that path in your notes so a later session knows the source.';

/**
 * Points the tutor at files storm_study listed but could not read, with
 * absolute paths, so it falls back to its own readers instead of skipping them.
 */
export function withReaderFallback(
  value: Record<string, any>,
  root: string | undefined,
): Record<string, any> {
  const issues: Array<{ path?: string; reason?: string }> = Array.isArray(
    value?.issues,
  )
    ? value.issues
    : [];
  const unreadable = [
    ...new Set(
      issues
        .filter((issue) => issue?.reason === 'reader-unavailable' && issue.path)
        .map((issue) => issue.path!),
    ),
  ];
  const hasOtherFiles =
    Array.isArray(value?.entries) &&
    value.entries.some(
      (entry: any) =>
        entry?.kind && !['note', 'directory'].includes(entry.kind),
    );
  if (!root || (!unreadable.length && !hasOtherFiles)) return value;
  const absolute = (path: string) => `${root.replace(/\/+$/, '')}/${path}`;
  return {
    ...value,
    readerFallback: {
      root,
      // Trees carry the full guidance; retrieve results repeat it too often.
      ...(Array.isArray(value?.entries) ? { guidance: READER_FALLBACK } : {}),
      ...(unreadable.length ? { files: unreadable.map(absolute) } : {}),
    },
  };
}

/**
 * externalSource stands in for studyBasis only for a file Storm cannot read:
 * an absolute, non-Markdown path inside the attached vault. It is the tutor's
 * claim about its source, not an access boundary.
 */
export function externalSourceAllowed(
  path: string,
  root: string | undefined,
): boolean {
  if (!root || !isAbsolute(path) || /\.(md|markdown)$/i.test(path))
    return false;
  const inside = relative(resolve(root), resolve(path));
  return !!inside && !inside.startsWith('..') && !isAbsolute(inside);
}

/** Compatibility name for the session measurement script. */
export const pruneStormContext = projectStormContext;
