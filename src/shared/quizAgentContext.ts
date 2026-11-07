import {
  TUTOR_NOTES_MAX_LENGTH,
  type QuizEvent,
  type QuizQuestion,
} from './quizProtocol';

const encoder = new TextEncoder();
export const QUIZ_CONTEXT_BYTES = 24_000;
export const QUIZ_EVENT_PAGE_SIZE = 32;
export const QUIZ_EVENT_PAGE_BYTES = 64_000;

const object = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
const pick = (value: unknown, fields: string[]) => {
  const source = object(value);
  return Object.fromEntries(
    fields.filter((key) => key in source).map((key) => [key, source[key]]),
  );
};
const strings = (value: unknown) =>
  Object.fromEntries(
    Object.entries(object(value)).filter(
      ([, item]) => typeof item === 'string',
    ),
  );
const items = (value: unknown) =>
  Array.isArray(value)
    ? value.map((item) => pick(item, ['id', 'text', 'effect']))
    : [];
export const quizJsonBytes = (value: unknown) =>
  encoder.encode(JSON.stringify(value)).length;

/** Schema allowlists protect capabilities without interpreting learner map IDs as field names. */
export function quizAgentQuestion(value: unknown): Record<string, any> | null {
  if (!value || typeof value !== 'object') return null;
  const source = object(value);
  const result = pick(source, [
    'id',
    'kind',
    'prompt',
    'text',
    'status',
    'feedback',
    'verdict',
    'studyBasis',
    'suppliedSupport',
    'gradedAt',
    'unmodelledReason',
    'testId',
    'reasoning',
  ]);
  if (source.omitted) return { ...result, omitted: true, section: 'question' };
  if (source.learning) {
    const learning = object(source.learning);
    result.learning = {
      concepts: Array.isArray(learning.concepts)
        ? learning.concepts.filter((item: unknown) => typeof item === 'string')
        : [],
      ...pick(learning, ['level', 'support']),
    };
  }
  if (source.choices) result.choices = items(source.choices);
  if (source.leftItems) result.leftItems = items(source.leftItems);
  if (source.rightItems) result.rightItems = items(source.rightItems);
  // Open fields are UI drafts, not submitted learner evidence.
  if (source.status === 'answered' || source.status === 'feedback') {
    Object.assign(
      result,
      pick(source, [
        'selectedChoiceId',
        'reasoningDraft',
        'textDraft',
        'confidence',
      ]),
    );
    if (source.matchesDraft) result.matchesDraft = strings(source.matchesDraft);
  }
  return result;
}

export function quizAgentPrompt(value: unknown): Record<string, any> | null {
  if (!value || typeof value !== 'object') return null;
  const source = object(value);
  return {
    ...pick(source, ['id', 'kind', 'prompt']),
    ...(source.omitted
      ? { omitted: true, section: 'prompt' }
      : { choices: items(source.choices) }),
  };
}

export function quizAgentEvent(event: {
  type: string;
  [key: string]: unknown;
}): Record<string, any> {
  const source = object(event.data);
  const data: Record<string, any> = pick(source, [
    'text',
    'answer',
    'reasoning',
    'choiceId',
    'promptId',
    'questionId',
    'choiceText',
    'detail',
    'verdict',
    'effect',
    'confidence',
    'support',
  ]);
  if (source.matches) data.matches = strings(source.matches);
  if (source.attachments)
    data.attachments = Array.isArray(source.attachments)
      ? source.attachments.map((item: unknown) =>
          typeof item === 'string'
            ? item
            : pick(item, ['id', 'mimeType', 'size']),
        )
      : [];
  if (source.question) data.question = quizAgentQuestion(source.question);
  if (source.prompt) data.prompt = quizAgentPrompt(source.prompt);
  if (source.omitted)
    Object.assign(data, {
      omitted: true,
      section: 'event',
      cursor: event.cursor,
    });
  return {
    ...pick(event, [
      'cursor',
      'revision',
      'type',
      'createdAt',
      'questionId',
      'promptId',
      'choiceId',
    ]),
    ...(event.type === 'continue' ? {} : { data }),
  };
}

