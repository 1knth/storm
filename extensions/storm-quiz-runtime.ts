export type QuizEvent = {
  cursor: number;
  type: string;
  [key: string]: unknown;
};

const SAFE_SESSION_FIELDS = [
  'id',
  'revision',
  'eventCursor',
  'status',
  'scope',
  'currentQuestion',
] as const;
const SAFE_EVENT_FIELDS = [
  'cursor',
  'type',
  'questionId',
  'promptId',
  'choiceId',
  'data',
] as const;

function withoutSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSecrets);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(
        ([key]) =>
          !/token|secret|auth|credential|idempotency|requestid/i.test(key),
      )
      .map(([key, item]) => [key, withoutSecrets(item)]),
  );
}

export function modelSession(
  session: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    SAFE_SESSION_FIELDS.filter((key) => key in session).map((key) => [
      key,
      withoutSecrets(session[key]),
    ]),
  );
}

export function modelEvent(event: QuizEvent): Record<string, unknown> {
  const isContinue = event.type === 'continue';
  return Object.fromEntries(
    SAFE_EVENT_FIELDS.filter(
      (key) => key in event && !(isContinue && key === 'data'),
    ).map((key) => [key, withoutSecrets(event[key])]),
  );
}

export function learnerNotification(
  events: QuizEvent[],
  currentQuestion: unknown,
  images: Array<{ path: string; mimeType: string }> = [],
): string {
  const compact = events.map(modelEvent);
  const isContinue =
    compact.length > 0 && compact.every((event) => event.type === 'continue');
  const attachments = images.length
    ? ` Attached images: ${JSON.stringify(images)}. Read these attached images with your local image-reading tool before responding; files are temporary.`
    : '';
  return `Storm quiz learner activity (preserve exact learner messages and reasoning; do not advance without Continue): ${JSON.stringify({ events: compact, ...(isContinue ? {} : { currentQuestion: withoutSecrets(currentQuestion) }) })}${attachments}`;
}

export function attachPrompt(session: Record<string, unknown>): string {
  const scoped = session.scope !== undefined && session.scope !== null;
  const contextGuidance = scoped
    ? 'Use the explicitly supplied quiz scope as context, while honoring the learner’s own sources and instructions.'
    : 'No study scope was supplied. Do not invent a note, folder, or source location. Use context and sources the learner has already provided; otherwise ask what they are studying and what material they want to use. You may use registered Storm CLI discovery tools if useful, but do not assume or search the entire vault implicitly.';
  return `You are tutoring in an explicitly attached Storm quiz. Initial quiz state: ${JSON.stringify(modelSession(session))}. ${contextGuidance} Learner activity arrives incrementally; use storm_quiz(status) for current state. Preserve exact learner messages and reasoning, and continue only after explicit Continue.

In original learner-facing questions, feedback, and messages, do not use em dashes. Prefer periods, commas, or parentheses. Preserve exact source quotations when necessary, including their punctuation, but do not introduce em dashes into your own prose.

When giving answer feedback, set the explicit verdict field to correct, partial, or incorrect. Storm displays the verdict icon and the learner's selected option, so do not repeat a verdict heading or restate the selected option in the feedback text. Explain the key point in a short, separate paragraph, then address the learner's supplied reasoning specifically when useful. Never invent or echo empty reasoning. For matching, discuss the submitted mappings; for short/long answers, address the learner's exact text and reasoning. Do not add a separate Continue instruction; Storm renders the Continue button.
Add a correction or example only when it helps. Keep the explicit Continue gate. For genuine learner choices about next steps or clarification, use the prompt action with kind next-steps or clarification and 1–6 structured choices, not prose-simulated options. Only make a choice advance the question when it is an explicit Continue action; otherwise wait for the learner's next action. When posing any question type (multiple-choice with 1–6 choices, matching with 2–12 pairs, short-answer, or long-answer), format the question text for easy reading: keep brief setup/context in its own paragraph; put a prose quotation on its own line/paragraph and use semantic Markdown emphasis (for example, italicize a quoted claim), not inline code unless it is literal code; put the actual question in a separate paragraph and use bold sparingly for key contrast terms. Use real newline characters and blank lines between Markdown paragraphs—not the literal characters \\n, doubled escapes, or a fenced block around ordinary prose. Example question text (the line breaks and blank lines are intentional):\n\nA writer argues,\n\n*“The college should extend evening library hours.”*\n\nWhich addition identifies an exception, a **circumstance** in which that recommendation might not apply, rather than **evidence**, a **warrant**, or a **qualifier**?\n\nUse the structured choices/items fields for answer options; do not duplicate choices inside the prompt. Use appropriate inline/display LaTeX syntax for math. Keep explanations as thorough as the material requires. Do not artificially shorten useful teaching. Preserve source grounding and exact source quotations; make stems coherent and concise rather than adding artificial pacing or unnecessary context. Never assume hidden answer keys or auto-grade arbitrary text; judge answers against the supplied study context and explain uncertainty.

For ordinary tutoring chat, respond naturally and proportionately. Substantial teaching is welcome when useful; do not force quiz pacing or feedback sections onto chat.`;
}

