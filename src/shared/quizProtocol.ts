/** Stable shared contract for persistent quiz sessions and external quiz agents. */
export type QuizScope = {
  vaultId: string;
  notePath: string | null;
  selectedNotePaths: string[];
  folderPath: string | null;
};

export type QuizChoice = { id: string; text: string };
export type QuizPromptChoice = QuizChoice & { effect?: 'continue' };
export type QuizChoicePrompt = {
  id: string;
  kind: 'next-steps' | 'clarification';
  prompt: string;
  choices: QuizPromptChoice[];
  selectedChoiceId?: string;
  detailDraft?: string;
};
export type QuizMatchItem = { id: string; text: string };
export type QuizQuestionKind =
  | 'multiple-choice'
  | 'matching'
  | 'short-answer'
  | 'long-answer';
/** Ordinal task demand used by the learner model; difficulty attaches to levels, not generated items. */
export type QuizCognitiveLevel = 'recall' | 'explain' | 'apply' | 'transfer';
export const QUIZ_COGNITIVE_LEVELS: readonly QuizCognitiveLevel[] = [
  'recall',
  'explain',
  'apply',
  'transfer',
];
/** Help offered with the task. Assisted success locates the zone of proximal development. */
export type QuizSupport = 'independent' | 'hinted' | 'worked';
export const QUIZ_SUPPORTS: readonly QuizSupport[] = [
  'independent',
  'hinted',
  'worked',
];
/** Stable lowercase concept slug, e.g. `while-loop-condition`. */
export const QUIZ_CONCEPT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const QUIZ_MAX_CONCEPTS = 3;
/** Agent-declared concept metadata. Untagged rated answers still inform calibration. */
export type QuizLearning = {
  concepts: string[];
  level: QuizCognitiveLevel;
  support: QuizSupport;
};
export function isQuizConfidence(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 100;
}
export type QuizQuestion = {
  id: string;
  studyBasis?: string;
  learning?: QuizLearning;
  unmodelledReason?: string;
  /** Strongest help actually supplied before submission, including help after posing. */
  suppliedSupport?: QuizSupport;
  /** Original feedback commit time; stable across reconciliation and later session edits. */
  gradedAt?: string;
  /** Submitted learner confidence (0-100); absent for historical or unrated answers. */
  confidence?: number;
  /** Missing kind denotes a historical multiple-choice question. */
  kind?: QuizQuestionKind;
  prompt: string;
  choices: QuizChoice[];
  leftItems?: QuizMatchItem[];
  rightItems?: QuizMatchItem[];
  matchesDraft?: Record<string, string>;
  textDraft?: string;
  status: 'open' | 'answered' | 'feedback';
  selectedChoiceId: string | null;
  reasoningDraft: string;
  feedback: string | null;
  verdict?: 'correct' | 'incorrect' | 'partial';
};
export type QuizImageReference = {
  id: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  size: number;
};
export type QuizMessage = {
  id: string;
  role: 'learner' | 'agent';
  text: string;
  createdAt: string;
  /** Present for historical posed questions; contains only learner-visible prompt and choices. */
  kind?: 'question' | 'answer';
  /** Image metadata only; raw bytes remain in the main-process memory registry. */
  attachments?: QuizImageReference[];
  question?: {
    id: string;
    studyBasis?: string;
    learning?: QuizLearning;
    unmodelledReason?: string;
    suppliedSupport?: QuizSupport;
    gradedAt?: string;
    confidence?: number;
    kind?: QuizQuestionKind;
    prompt: string;
    choices: QuizChoice[];
    leftItems?: QuizMatchItem[];
    rightItems?: QuizMatchItem[];
    verdict?: 'correct' | 'incorrect' | 'partial';
    answerLabel?: string;
    chosenChoiceId?: string;
    chosenChoiceText?: string;
  };
};
export type QuizSession = {
  id: string;
  /** User-editable display name; absent in older persisted sessions. */
  name?: string;
  /** Secret capability issued at creation; required for agent lifecycle and requests. */
  agentToken: string;
  revision: number;
  eventCursor: number;
  /** Missing when a session was created without a note/folder scope. */
  scope?: QuizScope;
  status: 'waiting-agent' | 'connected' | 'disconnected' | 'complete';
  transcript: QuizMessage[];
  currentQuestion: QuizQuestion | null;
  currentPrompt?: QuizChoicePrompt | null;
  freeChatDraft: string;
  activity?: { state: 'idle' | 'thinking' | 'drafting'; updatedAt: string };
  /** True after accepted learner input until the agent commits a response. */
  awaitingAgent?: boolean;
  /** Durable learner work and response watermark; disconnect only clears UI activity. */
  pendingLearnerCursor?: number;
  respondedThroughCursor?: number;
  createdAt: string;
  updatedAt: string;
};

/** Picker metadata deliberately excludes capabilities, drafts and transcript history. */
export type QuizSessionSummary = Pick<
  QuizSession,
  'id' | 'name' | 'scope' | 'status' | 'createdAt' | 'updatedAt'
>;