function limited(value: unknown, section: string, budget = QUIZ_CONTEXT_BYTES) {
  if (value === undefined) return undefined;
  if (quizJsonBytes(value) <= budget) return value;
  return {
    ...pick(value, ['id', 'status', 'kind']),
    omitted: true,
    section,
    bytes: quizJsonBytes(value),
  };
}

export function quizAgentSession(
  session: Record<string, any>,
): Record<string, any> {
  const scope =
    typeof session.scope === 'string'
      ? session.scope
      : session.scope
        ? pick(session.scope, [
            'vaultId',
            'notePath',
            'selectedNotePaths',
            'folderPath',
          ])
        : undefined;
  return {
    ...pick(session, [
      'id',
      'revision',
      'eventCursor',
      'status',
      'awaitingAgent',
      'pendingLearnerCursor',
      'respondedThroughCursor',
    ]),
    ...(scope !== undefined ? { scope: limited(scope, 'scope', 4000) } : {}),
    ...(session.lessonMap
      ? {
          lessonMap: limited(
            pick(session.lessonMap, [
              'nodes',
              'edges',
              'goal',
              'statuses',
              'focus',
            ]),
            'lessonMap',
            8000,
          ),
        }
      : {}),
    ...(session.practiceTest
      ? {
          practiceTest: pick(session.practiceTest, [
            'id',
            'concepts',
            'startedAt',
          ]),
        }
      : {}),
    ...(session.tutorNotes
      ? {
          tutorNotes: limited(
            pick(session.tutorNotes, ['text', 'version', 'updatedAt', 'path']),
            'tutorNotes',
            TUTOR_NOTES_MAX_LENGTH * 4 + 200,
          ),
        }
      : {}),
    currentQuestion: limited(
      quizAgentQuestion(session.currentQuestion),
      'question',
    ),
    currentPrompt: limited(
      quizAgentPrompt(session.currentPrompt),
      'prompt',
      8000,
    ),
  };
}

function message(value: unknown) {
  const source = object(value);
  return {
    ...pick(source, ['id', 'role', 'text', 'createdAt', 'kind']),
    ...(source.question
      ? {
          question: {
            ...quizAgentQuestion(source.question),
            ...pick(source.question, [
              'answerLabel',
              'chosenChoiceId',
              'chosenChoiceText',
              'confidence',
            ]),
          },
        }
      : {}),
    ...(source.attachments
      ? {
          attachments: source.attachments.map((item: unknown) =>
            pick(item, ['id', 'mimeType', 'size']),
          ),
        }
      : {}),
  };
}

export function quizHistoryPage(
  transcript: unknown[],
  before = transcript.length,
) {
  const end = Math.min(before, transcript.length);
  const entries: Record<string, any>[] = [];
  let bytes = 0,
    index = end;
  while (index > 0 && entries.length < 12) {
    const entry = { index: index - 1, ...message(transcript[index - 1]) };
    const size = quizJsonBytes(entry);
    if (bytes + size > QUIZ_CONTEXT_BYTES) {
      if (!entries.length) {
        entries.unshift({
          index: index - 1,
          ...pick(entry, ['id', 'role', 'kind']),
          omitted: true,
          section: 'history',
          bytes: size,
        });
        index--;
      }
      break;
    }
    entries.unshift(entry);
    bytes += size;
    index--;
  }
  return {
    entries,
    total: transcript.length,
    before: end,
    nextBefore: index > 0 ? index : null,
    incomplete: index > 0 || entries.some((entry) => entry.omitted),
  };
}

