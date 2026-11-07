import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  QuizAgentRequest,
  QuizLearnerRequest,
  QuizResult,
  QuizScope,
  QuizSession,
} from '../shared/quizProtocol';
import { QuizService } from './quizService';
import { QuizStore } from './quizStore';
import { LearnerStore } from './learnerStore';

type Action<T> = T extends unknown
  ? Omit<T, 'sessionId' | 'agentToken' | 'expectedRevision' | 'idempotencyKey'>
  : never;
export type AgentAction = Action<QuizAgentRequest>;
export type LearnerAction = Action<QuizLearnerRequest>;
type Receipt = { expectedRevision?: number; idempotencyKey?: string };

export function quizValue<T>(result: QuizResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.value;
}

/** One revision/receipt driver. Invalid boundary payloads use the explicit input methods. */
export class QuizSessionDriver {
  private revision: number;
  private sequence = 0;
  readonly id: string;
  readonly agentToken: string;
  constructor(
    readonly service: QuizService,
    session: QuizSession,
  ) {
    this.id = session.id;
    this.agentToken = session.agentToken;
    this.revision = session.revision;
  }
  private envelope(receipt: Receipt) {
    return {
      sessionId: this.id,
      agentToken: this.agentToken,
      expectedRevision: receipt.expectedRevision ?? this.revision,
      idempotencyKey: receipt.idempotencyKey ?? `driver-${++this.sequence}`,
    };
  }
  private accepted(result: QuizResult<QuizSession>) {
    if (result.ok) this.revision = result.value.revision;
    return result;
  }
  async agent(action: AgentAction, receipt: Receipt = {}) {
    return this.accepted(
      await this.service.request({ ...this.envelope(receipt), ...action }),
    );
  }
  async learner(action: LearnerAction, receipt: Receipt = {}) {
    return this.accepted(
      await this.service.learnerRequest({
        ...this.envelope(receipt),
        ...action,
      }),
    );
  }
  agentInput(input: Record<string, unknown>, receipt: Receipt = {}) {
    return this.agent(input as AgentAction, receipt);
  }
  learnerInput(input: Record<string, unknown>, receipt: Receipt = {}) {
    return this.learner(input as LearnerAction, receipt);
  }
  async refresh() {
    const snapshot = await this.service.getSnapshot(this.id);
    if (!snapshot) throw new Error('Session disappeared');
    this.revision = snapshot.session.revision;
    return snapshot.session;
  }
}

export const quizScope: QuizScope = {
  vaultId: 'vault',
  notePath: 'loops.md',
  selectedNotePaths: [],
  folderPath: null,
};

export class FailingQuizStore extends QuizStore {
  fail = false;
  constructor(readonly path: string) {
    super(path);
  }
  protected override async atomicWrite(path: string, value: unknown) {
    if (this.fail && path === this.path) throw new Error('disk unavailable');
    return super.atomicWrite(path, value);
  }
}

export async function quizFixture<S extends QuizStore = QuizStore>(
  options: {
    fileName?: string;
    scope?: QuizScope;
    connected?: boolean;
    learning?: boolean;
    store?: (path: string) => S;
    beforeService?: (store: S) => Promise<void>;
    authorizeScope?: (scope: QuizScope) => boolean;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'storm-quiz-fixture-'));
  const path = join(dir, options.fileName ?? 'quiz.json');
  const store = options.store
    ? options.store(path)
    : (new QuizStore(path) as S);
  const learner = new LearnerStore(join(dir, 'learner.json'));
  await options.beforeService?.(store);
  const service = new QuizService(
    store,
    options.authorizeScope ?? (() => true),
    undefined,
    undefined,
    undefined,
    options.learning ? learner : undefined,
  );
  try {
    const session = quizValue(await service.createSession(options.scope));
    const attached = options.connected
      ? quizValue(await service.attachSession(session.id))
      : {
          agentToken: session.agentToken,
          snapshot: (await service.getSnapshot(session.id))!,
        };
    return {
      dir,
      path,
      store,
      service,
      session,
      attached,
      learner,
      driver: new QuizSessionDriver(service, attached.snapshot.session),
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

export const quizVariantCases = [
  {
    name: 'multiple-choice',
    pose: {
      type: 'pose-question',
      kind: 'multiple-choice',
      question: 'Pick',
      choices: [
        { id: 'a', text: 'Alpha' },
        { id: 'b', text: 'Beta' },
      ],
    },
    answer: { type: 'answer', choiceId: 'b', reasoning: 'because' },
  },
  {
    name: 'matching',
    pose: {
      type: 'pose-question',
      kind: 'matching',
      question: 'Pair',
      leftItems: [
        { id: 'l1', text: 'L1' },
        { id: 'l2', text: 'L2' },
      ],
      rightItems: [
        { id: 'r1', text: 'R1' },
        { id: 'r2', text: 'R2' },
      ],
    },
    answer: { type: 'answer', matches: { l1: 'r2', l2: 'r1' } },
  },
  {
    name: 'short-answer',
    pose: { type: 'pose-question', kind: 'short-answer', question: 'Brief' },
    answer: { type: 'answer', answer: '  café\n答え  ' },
  },
  {
    name: 'long-answer',
    pose: { type: 'pose-question', kind: 'long-answer', question: 'Explain' },
    answer: { type: 'answer', answer: 'Line one\nLine two — 🧠' },
  },
] satisfies {
  name: string;
  pose: Extract<AgentAction, { type: 'pose-question' }>;
  answer: Extract<LearnerAction, { type: 'answer' }>;
}[];

/** Deliberately malformed boundary inputs, shared by validation and end-to-end tests. */
export const invalidQuizVariantCases = [
  { kind: 'multiple-choice', question: 'Q', choices: [] },
  {
    kind: 'multiple-choice',
    question: 'Q',
    choices: Array.from({ length: 7 }, (_, i) => ({
      id: String(i),
      text: 'x',
    })),
  },
  {
    kind: 'matching',
    question: 'Q',
    leftItems: [
      { id: 'x', text: 'X' },
      { id: 'x', text: 'Y' },
    ],
    rightItems: [
      { id: 'z', text: 'Z' },
      { id: 'w', text: 'W' },
    ],
  },
  {
    kind: 'matching',
    question: 'Q',
    leftItems: [
      { id: 'x', text: 'X' },
      { id: 'y', text: 'Y' },
    ],
    rightItems: [{ id: 'z', text: 'Z' }],
  },
  {
    kind: 'short-answer',
    question: 'Q',
    choices: [{ id: 'a', text: 'hidden answer' }],
  },
  { kind: 'long-answer', question: '   ' },
].map((pose, index) => ({
  name: [
    'empty choices',
    'too many choices',
    'duplicate matching IDs',
    'unequal matching sides',
    'hidden text choices',
    'blank prompt',
  ][index],
  pose: { type: 'pose-question', ...pose },
}));