export type QuizAgentRequest = (
  | {
      type: 'attach';
      sessionId: string;
      agentToken: string;
      expectedRevision: number;
      idempotencyKey: string;
    }
  | {
      type: 'pose-question';
      studyBasis?: string;
      unmodelledReason?: string;
      /** Optional learner-model metadata; concepts and level must be supplied together. */
      concepts?: string[];
      level?: QuizCognitiveLevel;
      support?: QuizSupport;
      sessionId: string;
      agentToken: string;
      expectedRevision: number;
      idempotencyKey: string;
      question: string;
      choices?: QuizChoice[];
      kind?: QuizQuestionKind;
      leftItems?: QuizMatchItem[];
      rightItems?: QuizMatchItem[];
    }
  | {
      type: 'answer';
      sessionId: string;
      agentToken: string;
      expectedRevision: number;
      idempotencyKey: string;
      choiceId?: string;
      reasoning?: string;
      matches?: Record<string, string>;
      answer?: string;
      confidence?: number;
    }
  | {
      type: 'respond-prompt';
      sessionId: string;
      agentToken: string;
      expectedRevision: number;
      idempotencyKey: string;
      promptId: string;
      choiceId: string;
      detail?: string;
    }
  | {
      type: 'pose-prompt';
      sessionId: string;
      agentToken: string;
      expectedRevision: number;
      idempotencyKey: string;
      kind: 'next-steps' | 'clarification';
      prompt: string;
      choices: QuizPromptChoice[];
      promptId?: string;
    }
  | {
      type: 'agent-message';
      sessionId: string;
      agentToken: string;
      expectedRevision: number;
      idempotencyKey: string;
      text: string;
    }
  | {
      type: 'skip-question';
      sessionId: string;
      agentToken: string;
      expectedRevision: number;
      idempotencyKey: string;
      questionId: string;
      text: string;
    }
  | {
      type: 'support-update';
      sessionId: string;
      agentToken: string;
      expectedRevision: number;
      idempotencyKey: string;
      questionId: string;
      support: QuizSupport;
      /** Help actually displayed to the learner with this update. */
      text: string;
    }
  | {
      type: 'feedback';
      sessionId: string;
      agentToken: string;
      expectedRevision: number;
      idempotencyKey: string;
      text: string;
      verdict?: 'correct' | 'incorrect' | 'partial';
    }
  | {
      type: 'skip';
      sessionId: string;
      agentToken: string;
      expectedRevision: number;
      idempotencyKey: string;
      questionId: string;
    }
  | {
      type: 'continue';
      sessionId: string;
      agentToken: string;
      expectedRevision: number;
      idempotencyKey: string;
    }
  | {
      type: 'message';
      sessionId: string;
      agentToken: string;
      expectedRevision: number;
      idempotencyKey: string;
      text: string;
      attachments?: string[];
    }
) & { handledThroughCursor?: number };

export type QuizLearnerRequest =
  | {
      type: 'answer';
      sessionId: string;
      expectedRevision: number;
      idempotencyKey: string;
      choiceId?: string;
      reasoning?: string;
      matches?: Record<string, string>;
      answer?: string;
      confidence?: number;
    }
  | {
      type: 'respond-prompt';
      sessionId: string;
      expectedRevision: number;
      idempotencyKey: string;
      promptId: string;
      choiceId: string;
      detail?: string;
    }
  | {
      type: 'skip';
      sessionId: string;
      expectedRevision: number;
      idempotencyKey: string;
      questionId: string;
    }
  | {
      type: 'continue';
      sessionId: string;
      expectedRevision: number;
      idempotencyKey: string;
    }
  | {
      type: 'message';
      sessionId: string;
      expectedRevision: number;
      idempotencyKey: string;
      text: string;
      attachments?: string[];
    };

export type QuizDraft = {
  questionId: string | null;
  selectedChoiceId: string | null;
  reasoningDraft: string;
  freeChatDraft: string;
  matchesDraft?: Record<string, string>;
  textDraft?: string;
  promptId?: string;
  selectedPromptChoiceId?: string;
  promptDetailDraft?: string;
};
export type QuizEvent = {
  cursor: number;
  revision: number;
  type: string;
  data: unknown;
  createdAt: string;
};
export type QuizSnapshot = { session: QuizSession; events: QuizEvent[] };
export type QuizResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error:
        | 'not-found'
        | 'stale-revision'
        | 'invalid-state'
        | 'invalid-input'
        | 'study-unavailable'
        | 'unauthorized';
    };

/**
 * Validate optional pose-question learning metadata. Returns undefined when absent,
 * null when invalid. Concepts and level travel together; support defaults to independent.
 */
export function quizLearningFromRequest(request: {
  concepts?: unknown;
  level?: unknown;
  support?: unknown;
  unmodelledReason?: unknown;
}): QuizLearning | undefined | null {
  const { concepts, level, support, unmodelledReason } = request;
  if (
    unmodelledReason !== undefined &&
    (typeof unmodelledReason !== 'string' ||
      !unmodelledReason.trim() ||
      unmodelledReason.length > 500 ||
      concepts !== undefined ||
      level !== undefined ||
      support !== undefined)
  )
    return null;
  if (concepts === undefined && level === undefined && support === undefined)
    return undefined;
  if (
    !Array.isArray(concepts) ||
    concepts.length < 1 ||
    concepts.length > QUIZ_MAX_CONCEPTS ||
    concepts.some(
      (concept) =>
        typeof concept !== 'string' || !QUIZ_CONCEPT_ID.test(concept),
    ) ||
    new Set(concepts).size !== concepts.length ||
    !QUIZ_COGNITIVE_LEVELS.includes(level as QuizCognitiveLevel) ||
    (support !== undefined && !QUIZ_SUPPORTS.includes(support as QuizSupport))
  )
    return null;
  return {
    concepts: [...(concepts as string[])],
    level: level as QuizCognitiveLevel,
    support: (support as QuizSupport | undefined) ?? 'independent',
  };
}