export function quizRecovery(
  session: Record<string, any>,
  events: Array<{ type: string; cursor: number; [key: string]: unknown }>,
) {
  const latestLearner = events.findLast((event) =>
    ['answer', 'message', 'continue', 'respond-prompt', 'skip'].includes(
      event.type,
    ),
  );
  const latestOutput = events.findLast((event) =>
    [
      'pose-question',
      'pose-prompt',
      'feedback',
      'agent-message',
      'skip-question',
    ].includes(event.type),
  );
  const pendingCursor =
    session.pendingLearnerCursor ?? latestLearner?.cursor ?? 0;
  const responded = session.respondedThroughCursor ?? latestOutput?.cursor ?? 0;
  let pendingAction =
    !session.currentQuestion &&
    !session.currentPrompt &&
    !session.transcript?.length
      ? 'start-session'
      : 'wait-for-learner';
  if (session.currentPrompt) pendingAction = 'wait-for-choice';
  else if (session.currentQuestion?.status === 'answered')
    pendingAction = 'feedback';
  else if (session.currentQuestion?.status === 'open')
    pendingAction = 'wait-for-answer';
  else if (session.currentQuestion?.status === 'feedback')
    pendingAction = 'wait-for-continue';
  if (
    !session.currentPrompt &&
    pendingCursor > responded &&
    session.currentQuestion?.status !== 'answered'
  )
    pendingAction =
      latestLearner?.type === 'continue' ||
      latestLearner?.type === 'skip' ||
      object(latestLearner?.data).effect === 'continue'
        ? 'next-question'
        : 'reply';
  return {
    history: quizHistoryPage(
      Array.isArray(session.transcript) ? session.transcript : [],
    ),
    pendingAction,
    pendingLearnerCursor: pendingCursor,
    respondedThroughCursor: responded,
    recentEvents: quizEventPage(
      events
        .filter((event) =>
          ['answer', 'message', 'continue', 'respond-prompt', 'skip'].includes(
            event.type,
          ),
        )
        .slice(-12),
      0,
    ).events,
    historical: true,
  };
}

export function quizEventPage(
  events: Array<{ type: string; cursor: number; [key: string]: unknown }>,
  after: number,
) {
  const page: Record<string, any>[] = [];
  let bytes = 0,
    cursor = after;
  for (const event of events) {
    if (event.cursor <= after) continue;
    let projected = quizAgentEvent(event);
    if (quizJsonBytes(projected) > QUIZ_EVENT_PAGE_BYTES)
      projected = {
        ...pick(event, ['cursor', 'revision', 'type']),
        data: { omitted: true, section: 'event', cursor: event.cursor },
      };
    const size = quizJsonBytes(projected);
    if (
      page.length >= QUIZ_EVENT_PAGE_SIZE ||
      bytes + size > QUIZ_EVENT_PAGE_BYTES
    )
      break;
    page.push(projected);
    bytes += size;
    cursor = event.cursor;
  }
  return {
    events: page,
    after: cursor,
    hasMore: events.some((event) => event.cursor > cursor),
  };
}

/** Oversized JSON is explicitly chunked by Unicode code point; no partial object pretends to be complete. */
export function quizContextChunk(
  session: Record<string, any>,
  events: QuizEvent[],
  section: string,
  before?: number,
  offset = 0,
) {
  let content: unknown;
  if (section === 'history') {
    const index =
      Math.min(before ?? session.transcript.length, session.transcript.length) -
      1;
    content =
      index >= 0 ? { index, ...message(session.transcript[index]) } : null;
  } else if (section === 'question')
    content = quizAgentQuestion(session.currentQuestion);
  else if (section === 'prompt')
    content = quizAgentPrompt(session.currentPrompt);
  else if (section === 'scope')
    content = pick(session.scope, [
      'vaultId',
      'notePath',
      'selectedNotePaths',
      'folderPath',
    ]);
  else content = events.find((event) => event.cursor === before);
  if (section === 'event' && content)
    content = quizAgentEvent(content as QuizEvent);
  const characters = Array.from(JSON.stringify(content ?? null));
  const text = characters.slice(offset, offset + 6000).join('');
  return {
    section,
    before,
    offset,
    format: 'json',
    text,
    nextOffset: offset + 6000 < characters.length ? offset + 6000 : null,
    totalCharacters: characters.length,
  };
}

export function submittedQuizQuestion(
  question: QuizQuestion | null,
): QuizQuestion | null {
  if (!question) return null;
  return {
    ...question,
    ...(question.status === 'open'
      ? {
          selectedChoiceId: null,
          reasoningDraft: '',
          textDraft: undefined,
          matchesDraft: undefined,
        }
      : {}),
  };
}

/** Learner activity that wakes an attached agent, including legacy event names. */
export function isQuizLearnerEvent(event: { type: string }): boolean {
  return (
    /^(answer|message|continue|respond-prompt|skip)$/.test(event.type) ||
    event.type.startsWith('learner-')
  );
}
