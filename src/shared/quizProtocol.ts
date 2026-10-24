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
export type QuizQuestion = {
  id: string;
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
  createdAt: string;
  updatedAt: string;
};

export type QuizAgentRequest =
  | {
      type: 'attach';
      sessionId: string;
      agentToken: string;
      expectedRevision: number;
      idempotencyKey: string;
    }
  | {
      type: 'pose-question';
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
      type: 'feedback';
      sessionId: string;
      agentToken: string;
      expectedRevision: number;
      idempotencyKey: string;
      text: string;
      verdict?: 'correct' | 'incorrect' | 'partial';
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
    };

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
        | 'unauthorized';
    };