export function attachStateMessage(status: unknown): string {
  if (status === 'connected')
    return 'This quiz is already connected. If a previous Pi extension left it attached, use Storm’s Stop agent control once, then attach again. Do not reset or take over an active session.';
  if (status === 'complete')
    return 'This quiz is complete and cannot be attached. Choose a waiting quiz session.';
  return 'Storm rejected the quiz attach because its state does not allow attaching. Check the quiz status in Storm.';
}

export function refreshSnapshot<
  T extends { revision: number },
  S extends { session: T },
>(state: { revision: number; snapshot: T }, snapshot: S): T {
  state.snapshot = snapshot.session;
  state.revision = snapshot.session.revision;
  // Snapshot eventCursor is not a delivered-event cursor. Only the waiter may
  // advance that cursor after it has delivered learner activity.
  return state.snapshot;
}

function responseError(response: any): never {
  const error = response?.error ?? response?.result?.error;
  throw new Error(
    typeof error?.message === 'string'
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Storm quiz request failed.',
  );
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
  deliver(value: T): void;
  onError?(error: unknown): void;
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

/** Owns one serial long-poll chain. No timer or model invocation is used to re-arm it. */
export function createWaitRuntime<T>(boundary: WaitBoundary<T>) {
  let generation = 0;
  let child: { kill(): void } | undefined;
  let active = false;

  function stop() {
    generation++;
    active = false;
    const pending = child;
    child = undefined;
    pending?.kill();
  }

  function start(cursor: number, token: string) {
    if (active) return stop;
    active = true;
    const ownGeneration = ++generation;
    const arm = (after: number) => {
      if (!active || generation !== ownGeneration) return;
      let process: { kill(): void; result: Promise<WaitResult<T>> };
      try {
        process = boundary.spawnWait(after, token);
      } catch (error) {
        stop();
        boundary.onError?.(error);
        return;
      }
      child = process;
      // Resolves only when the subprocess exits; timeout responses re-arm serially.
      void process.result
        .then((result) => {
          if (!active || generation !== ownGeneration || child !== process)
            return;
          child = undefined;
          if (result.disconnected) {
            stop();
            boundary.onDisconnect?.('disconnected');
            return;
          }
          if (result.timedOut) return arm(after);
          if (result.value !== undefined) boundary.deliver(result.value);
          arm(result.cursor ?? after);
        })
        .catch((error) => {
          if (!active || generation !== ownGeneration) return;
          stop();
          if (boundary.isConfirmedDisconnect?.(error))
            boundary.onDisconnect?.('revoked');
          else boundary.onError?.(error);
        });
    };
    arm(cursor);
    return stop;
  }

  return { start, stop };
}
