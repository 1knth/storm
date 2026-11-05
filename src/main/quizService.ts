import { createHash, randomUUID } from 'node:crypto';
import {
  isQuizConfidence,
  QUIZ_CONCEPT_ID,
  QUIZ_PRACTICE_TEST_MAX_TRANSITIONS,
  QUIZ_PRACTICE_TEST_MAX_CONCEPTS,
  QUIZ_REASONING_ASSESSMENTS,
  QUIZ_SUPPORTS,
  quizLearningFromRequest,
  type QuizAgentRequest,
  type QuizChoice,
  type QuizEvent,
  type QuizMessage,
  type QuizLearnerRequest,
  type QuizPracticeTest,
  type QuizQuestion,
  type QuizResult,
  type QuizScope,
  type QuizSession,
  type QuizSnapshot,
  TUTOR_NOTES_MAX_LENGTH,
} from '../shared/quizProtocol';
import {
  orderQuizChoices,
  orderQuizMatchOptions,
} from '../shared/quizChoiceOrder';
import {
  applyLessonMapUpdate,
  focusLessonMap,
  isLessonMapUpdate,
} from '../shared/lessonMap';
import type { LearnerAttempt } from '../shared/learnerModel';
import {
  masteryEvidence,
  masteryShortfall,
  questionFingerprintSource,
  type MasteryExposure,
} from '../shared/mastery';
import { learnerAttempt, learnerScopeKey } from './learnerStore';
import { QuizStore } from './quizStore';
import type { TutorNotesFile } from './tutorNotesFile';
import {
  MAX_QUIZ_MESSAGE_IMAGES,
  QuizImageRegistry,
  type QuizImageInput,
} from './quizImageRegistry';

function isValidScope(scope: QuizScope): boolean {
  const hasNote =
    typeof scope.notePath === 'string' && scope.notePath.trim().length > 0;
  const hasFolder =
    typeof scope.folderPath === 'string' && scope.folderPath.trim().length > 0;
  const hasSelected =
    Array.isArray(scope.selectedNotePaths) &&
    scope.selectedNotePaths.length > 0 &&
    scope.selectedNotePaths.every(
      (path) => typeof path === 'string' && path.trim().length > 0,
    );
  const noSelection =
    Array.isArray(scope.selectedNotePaths) &&
    scope.selectedNotePaths.length === 0;
  return (
    (scope.notePath === null && scope.folderPath === null && noSelection) ||
    (hasNote && scope.folderPath === null && noSelection) ||
    (scope.notePath === null && hasFolder && noSelection) ||
    (scope.notePath === null && scope.folderPath === null && hasSelected)
  );
}

/** Every graded question in a session, rebuilt from its durable transcript. */
function gradedQuestions(session: QuizSession): QuizQuestion[] {
  const questions = new Map<string, QuizQuestion>();
  for (const message of session.transcript) {
    const question = message.question;
    if (!question?.verdict) continue;
    questions.set(question.id, {
      ...question,
      gradedAt: question.gradedAt ?? message.createdAt,
      status: 'feedback',
      selectedChoiceId: null,
      reasoningDraft: '',
      feedback: message.text,
    });
  }
  const current = session.currentQuestion;
  if (current?.verdict && !questions.has(current.id))
    questions.set(current.id, {
      ...current,
      gradedAt: current.gradedAt ?? session.updatedAt,
    });
  return [...questions.values()];
}

/** Fingerprint only what the learner is shown for the item's kind. */
const fingerprintOf = (
  question: Parameters<typeof questionFingerprintSource>[0],
) => {
  const kind = question.kind ?? 'multiple-choice';
  return createHash('sha256')
    .update(
      questionFingerprintSource({
        kind,
        prompt: question.prompt,
        choices: kind === 'multiple-choice' ? question.choices : [],
        ...(kind === 'matching'
          ? { leftItems: question.leftItems, rightItems: question.rightItems }
          : {}),
      }),
    )
    .digest('hex');
};

/** A session's graded attempts and every item it showed the learner. */
function sessionEvidence(session: QuizSession): {
  attempts: LearnerAttempt[];
  exposures: MasteryExposure[];
} {
  const attempts = gradedQuestions(session).flatMap(
    (question) => learnerAttempt(session, question) ?? [],
  );
  const exposures = session.transcript.flatMap((message) =>
    message.kind === 'question' && message.question
      ? [
          {
            id: message.question.id,
            at: message.createdAt,
            fingerprint:
              message.question.fingerprint ?? fingerprintOf(message.question),
          },
        ]
      : [],
  );
  return { attempts, exposures };
}

/**
 * An independent miss withdraws the mastery claim for the item's concepts.
 * Applied to the committed map, so a claim written meanwhile is not kept.
 */
function withLapsedMastery(
  session: QuizSession,
  graded: QuizQuestion | null,
  at: string,
): QuizSession {
  const map = session.lessonMap;
  const support =
    graded?.suppliedSupport ?? graded?.learning?.support ?? 'independent';
  if (!map || graded?.verdict !== 'incorrect' || support !== 'independent')
    return session;
  const lapsed = (graded.learning?.concepts ?? []).filter(
    (id) => map.statuses[id] === 'mastered' || map.statuses[id] === 'retained',
  );
  if (!lapsed.length) return session;
  const statuses = { ...map.statuses };
  for (const id of lapsed) statuses[id] = 'needs-review';
  return {
    ...session,
    lessonMap: { ...map, statuses, version: map.version + 1, updatedAt: at },
  };
}

type PoolEvidence = {
  attempts: LearnerAttempt[];
  exposures: MasteryExposure[];
};

/**
 * The learner's history in a session's learning pool, excluding that session:
 * saved attempts plus every other pool session's transcript. Transcripts are
 * the durable record, so grades whose recording failed still count. Called
 * with commit-time sessions so concurrent quizzes in the pool are seen.
 */
function poolFrom(
  session: QuizSession,
  sessions: QuizSession[],
  saved: LearnerAttempt[],
): PoolEvidence {
  const pool = learnerScopeKey(session.scope, session.id);
  const attempts = new Map(
    saved
      .filter((attempt) => attempt.sessionId !== session.id)
      .map((attempt) => [attempt.id, attempt]),
  );
  const exposures: MasteryExposure[] = [];
  for (const other of sessions) {
    if (
      other.id === session.id ||
      learnerScopeKey(other.scope, other.id) !== pool
    )
      continue;
    const evidence = sessionEvidence(other);
    for (const attempt of evidence.attempts) attempts.set(attempt.id, attempt);
    exposures.push(...evidence.exposures);
  }
  return { attempts: [...attempts.values()], exposures };
}

/** Whether the learner has been shown this wording anywhere in the pool. */
const seenInPool = (
  pool: PoolEvidence,
  own: QuizSession,
  fingerprint: string,
) =>
  [...sessionEvidence(own).exposures, ...pool.exposures, ...pool.attempts].some(
    (item) => item.fingerprint === fingerprint,
  );

/** Result of a metadata-only commit, with Storm's reason when it can give one. */
function metadataResult(
  result: QuizSession | string | undefined,
  reason: string | undefined,
): QuizResult<QuizSession> {
  if (result === undefined) return { ok: false, error: 'unauthorized' };
  if (result === 'invalid-state') return { ok: false, error: result };
  if (typeof result === 'string')
    return {
      ok: false,
      error: 'invalid-input',
      ...(reason ? { message: reason } : {}),
    };
  return { ok: true, value: result };
}

/** Deleting would discard grades the learner model has not saved yet. */
export class QuizDeletionBlocked extends Error {
  constructor() {
    super(
      'Its grades are not saved to the learner model yet, so deleting it would lose them. Try again shortly.',
    );
  }
}

export class QuizService {
  readonly imageRegistry = new QuizImageRegistry();
  private attachQueue: Promise<void> = Promise.resolve();
  private readonly startupRecovery: Promise<void>;
  private reconciliationQueue: Promise<unknown> = Promise.resolve();
  private readonly recordingFailures = new Map<string, string>();
  private readonly recordedGrades = new Map<string, string>();
  private readonly recordingFailureCounts = new Map<string, number>();
  private readonly unmodelledQuestions = new Map<string, string>();

  constructor(
    private readonly store: QuizStore,
    private readonly authorizeScope: (
      scope: QuizScope,
    ) => Promise<boolean> | boolean,
    private readonly now = () => new Date().toISOString(),
    private readonly prepareStudyBasis?: (
      session: QuizSession,
      snapshotId: string,
      operationId: string,
    ) => Promise<void>,
    private readonly finalizeStudyBasis?: (
      sessionId: string,
      basis: string | undefined,
      operationId: string,
      revision: number,
    ) => Promise<void>,
    /** Records graded answers after their durable feedback commit. Must be idempotent by question ID. */
    private readonly recordAttempt?: (
      session: QuizSession,
      question: QuizQuestion,
    ) => Promise<void>,
    private readonly recordAttempts?: (
      entries: Array<{ session: QuizSession; question: QuizQuestion }>,
    ) => Promise<void>,
    private readonly tutorNotesFile?: TutorNotesFile,
    /** Persisted attempts in the session's learning pool, for mastery evidence. */
    private readonly learnerAttempts?: (
      session: QuizSession,
    ) => Promise<LearnerAttempt[]>,
  ) {
    // A persisted connected state belongs to a prior process. Recover it once,
    // before any new operation can attach or observe a session.
    this.startupRecovery = this.recoverConnectedSessions();
  }

  private async recoverConnectedSessions(): Promise<void> {
    const sessions = await this.store.list();
    for (const session of sessions) {
      if (session.status === 'connected')
        await this.disconnectAgentExclusive(session.id, session.agentToken);
    }
    // Transcripts are durable and unbounded. Replay repairs crashes between the
    // feedback commit and derived-model recording, including legacy questions.
    await this.reconcileSessions(sessions);
  }

  private gradeFingerprint(
    session: QuizSession,
    question: QuizQuestion,
  ): string {
    return JSON.stringify([
      session.scope,
      question.id,
      question.gradedAt ?? session.updatedAt,
      question.learning,
      question.suppliedSupport,
      question.verdict,
      question.confidence,
      question.fingerprint,
      question.testId,
      !!question.testId &&
        !!session.practiceTestLog?.completed.includes(question.testId),
      question.reasoning,
    ]);
  }

  private async recordGradedQuestions(
    entries: Array<{ session: QuizSession; question: QuizQuestion }>,
  ): Promise<void> {
    const pending = entries.filter(({ session, question }) => {
      if (!question.verdict) return false;
      if (!question.learning)
        this.unmodelledQuestions.set(question.id, session.id);
      return (
        (this.recordAttempt || this.recordAttempts) &&
        (question.learning || question.confidence !== undefined) &&
        this.recordedGrades.get(`${session.id}:${question.id}`) !==
          this.gradeFingerprint(session, question)
      );
    });
    const save = async (batch: typeof pending) => {
      try {
        if (this.recordAttempts) await this.recordAttempts(batch);
        else
          for (const { session, question } of batch)
            await this.recordAttempt!(session, question);
        for (const { session, question } of batch) {
          this.recordedGrades.set(
            `${session.id}:${question.id}`,
            this.gradeFingerprint(session, question),
          );
          this.recordingFailures.delete(question.id);
        }
        const failedSessions = new Set(this.recordingFailures.values());
        for (const { session } of batch) {
          if (!failedSessions.has(session.id))
            this.recordingFailureCounts.delete(session.id);
        }
      } catch {
        for (const { session, question } of batch) {
          this.recordingFailures.set(question.id, session.id);
          this.recordingFailureCounts.set(
            session.id,
            (this.recordingFailureCounts.get(session.id) ?? 0) + 1,
          );
        }
      }
    };
    if (!pending.length) return;
    if (this.recordAttempts) await save(pending);
    else for (const entry of pending) await save([entry]);
  }

  private async recordGradedQuestion(
    session: QuizSession,
    question: QuizQuestion,
  ): Promise<void> {
    await this.recordGradedQuestions([{ session, question }]);
  }

  private async reconcileSessions(sessions: QuizSession[]): Promise<void> {
    const entries: Array<{ session: QuizSession; question: QuizQuestion }> = [];
    for (const session of sessions)
      for (const question of gradedQuestions(session))
        entries.push({ session, question });
    await this.recordGradedQuestions(entries);
  }

  /** Retry durable grades before serving model state, serializing concurrent reads. */
  async reconcileLearner(sessionId: string) {
    await this.startupRecovery;
    const operation = this.reconciliationQueue.then(async () => {
      const current = await this.store.get(sessionId);
      const scopeSessions = new Set<string>([sessionId]);
      if (current) {
        const sessions = await this.store.list({ includeDrafts: true });
        const relevant = sessions.filter((session) =>
          current.scope
            ? session.scope?.vaultId === current.scope.vaultId
            : session.id === sessionId,
        );
        for (const session of relevant) scopeSessions.add(session.id);
        await this.reconcileSessions(relevant);
      }
      return this.learnerRecordingDiagnostics(scopeSessions);
    });
    this.reconciliationQueue = operation.catch(() => {});
    return operation;
  }

  learnerRecordingDiagnostics(sessionIds?: ReadonlySet<string>): {
    pending: number;
    failures: number;
    unmodelled: number;
    lastError?: string;
  } {
    const included = (id: string) => !sessionIds || sessionIds.has(id);
    const pending = [...this.recordingFailures.values()].filter(
      included,
    ).length;
    return {
      pending,
      failures: [...this.recordingFailureCounts].reduce(
        (total, [id, count]) => total + (included(id) ? count : 0),
        0,
      ),
      unmodelled: [...this.unmodelledQuestions.values()].filter(included)
        .length,
      ...(pending ? { lastError: 'LEARNER_RECORDING_RETRY_PENDING' } : {}),
    };
  }

  async createSession(scope?: QuizScope): Promise<QuizResult<QuizSession>> {
    await this.startupRecovery;
    if (
      scope &&
      (!scope.vaultId ||
        !isValidScope(scope) ||
        !(await this.authorizeScope(scope)))
    )
      return { ok: false, error: 'unauthorized' };
    const timestamp = this.now();
    const session: QuizSession = {
      id: randomUUID(),
      agentToken: randomUUID(),
      revision: 0,
      eventCursor: 0,
      ...(scope ? { scope: structuredClone(scope) } : {}),
      status: 'waiting-agent',
      transcript: [],
      currentQuestion: null,
      freeChatDraft: '',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.createDraft(session);
    return { ok: true, value: session };
  }
  async renameSession(
    sessionId: string,
    name: string,
  ): Promise<QuizResult<QuizSession>> {
    await this.startupRecovery;
    if (typeof name !== 'string') return { ok: false, error: 'invalid-input' };
    const normalizedName = name.trim();
    if (!normalizedName || normalizedName.length > 100)
      return { ok: false, error: 'invalid-input' };
    try {
      // Metadata-only update intentionally leaves revisions/events untouched, so
      // a rename cannot invalidate an agent's in-flight compare-and-swap request.
      const renamed = await this.store.rename(sessionId, normalizedName);
      if (!renamed) return { ok: false, error: 'not-found' };
      await this.store.promote(sessionId);
      return { ok: true, value: renamed };
    } catch {
      return { ok: false, error: 'stale-revision' };
    }
  }

  /** Attach, replace, or clear (undefined) the study scope of an existing session. */
  async setScope(
    sessionId: string,
    scope: QuizScope | undefined,
  ): Promise<QuizResult<QuizSession>> {
    await this.startupRecovery;
    if (
      scope &&
      (!scope.vaultId ||
        !isValidScope(scope) ||
        !(await this.authorizeScope(scope)))
    )
      return { ok: false, error: 'unauthorized' };
    try {
      const updated = await this.store.setScope(sessionId, scope);
      if (!updated) return { ok: false, error: 'not-found' };
      await this.store.promote(sessionId);
      return { ok: true, value: updated };
    } catch {
      return { ok: false, error: 'stale-revision' };
    }
  }

  async deleteSession(
    sessionId: string,
  ): Promise<{ id: string; deleted: true }> {
    await this.startupRecovery;
    // Deletion is intentionally idempotent and only affects app-local quiz data.
    // Record its grades first so mastery evidence outlives the transcript.
    const session = await this.store.get(sessionId);
    if (session) {
      await this.reconcileSessions([session]);
      // Refuse rather than lose grades (including misses) the learner model
      // has not saved: the transcript is then their only record.
      if ([...this.recordingFailures.values()].includes(sessionId))
        throw new QuizDeletionBlocked();
    }
    await this.store.deleteSession(sessionId);
    this.imageRegistry.purgeSession(sessionId);
    return { id: sessionId, deleted: true };
  }

  async addImage(sessionId: string, input: QuizImageInput) {
    await this.startupRecovery;
    const session = await this.store.get(sessionId);
    if (!session) return { ok: false as const, error: 'not-found' as const };
    if (session.status !== 'connected')
      return { ok: false as const, error: 'invalid-state' as const };
    const metadata = this.imageRegistry.add(sessionId, input);
    return metadata
      ? { ok: true as const, value: metadata }
      : { ok: false as const, error: 'invalid-input' as const };
  }

  async removeImage(sessionId: string, id: string): Promise<boolean> {
    return this.imageRegistry.remove(sessionId, id);
  }

  disposeImages(): void {
    this.imageRegistry.dispose();
  }

  async getImage(sessionId: string, id: string) {
    return this.imageRegistry.get(sessionId, id);
  }

  async releaseImageForAgent(
    sessionId: string,
    agentToken: string,
    id: string,
  ) {
    await this.startupRecovery;
    const session = await this.store.get(sessionId);
    if (!session) return { ok: false as const, error: 'not-found' as const };
    if (session.agentToken !== agentToken)
      return { ok: false as const, error: 'unauthorized' as const };
    if (session.status !== 'connected')
      return { ok: false as const, error: 'invalid-state' as const };
    this.imageRegistry.remove(sessionId, id);
    return { ok: true as const, value: { id, released: true as const } };
  }

  async getImageForAgent(sessionId: string, agentToken: string, id: string) {
    await this.startupRecovery;
    const session = await this.store.get(sessionId);
    if (!session) return { ok: false as const, error: 'not-found' as const };
    if (session.agentToken !== agentToken)
      return { ok: false as const, error: 'unauthorized' as const };
    if (session.status !== 'connected')
      return { ok: false as const, error: 'invalid-state' as const };
    const image = this.imageRegistry.get(sessionId, id);
    return image
      ? { ok: true as const, value: image }
      : { ok: false as const, error: 'not-found' as const };
  }

  async listSessions(
    options: { includeDrafts?: boolean } = {},
  ): Promise<QuizSession[]> {
    await this.startupRecovery;
    return this.store.list(options);
  }
  async getSnapshot(
    id: string,
    after = 0,
    compact = false,
  ): Promise<QuizSnapshot | null> {
    await this.startupRecovery;
    const session = compact
      ? await this.store.getAgentState(id)
      : await this.store.get(id);
    return session
      ? { session, events: await this.store.events(id, after) }
      : null;
  }

  async listSessionSummaries() {
    await this.startupRecovery;
    return this.store.listSummaries();
  }

  /** Pair an authenticated local CLI caller with a learner-selected session ID. */
  async attachSession(
    sessionId: string,
  ): Promise<QuizResult<{ agentToken: string; snapshot: QuizSnapshot }>> {
    const operation = this.attachQueue.then(async () => {
      await this.startupRecovery;
      return this.attachSessionExclusive(sessionId);
    });
    this.attachQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async attachSessionExclusive(
    sessionId: string,
  ): Promise<QuizResult<{ agentToken: string; snapshot: QuizSnapshot }>> {
    const current = await this.store.get(sessionId);
    if (!current) return { ok: false, error: 'not-found' };
    if (current.status === 'connected' || current.status === 'complete')
      return { ok: false, error: 'invalid-state' };
    const timestamp = this.now();
    const next = {
      ...current,
      status: 'connected' as const,
      revision: current.revision + 1,
      eventCursor: current.eventCursor + 1,
      updatedAt: timestamp,
    };
    const event: QuizEvent = {
      cursor: next.eventCursor,
      revision: next.revision,
      type: 'attach',
      data: {},
      createdAt: timestamp,
    };
    try {
      const saved = await this.store.update(
        next,
        current.revision,
        event,
        `${sessionId}:attach:${next.revision}`,
        JSON.stringify([sessionId, next.revision]),
      );
      return {
        ok: true,
        value: {
          agentToken: saved.agentToken,
          snapshot: {
            session: saved,
            events: await this.store.events(sessionId),
          },
        },
      };
    } catch {
      return { ok: false, error: 'stale-revision' };
    }
  }

  /** Saved learner-model attempts; an unreadable store falls back to transcripts alone. */
  private async savedAttempts(session: QuizSession): Promise<LearnerAttempt[]> {
    try {
      return this.learnerAttempts ? await this.learnerAttempts(session) : [];
    } catch {
      return [];
    }
  }

  /**
   * The tutor declares mastery; Storm checks the recorded evidence first.
   * Returns the shortfall for each newly mastered or retained node, if any.
   */
  private masteryGate(
    session: QuizSession,
    statuses: Record<string, string> | undefined,
    pool: PoolEvidence,
  ): string | undefined {
    const claimed = Object.entries(statuses ?? {}).filter(
      ([id, status]) =>
        (status === 'mastered' || status === 'retained') &&
        session.lessonMap?.statuses[id] !== status,
    );
    if (!claimed.length) return undefined;
    const own = sessionEvidence(session);
    const attempts = [...pool.attempts, ...own.attempts];
    const exposures = [...pool.exposures, ...own.exposures];
    const short: string[] = [];
    for (const [id, status] of claimed) {
      const evidence = masteryEvidence(id, attempts, exposures);
      if (!evidence.mastered) short.push(masteryShortfall([evidence]));
      else if (status === 'retained' && !evidence.retained)
        short.push(
          `${id}: needs a correct independent answer in a later session than the one where mastery was shown.`,
        );
    }
    return short.length
      ? `Mastery is not yet supported by the recorded evidence. ${short.join(' ')}`
      : undefined;
  }

  /** Lesson maps are display metadata: no revision, event, or Continue gate. */
  private async setLessonMap(
    request: Extract<QuizAgentRequest, { type: 'lesson-map' }>,
    current: QuizSession,
  ): Promise<QuizResult<QuizSession>> {
    if (!isLessonMapUpdate(request.map))
      return { ok: false, error: 'invalid-input' };
    const claims = Object.values(request.map.statuses ?? {}).some(
      (status) => status === 'mastered' || status === 'retained',
    );
    const deletions = this.store.deletions;
    const saved = claims ? await this.savedAttempts(current) : undefined;
    let reason: string | undefined;
    const result = await this.store.setLessonMap(
      request.sessionId,
      request.agentToken,
      (session, sessions) => {
        if (session.status !== 'connected') return 'invalid-state';
        // Saved attempts were read for the pool at request time.
        if (
          saved &&
          learnerScopeKey(session.scope, session.id) !==
            learnerScopeKey(current.scope, current.id)
        ) {
          reason =
            'The study scope changed during the request; read status and retry.';
          return 'invalid-input';
        }
        // A quiz deleted meanwhile may have held evidence the earlier read missed.
        if (saved && this.store.deletions !== deletions) {
          reason =
            'A quiz in this learning pool was deleted during the request; retry.';
          return 'invalid-input';
        }
        // Judge the claim against the state being committed, in this and every
        // other pool session, so a grade that landed meanwhile counts.
        reason =
          saved &&
          this.masteryGate(
            session,
            request.map.statuses,
            poolFrom(session, sessions, saved),
          );
        if (reason) return 'invalid-input';
        const map = applyLessonMapUpdate(
          session.lessonMap,
          request.map,
          this.now(),
        );
        if (typeof map === 'string') {
          reason = map;
          return 'invalid-input';
        }
        return { ...session, lessonMap: map };
      },
    );
    return metadataResult(result, reason);
  }

  /**
   * Practice tests commit outside revisions like the map, but replay safely by
   * idempotency key. Storm owns the test conditions: while one is open every
   * item is tagged, independent and new, and the test ends (and its items
   * become test evidence) only once each listed concept has a graded item.
   */
  private async setPracticeTest(
    request: Extract<QuizAgentRequest, { type: 'practice-test' }>,
  ): Promise<QuizResult<QuizSession>> {
    const fingerprint = JSON.stringify([request.action, request.concepts]);
    let reason: string | undefined;
    const fail = (message: string) => {
      reason = message;
      return 'invalid-input';
    };
    let ended = false;
    const result = await this.store.setLessonMap(
      request.sessionId,
      request.agentToken,
      (session) => {
        const log = session.practiceTestLog ?? {
          version: 0,
          completed: [],
          receipts: {},
        };
        const receipt = log.receipts[request.idempotencyKey];
        if (receipt === fingerprint) return session;
        if (receipt !== undefined)
          return fail(
            'This operationId already belongs to a different test request; use a new one.',
          );
        // Only start is capped, so an open test can always be ended or cancelled.
        if (
          request.action === 'start' &&
          Object.keys(log.receipts).length >= QUIZ_PRACTICE_TEST_MAX_TRANSITIONS
        )
          return fail(
            'This quiz session has reached its practice test limit; continue testing in a new session.',
          );
        if (session.status !== 'connected') return 'invalid-state';
        const pending =
          session.currentQuestion &&
          session.currentQuestion.status !== 'feedback';
        const test = session.practiceTest;
        const commit = (
          practiceTest: QuizPracticeTest | undefined,
          completed = log.completed,
        ): QuizSession => {
          const { practiceTest: _previous, ...rest } = session;
          const receipts = {
            ...log.receipts,
            [request.idempotencyKey]: fingerprint,
          };
          return {
            ...rest,
            ...(practiceTest ? { practiceTest } : {}),
            practiceTestLog: {
              version: log.version + 1,
              completed,
              receipts,
            },
          };
        };
        if (request.action === 'start') {
          if (test)
            return fail(
              `Practice test ${test.id} is already open; end or cancel it first.`,
            );
          if (pending)
            return fail(
              'Give feedback on or skip the current question before starting a practice test.',
            );
          const concepts = request.concepts ?? [];
          if (
            !Array.isArray(concepts) ||
            !concepts.length ||
            concepts.length > QUIZ_PRACTICE_TEST_MAX_CONCEPTS ||
            new Set(concepts).size !== concepts.length ||
            !concepts.every(
              (id) => typeof id === 'string' && QUIZ_CONCEPT_ID.test(id),
            )
          )
            return fail(
              `start needs 1-${QUIZ_PRACTICE_TEST_MAX_CONCEPTS} unique concept slugs.`,
            );
          const mapped = new Set(session.lessonMap?.nodes.map((n) => n.id));
          const unknown = session.lessonMap
            ? concepts.filter((id) => !mapped.has(id))
            : [];
          if (unknown.length)
            return fail(`Not lesson map nodes: ${unknown.join(', ')}.`);
          return commit({ id: randomUUID(), concepts, startedAt: this.now() });
        }
        if (!test) return fail('No practice test is open.');
        // Cancelled test items never count as test evidence.
        if (request.action === 'cancel') return commit(undefined);
        if (pending)
          return fail(
            'Give feedback on or skip the current test item before ending the test.',
          );
        const covered = new Set(
          gradedQuestions(session)
            .filter((q) => q.testId === test.id)
            .flatMap((q) => q.learning?.concepts ?? []),
        );
        const uncovered = test.concepts.filter((id) => !covered.has(id));
        if (uncovered.length)
          return fail(
            `The test has no graded item yet for: ${uncovered.join(', ')}. Pose one for each, or cancel the test.`,
          );
        ended = true;
        return commit(undefined, [...log.completed, test.id]);
      },
    );
    // Completing the test turns its graded items into recorded test evidence.
    if (ended && result && typeof result !== 'string')
      await this.recordGradedQuestions(
        gradedQuestions(result).map((question) => ({
          session: result,
          question,
        })),
      );
    return metadataResult(result, reason);
  }

  /** Tutor notes are handoff metadata, committed like the lesson map. */
  private async setTutorNotes(
    request: Extract<QuizAgentRequest, { type: 'tutor-notes' }>,
    current: QuizSession,
  ): Promise<QuizResult<QuizSession>> {
    const text = request.text.trim();
    if (!text || text.length > TUTOR_NOTES_MAX_LENGTH)
      return { ok: false, error: 'invalid-input' };
    if (current.status !== 'connected')
      return { ok: false, error: 'invalid-state' };
    // The vault file is the copy learners and later sessions read. The session
    // copy is the fallback for unscoped quizzes or an unavailable vault.
    let file: { vaultId: string; path: string } | undefined;
    if (current.scope && this.tutorNotesFile)
      try {
        file = {
          vaultId: current.scope.vaultId,
          path: await this.tutorNotesFile.write(
            current.scope,
            current.id,
            text,
          ),
        };
      } catch {
        file = undefined;
      }
    const result = await this.store.setLessonMap(
      request.sessionId,
      request.agentToken,
      (session) =>
        session.status !== 'connected'
          ? 'invalid-state'
          : {
              ...session,
              tutorNotes: {
                text,
                version: (session.tutorNotes?.version ?? 0) + 1,
                updatedAt: this.now(),
                ...file,
              },
            },
    );
    if (result === undefined) return { ok: false, error: 'unauthorized' };
    if (typeof result === 'string')
      return {
        ok: false,
        error: result === 'invalid-state' ? 'invalid-state' : 'invalid-input',
      };
    return { ok: true, value: result };
  }

  /** Prefer the vault file, which the learner may have edited since it was written. */
  async withTutorNotesFile(session: QuizSession): Promise<QuizSession> {
    const notes = session.tutorNotes;
    if (!notes?.path || !notes.vaultId || !this.tutorNotesFile) return session;
    const text = await this.tutorNotesFile.read(notes.vaultId, notes.path);
    return text && text !== notes.text
      ? { ...session, tutorNotes: { ...notes, text } }
      : session;
  }

  async setAgentActivity(
    sessionId: string,
    agentToken: string,
    state: 'idle' | 'thinking' | 'drafting',
  ): Promise<QuizResult<QuizSession>> {
    await this.startupRecovery;
    const current = await this.store.get(sessionId);
    if (!current) return { ok: false, error: 'not-found' };
    if (current.agentToken !== agentToken || current.status !== 'connected')
      return { ok: false, error: 'unauthorized' };
    const session = await this.store.updateActivity(sessionId, agentToken, {
      state,
      updatedAt: this.now(),
    });
    return session
      ? { ok: true, value: session }
      : { ok: false, error: 'unauthorized' };
  }

  async request(request: QuizAgentRequest): Promise<QuizResult<QuizSession>> {
    await this.startupRecovery;
    if (
      request.type === 'answer' ||
      request.type === 'respond-prompt' ||
      request.type === 'continue' ||
      request.type === 'skip' ||
      request.type === 'message'
    )
      return { ok: false, error: 'invalid-input' };
    const current = await this.store.get(request.sessionId);
    if (!current) return { ok: false, error: 'not-found' };
    if (request.agentToken !== current.agentToken)
      return { ok: false, error: 'unauthorized' };
    if (request.type === 'lesson-map')
      return this.setLessonMap(request, current);
    if (request.type === 'practice-test') return this.setPracticeTest(request);
    if (request.type === 'tutor-notes')
      return this.setTutorNotes(request, current);
    const result = await this.applyRequest(current, request);
    if (
      request.type === 'pose-question' &&
      request.studyBasis &&
      this.finalizeStudyBasis
    ) {
      // The question and its basis already committed together. Cleanup failure
      // retains conservative pins; it must not turn an accepted write into failure.
      try {
        const committed = await this.store.get(request.sessionId);
        await this.finalizeStudyBasis(
          request.sessionId,
          committed?.currentQuestion?.studyBasis,
          request.idempotencyKey,
          committed?.revision ?? current.revision,
        );
      } catch {
        /* Reconcile conservative pins at startup if cleanup failed. */
      }
    }
    return result;
  }

  /** Trusted renderer adapter: the main process validates the IPC sender; no agent capability crosses the UI bridge. */
  async learnerRequest(
    request: QuizLearnerRequest,
  ): Promise<QuizResult<QuizSession>> {
    await this.startupRecovery;
    if (
      request.type !== 'answer' &&
      request.type !== 'continue' &&
      request.type !== 'skip' &&
      request.type !== 'message' &&
      request.type !== 'respond-prompt'
    )
      return { ok: false, error: 'invalid-input' };
    const current = await this.store.get(request.sessionId);
    if (!current) return { ok: false, error: 'not-found' };
    // Learner input is accepted only while an agent currently owns a connected session.
    // applyRequest's revision CAS ensures a concurrent Stop cannot commit stale input.
    if (current.status !== 'connected')
      return { ok: false, error: 'invalid-state' };
    return this.applyRequest(current, {
      ...request,
      agentToken: current.agentToken,
    });
  }

  private async applyRequest(
    current: QuizSession,
    request: QuizAgentRequest,
  ): Promise<QuizResult<QuizSession>> {
    if (!request.idempotencyKey.trim())
      return { ok: false, error: 'invalid-input' };
    if (request.type === 'message') {
      const ids = request.attachments ?? [];
      if (
        !Array.isArray(ids) ||
        ids.length > MAX_QUIZ_MESSAGE_IMAGES ||
        new Set(ids).size !== ids.length ||
        ids.some(
          (id) =>
            typeof id !== 'string' ||
            !this.imageRegistry.get(request.sessionId, id),
        ) ||
        (!request.text.trim() && ids.length === 0)
      )
        return { ok: false, error: 'invalid-input' };
    }
    // Receipts persist fingerprints; hash the full authenticated request so the
    // capability can never be recovered from the idempotency index.
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(request))
      .digest('hex');
    try {
      const prior = await this.store.idempotent(
        `${request.sessionId}:${request.idempotencyKey}`,
        fingerprint,
      );
      if (prior) {
        if (request.type === 'feedback') await this.reconcileSessions([prior]);
        return { ok: true, value: prior };
      }
    } catch {
      return { ok: false, error: 'invalid-input' };
    }
    // Store enforces key idempotency atomically; expected revision guards competing tabs/agents.
    if (current.revision !== request.expectedRevision)
      return { ok: false, error: 'stale-revision' };
    if (
      request.handledThroughCursor !== undefined &&
      (!Number.isSafeInteger(request.handledThroughCursor) ||
        request.handledThroughCursor < 0 ||
        request.handledThroughCursor > current.eventCursor ||
        request.handledThroughCursor < (current.pendingLearnerCursor ?? 0))
    )
      return { ok: false, error: 'stale-revision' };
    const next = structuredClone(current);
    const timestamp = this.now();
    /** Saved attempts read for a test item's freshness check, reused at commit. */
    let testSaved: LearnerAttempt[] | undefined;
    const deletions = this.store.deletions;
    const addMessage = (role: 'learner' | 'agent', text: string) =>
      next.transcript.push({
        id: randomUUID(),
        role,
        text,
        createdAt: timestamp,
      });
    switch (request.type) {
      case 'attach':
        if (next.status === 'complete')
          return { ok: false, error: 'invalid-state' };
        next.status = 'connected';
        break;
      case 'pose-question': {
        if (
          next.status !== 'connected' ||
          next.currentPrompt ||
          next.currentQuestion !== null
        )
          return { ok: false, error: 'invalid-state' };
        const kind = request.kind ?? 'multiple-choice';
        const choices: QuizChoice[] = request.choices ?? [];
        const validItems = (items: typeof request.leftItems) =>
          Array.isArray(items) &&
          items.length >= 2 &&
          items.length <= 12 &&
          new Set(items.map((item) => item.id)).size === items.length &&
          items.every(
            (item) =>
              typeof item.id === 'string' &&
              item.id.trim().length > 0 &&
              typeof item.text === 'string' &&
              item.text.trim().length > 0,
          );
        const validChoices =
          choices.length >= 1 &&
          choices.length <= 6 &&
          new Set(choices.map((choice) => choice.id)).size === choices.length &&
          choices.every(
            (choice) =>
              typeof choice.id === 'string' &&
              choice.id.trim().length > 0 &&
              typeof choice.text === 'string' &&
              choice.text.trim().length > 0,
          );
        const noChoices = choices.length === 0;
        if (
          typeof request.question !== 'string' ||
          !request.question.trim() ||
          (kind === 'multiple-choice' && !validChoices) ||
          (kind === 'matching' &&
            (!noChoices ||
              !validItems(request.leftItems) ||
              !validItems(request.rightItems) ||
              request.leftItems!.length !== request.rightItems!.length)) ||
          ((kind === 'short-answer' || kind === 'long-answer') && !noChoices) ||
          ![
            'multiple-choice',
            'matching',
            'short-answer',
            'long-answer',
          ].includes(kind)
        )
          return { ok: false, error: 'invalid-input' };
        const learning = quizLearningFromRequest(request);
        if (learning === null) return { ok: false, error: 'invalid-input' };
        const fingerprint = fingerprintOf({
          kind,
          prompt: request.question,
          choices,
          leftItems: request.leftItems,
          rightItems: request.rightItems,
        });
        const test = next.practiceTest;
        if (test) {
          const testFailure = !learning
            ? 'Practice test items must be tagged with concepts and level.'
            : learning.support !== 'independent'
              ? 'Practice test items must be independent: no hints or worked examples.'
              : !learning.concepts.some((id) => test.concepts.includes(id))
                ? `Tag the item with at least one test concept: ${test.concepts.join(', ')}.`
                : undefined;
          if (testFailure)
            return { ok: false, error: 'invalid-input', message: testFailure };
          // Freshness spans every item the learner has been shown in this
          // pool, including saved attempts whose quiz has since been deleted.
          // The commit rechecks against sessions written meanwhile.
          testSaved = await this.savedAttempts(next);
          const pool = poolFrom(
            next,
            await this.store.list({ includeDrafts: true }),
            testSaved,
          );
          if (seenInPool(pool, next, fingerprint))
            return {
              ok: false,
              error: 'invalid-input',
              message:
                'The learner has already seen this item; practice test items must be fresh.',
            };
        }
        if (request.studyBasis !== undefined) {
          if (
            typeof request.studyBasis !== 'string' ||
            !/^[a-f0-9]{64}$/.test(request.studyBasis) ||
            !this.prepareStudyBasis
          )
            return { ok: false, error: 'study-unavailable' };
          try {
            await this.prepareStudyBasis(
              current,
              request.studyBasis,
              request.idempotencyKey,
            );
          } catch {
            return { ok: false, error: 'study-unavailable' };
          }
        }
        const questionId = randomUUID();
        // Presentation order is decided once here and persisted, so answer
        // position carries no clue while IDs, scoring, submitted drafts and
        // reattachment keep reading the stored order.
        const safeQuestion = {
          id: questionId,
          ...(request.studyBasis ? { studyBasis: request.studyBasis } : {}),
          ...(learning ? { learning } : {}),
          ...(request.unmodelledReason
            ? { unmodelledReason: request.unmodelledReason }
            : {}),
          fingerprint,
          ...(test ? { testId: test.id } : {}),
          kind,
          prompt: request.question,
          choices:
            kind === 'multiple-choice'
              ? orderQuizChoices(structuredClone(choices), questionId)
              : structuredClone(choices),
          ...(kind === 'matching'
            ? {
                leftItems: structuredClone(request.leftItems!),
                rightItems: orderQuizMatchOptions(
                  structuredClone(request.rightItems!),
                  questionId,
                ),
              }
            : {}),
        };
        next.transcript.push({
          id: randomUUID(),
          role: 'agent',
          text: request.question,
          createdAt: timestamp,
          kind: 'question',
          question: safeQuestion,
        });
        next.currentPrompt = null;
        next.currentQuestion = {
          ...safeQuestion,
          status: 'open',
          selectedChoiceId: null,
          reasoningDraft: '',
          feedback: null,
        };
        // Focus moves at commit time (see atCommit) so a status written
        // meanwhile, such as a demotion from another quiz, is not overwritten.
        break;
      }
      case 'answer': {
        const question = next.currentQuestion;
        if (next.status !== 'connected' || question?.status !== 'open')
          return { ok: false, error: 'invalid-state' };
        if (
          request.confidence !== undefined &&
          !isQuizConfidence(request.confidence)
        )
          return { ok: false, error: 'invalid-input' };
        let answerText: string;
        if ((question.kind ?? 'multiple-choice') === 'multiple-choice') {
          if (
            typeof request.choiceId !== 'string' ||
            typeof request.reasoning !== 'string' ||
            !question.choices.some(
              (choice) => choice.id === request.choiceId,
            ) ||
            request.matches !== undefined ||
            request.answer !== undefined
          )
            return { ok: false, error: 'invalid-input' };
          question.selectedChoiceId = request.choiceId;
          question.reasoningDraft = request.reasoning;
          answerText = `${question.choices.find((choice) => choice.id === request.choiceId)!.text}${request.reasoning.trim() ? `\nReasoning: ${request.reasoning}` : ''}`;
        } else if (question.kind === 'matching') {
          const leftIds = question.leftItems?.map((item) => item.id) ?? [];
          const rightIds = question.rightItems?.map((item) => item.id) ?? [];
          const matches = request.matches;
          if (
            !matches ||
            request.choiceId !== undefined ||
            (request.reasoning !== undefined &&
              typeof request.reasoning !== 'string') ||
            request.answer !== undefined ||
            Object.keys(matches).length !== leftIds.length ||
            leftIds.some(
              (id) =>
                typeof matches[id] !== 'string' ||
                !rightIds.includes(matches[id]!),
            ) ||
            new Set(Object.values(matches)).size !== leftIds.length
          )
            return { ok: false, error: 'invalid-input' };
          question.matchesDraft = structuredClone(matches);
          question.reasoningDraft = request.reasoning ?? '';
          answerText = `${JSON.stringify(matches)}${request.reasoning?.trim() ? `\nReasoning: ${request.reasoning}` : ''}`;
        } else {
          const answer = request.answer;
          const limit = question.kind === 'short-answer' ? 2000 : 20000;
          if (
            typeof answer !== 'string' ||
            !answer.trim() ||
            answer.length > limit ||
            request.choiceId !== undefined ||
            request.reasoning !== undefined ||
            request.matches !== undefined
          )
            return { ok: false, error: 'invalid-input' };
          question.textDraft = answer;
          answerText = answer;
        }
        question.status = 'answered';
        if (request.confidence !== undefined)
          question.confidence = request.confidence;
        next.transcript.push({
          id: randomUUID(),
          role: 'learner',
          text: answerText,
          createdAt: timestamp,
          kind: 'answer',
        });
        break;
      }
      case 'pose-prompt': {
        if (next.status !== 'connected' || next.currentPrompt)
          return { ok: false, error: 'invalid-state' };
        if (
          (next.currentQuestion &&
            next.currentQuestion.status !== 'feedback') ||
          !request.prompt.trim() ||
          request.choices.length < 1 ||
          request.choices.length > 6 ||
          new Set(request.choices.map((c) => c.id)).size !==
            request.choices.length ||
          request.choices.some(
            (c) =>
              !c.id.trim() ||
              !c.text.trim() ||
              (c.effect !== undefined && c.effect !== 'continue'),
          ) ||
          (request.choices.some((c) => c.effect === 'continue') &&
            next.currentQuestion?.status !== 'feedback')
        )
          return { ok: false, error: 'invalid-input' };
        next.currentPrompt = {
          id: request.promptId?.trim() || randomUUID(),
          kind: request.kind,
          prompt: request.prompt,
          choices: structuredClone(request.choices),
        };
        addMessage('agent', request.prompt);
        break;
      }
      case 'agent-message':
        if (next.status !== 'connected' || !request.text.trim())
          return { ok: false, error: 'invalid-state' };

        addMessage('agent', request.text);
        break;
      case 'support-update': {
        const question = next.currentQuestion;
        if (
          next.status !== 'connected' ||
          question?.status !== 'open' ||
          question.id !== request.questionId
        )
          return { ok: false, error: 'invalid-state' };
        if (question.testId && question.testId === next.practiceTest?.id)
          return {
            ok: false,
            error: 'invalid-state',
            message:
              'Practice test items take no help. Skip the item (it will not count) if the learner needs support.',
          };
        if (
          !QUIZ_SUPPORTS.includes(request.support) ||
          typeof request.text !== 'string' ||
          !request.text.trim() ||
          request.text.length > 10000
        )
          return { ok: false, error: 'invalid-input' };
        const previous =
          question.suppliedSupport ??
          question.learning?.support ??
          'independent';
        const support =
          QUIZ_SUPPORTS[
            Math.max(
              QUIZ_SUPPORTS.indexOf(previous),
              QUIZ_SUPPORTS.indexOf(request.support),
            )
          ]!;
        question.suppliedSupport = support;
        if (question.learning) question.learning.support = support;
        // The original question and the later grade both retain the supplied help.
        const posed = next.transcript.find(
          (message) => message.question?.id === question.id,
        )?.question;
        if (posed) {
          posed.suppliedSupport = support;
          if (posed.learning) posed.learning.support = support;
        }
        addMessage('agent', request.text);
        break;
      }
      case 'feedback': {
        if (
          next.status !== 'connected' ||
          next.currentQuestion?.status !== 'answered' ||
          !request.text.trim()
        )
          return { ok: false, error: 'invalid-state' };
        if (request.reasoning !== undefined) {
          if (!QUIZ_REASONING_ASSESSMENTS.includes(request.reasoning))
            return { ok: false, error: 'invalid-input' };
          const stated =
            next.currentQuestion.reasoningDraft.trim() ||
            next.currentQuestion.textDraft?.trim();
          if (request.reasoning !== 'none' && !stated)
            return {
              ok: false,
              error: 'invalid-input',
              message:
                'The learner gave no reasoning to assess; use reasoning "none" or omit it.',
            };
          next.currentQuestion.reasoning = request.reasoning;
        }
        next.currentQuestion.feedback = request.text;
        next.currentQuestion.gradedAt = timestamp;
        if (request.verdict !== undefined)
          next.currentQuestion.verdict = request.verdict;
        next.currentQuestion.status = 'feedback';
        addMessage('agent', request.text);
        if (request.verdict) {
          const question = next.currentQuestion;
          const selectedChoice = question.selectedChoiceId
            ? question.choices.find(
                (choice) => choice.id === question.selectedChoiceId,
              )
            : undefined;
          next.transcript[next.transcript.length - 1]!.question = {
            id: question.id,
            gradedAt: timestamp,
            ...(question.suppliedSupport
              ? { suppliedSupport: question.suppliedSupport }
              : {}),
            ...(question.unmodelledReason
              ? { unmodelledReason: question.unmodelledReason }
              : {}),
            ...(question.learning ? { learning: question.learning } : {}),
            ...(question.confidence !== undefined
              ? { confidence: question.confidence }
              : {}),
            ...(question.fingerprint
              ? { fingerprint: question.fingerprint }
              : {}),
            ...(question.testId ? { testId: question.testId } : {}),
            ...(question.reasoning ? { reasoning: question.reasoning } : {}),
            kind: question.kind,
            prompt: question.prompt,
            choices: question.choices,
            verdict: request.verdict,
            ...(selectedChoice ? { answerLabel: selectedChoice.text } : {}),
            ...(selectedChoice
              ? {
                  chosenChoiceId: selectedChoice.id,
                  chosenChoiceText: selectedChoice.text,
                }
              : {}),
          };
        }
        break;
      }
      case 'respond-prompt': {
        const prompt = next.currentPrompt;
        const choice = prompt?.choices.find((c) => c.id === request.choiceId);
        if (
          next.status !== 'connected' ||
          !prompt ||
          prompt.id !== request.promptId ||
          !choice
        )
          return { ok: false, error: 'invalid-state' };
        if (
          choice.effect === 'continue' &&
          next.currentQuestion?.status !== 'feedback'
        )
          return { ok: false, error: 'invalid-state' };
        const detail = request.detail ?? '';
        if (typeof detail !== 'string' || detail.length > 20000)
          return { ok: false, error: 'invalid-input' };
        next.transcript.push({
          id: randomUUID(),
          role: 'learner',
          text: `${choice.text}${detail.trim() ? `\n${detail}` : ''}`,
          createdAt: timestamp,
        });
        next.currentPrompt = null;
        if (choice.effect === 'continue') next.currentQuestion = null;
        break;
      }
      case 'skip':
      case 'skip-question': {
        const question = next.currentQuestion;
        if (
          next.status !== 'connected' ||
          next.currentPrompt ||
          !question ||
          question.id !== request.questionId ||
          (question.status !== 'open' && question.status !== 'answered')
        )
          return { ok: false, error: 'invalid-state' };
        if (
          request.type === 'skip-question' &&
          (typeof request.text !== 'string' ||
            !request.text.trim() ||
            request.text.length > 10000)
        )
          return { ok: false, error: 'invalid-input' };
        addMessage(
          request.type === 'skip' ? 'learner' : 'agent',
          request.type === 'skip' ? 'Skipped question.' : request.text,
        );
        next.currentQuestion = null;
        break;
      }
      case 'continue':
        if (
          next.currentPrompt ||
          next.status !== 'connected' ||
          next.currentQuestion?.status !== 'feedback'
        )
          return { ok: false, error: 'invalid-state' };
        next.currentQuestion = null;
        break;
      case 'message': {
        const attachments = (request.attachments ?? []).map(
          (id) => this.imageRegistry.get(request.sessionId, id)?.metadata,
        );
        if (
          next.status !== 'connected' ||
          (!request.text.trim() && attachments.length === 0) ||
          attachments.some((item) => !item)
        )
          return { ok: false, error: 'invalid-input' };
        next.transcript.push({
          id: randomUUID(),
          role: 'learner',
          text: request.text,
          createdAt: timestamp,
          ...(attachments.length
            ? {
                attachments: attachments as NonNullable<
                  QuizMessage['attachments']
                >,
              }
            : {}),
        });
        break;
      }
    }
    if (
      request.type === 'answer' ||
      request.type === 'respond-prompt' ||
      request.type === 'continue' ||
      request.type === 'skip' ||
      request.type === 'message'
    ) {
      next.awaitingAgent = true;
      next.pendingLearnerCursor = current.eventCursor + 1;
    } else if (
      request.type === 'pose-question' ||
      request.type === 'pose-prompt' ||
      request.type === 'feedback' ||
      request.type === 'skip-question' ||
      request.type === 'agent-message' ||
      request.type === 'support-update'
    ) {
      next.awaitingAgent = false;
      next.respondedThroughCursor =
        request.handledThroughCursor ??
        current.pendingLearnerCursor ??
        current.eventCursor;
    }
    next.revision++;
    next.eventCursor++;
    next.updatedAt = timestamp;
    const event: QuizEvent = {
      cursor: next.eventCursor,
      revision: next.revision,
      type: request.type,
      data: (() => {
        switch (request.type) {
          case 'pose-prompt':
            return { prompt: next.currentPrompt };
          case 'respond-prompt':
            return {
              promptId: request.promptId,
              choiceId: request.choiceId,
              choiceText: next.transcript[next.transcript.length - 1]!.text,
              ...(current.currentPrompt?.choices.find(
                (choice) => choice.id === request.choiceId,
              )?.effect === 'continue'
                ? { effect: 'continue' }
                : {}),
              ...(request.detail !== undefined
                ? { detail: request.detail }
                : {}),
            };
          case 'pose-question':
            return {
              question: next.currentQuestion,
            };
          case 'answer':
            return {
              ...(request.choiceId !== undefined
                ? { choiceId: request.choiceId }
                : {}),
              ...(request.reasoning !== undefined
                ? { reasoning: request.reasoning }
                : {}),
              ...(request.matches !== undefined
                ? { matches: request.matches }
                : {}),
              ...(request.answer !== undefined
                ? { answer: request.answer }
                : {}),
              ...(request.confidence !== undefined
                ? { confidence: request.confidence }
                : {}),
            };
          case 'support-update':
            return {
              questionId: request.questionId,
              support: next.currentQuestion?.suppliedSupport,
              text: request.text,
            };
          case 'skip':
            return { questionId: request.questionId };
          case 'skip-question':
            return { questionId: request.questionId, text: request.text };
          case 'agent-message':
            return { text: request.text };
          case 'feedback':
            return {
              text: request.text,
              ...(request.verdict ? { verdict: request.verdict } : {}),
              ...(request.reasoning ? { reasoning: request.reasoning } : {}),
            };
          case 'message':
            return {
              text: request.text,
              attachments: (request.attachments ?? []).map(
                (id) => this.imageRegistry.get(request.sessionId, id)!.metadata,
              ),
            };
          case 'attach':
          case 'continue':
            return {};
        }
      })(),
      createdAt: timestamp,
    };
    try {
      const updated = await this.store.update(
        next,
        current.revision,
        event,
        `${request.sessionId}:${request.idempotencyKey}`,
        fingerprint,
        (merged, sessions) => {
          // Test conditions were checked against the test open when the
          // request started; if a test opened or closed since, or another pool
          // session showed the same item meanwhile, re-read status.
          const posed = merged.currentQuestion;
          if (request.type === 'pose-question') {
            if (posed?.testId !== merged.practiceTest?.id)
              throw new Error('Practice test changed during the request');
            if (
              testSaved &&
              learnerScopeKey(merged.scope, merged.id) !==
                learnerScopeKey(current.scope, current.id)
            )
              throw new Error('Study scope changed during the request');
            if (testSaved && this.store.deletions !== deletions)
              throw new Error('A pool quiz was deleted during the request');
            if (
              posed?.testId &&
              posed.fingerprint &&
              seenInPool(
                poolFrom(merged, sessions, testSaved ?? []),
                { ...merged, transcript: merged.transcript.slice(0, -1) },
                posed.fingerprint,
              )
            )
              throw new Error('Practice test item shown elsewhere meanwhile');
          }
          if (request.type === 'pose-question') {
            const focused = focusLessonMap(
              merged.lessonMap,
              merged.currentQuestion?.learning?.concepts,
              timestamp,
            );
            return focused ? { ...merged, lessonMap: focused } : merged;
          }
          return request.type === 'feedback'
            ? withLapsedMastery(merged, merged.currentQuestion, timestamp)
            : merged;
        },
        // Mastery is per learning pool, so a miss withdraws the claim on every
        // quiz map in the pool, not only this one.
        (merged, sessions) => {
          if (request.type !== 'feedback') return [];
          const pool = learnerScopeKey(merged.scope, merged.id);
          return sessions.flatMap((other) => {
            if (
              other.id === merged.id ||
              learnerScopeKey(other.scope, other.id) !== pool
            )
              return [];
            const lapsed = withLapsedMastery(
              other,
              merged.currentQuestion,
              timestamp,
            );
            return lapsed === other ? [] : [lapsed];
          });
        },
      );
      if (updated.transcript.length > 0) await this.store.promote(updated.id);
      if (request.type === 'feedback' && updated.currentQuestion)
        await this.recordGradedQuestion(updated, updated.currentQuestion);
      return { ok: true, value: updated };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error && error.message.includes('Idempotency')
            ? 'invalid-input'
            : 'stale-revision',
      };
    }
  }

  async saveDraft(
    sessionId: string,
    expectedRevision: number,
    draft: import('../shared/quizProtocol').QuizDraft,
  ): Promise<QuizResult<QuizSession>> {
    await this.startupRecovery;
    const current = await this.store.get(sessionId);
    if (!current) return { ok: false, error: 'not-found' };
    if (current.revision !== expectedRevision)
      return { ok: false, error: 'stale-revision' };
    const next = structuredClone(current);
    next.freeChatDraft = draft.freeChatDraft;
    if (draft.promptId && next.currentPrompt?.id === draft.promptId) {
      if (
        draft.selectedPromptChoiceId === undefined ||
        next.currentPrompt.choices.some(
          (choice) => choice.id === draft.selectedPromptChoiceId,
        )
      ) {
        if (draft.selectedPromptChoiceId !== undefined)
          next.currentPrompt.selectedChoiceId = draft.selectedPromptChoiceId;
        if (draft.promptDetailDraft !== undefined)
          next.currentPrompt.detailDraft = draft.promptDetailDraft;
      }
    }
    if (
      draft.questionId &&
      next.currentQuestion?.id === draft.questionId &&
      next.currentQuestion.status === 'open'
    ) {
      next.currentQuestion.selectedChoiceId = draft.selectedChoiceId;
      next.currentQuestion.reasoningDraft = draft.reasoningDraft;
      if (
        draft.matchesDraft !== undefined &&
        next.currentQuestion.kind === 'matching'
      )
        next.currentQuestion.matchesDraft = structuredClone(draft.matchesDraft);
      if (
        draft.textDraft !== undefined &&
        (next.currentQuestion.kind === 'short-answer' ||
          next.currentQuestion.kind === 'long-answer')
      )
        next.currentQuestion.textDraft = draft.textDraft;
    }
    const draftChanged =
      next.freeChatDraft !== current.freeChatDraft ||
      JSON.stringify(next.currentPrompt) !==
        JSON.stringify(current.currentPrompt) ||
      JSON.stringify(next.currentQuestion) !==
        JSON.stringify(current.currentQuestion);
    if (!draftChanged) return { ok: true, value: current };
    next.updatedAt = this.now();
    try {
      return {
        ok: true,
        value: await this.store.updateDraft(next, current.revision),
      };
    } catch {
      return { ok: false, error: 'stale-revision' };
    }
  }

  async setFreeChatDraft(
    sessionId: string,
    expectedRevision: number,
    draft: string,
  ): Promise<QuizResult<QuizSession>> {
    const current = await this.store.get(sessionId);
    return this.saveDraft(sessionId, expectedRevision, {
      questionId: current?.currentQuestion?.id ?? null,
      selectedChoiceId: current?.currentQuestion?.selectedChoiceId ?? null,
      reasoningDraft: current?.currentQuestion?.reasoningDraft ?? '',
      freeChatDraft: draft,
    });
  }

  /** User-authorized stop; never accepts an agent capability. */
  async stopAgent(sessionId: string): Promise<QuizResult<QuizSession>> {
    await this.startupRecovery;
    const operation = this.attachQueue.then(() =>
      this.stopAgentExclusive(sessionId),
    );
    this.attachQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async disconnectAgent(
    sessionId: string,
    agentToken: string,
  ): Promise<QuizResult<QuizSession>> {
    await this.startupRecovery;
    return this.disconnectAgentExclusive(sessionId, agentToken);
  }

  private async stopAgentExclusive(
    sessionId: string,
  ): Promise<QuizResult<QuizSession>> {
    const current = await this.store.get(sessionId);
    if (!current) return { ok: false, error: 'not-found' };
    if (current.status !== 'connected') return { ok: true, value: current };
    const next = {
      ...current,
      agentToken: randomUUID(),
      status: 'disconnected' as const,
      activity: undefined,
      awaitingAgent: false,
      revision: current.revision + 1,
      eventCursor: current.eventCursor + 1,
      updatedAt: this.now(),
    };
    try {
      return {
        ok: true,
        value: await this.store.update(
          next,
          current.revision,
          {
            cursor: next.eventCursor,
            revision: next.revision,
            type: 'agent-disconnected',
            data: {},
            createdAt: next.updatedAt,
          },
          `${sessionId}:user-stop:${next.revision}`,
          JSON.stringify([sessionId, next.revision]),
        ),
      };
    } catch {
      return { ok: false, error: 'stale-revision' };
    }
  }

  private async disconnectAgentExclusive(
    sessionId: string,
    agentToken: string,
  ): Promise<QuizResult<QuizSession>> {
    const current = await this.store.get(sessionId);
    if (!current) return { ok: false, error: 'not-found' };
    if (current.agentToken !== agentToken)
      return { ok: false, error: 'unauthorized' };
    if (current.status !== 'connected') return { ok: true, value: current };
    const next = {
      ...current,
      status: 'disconnected' as const,
      activity: undefined,
      awaitingAgent: false,
      revision: current.revision + 1,
      eventCursor: current.eventCursor + 1,
      updatedAt: this.now(),
    };
    const event: QuizEvent = {
      cursor: next.eventCursor,
      revision: next.revision,
      type: 'disconnect',
      data: {},
      createdAt: next.updatedAt,
    };
    try {
      return {
        ok: true,
        value: await this.store.update(
          next,
          current.revision,
          event,
          `${sessionId}:disconnect:${next.revision}`,
          JSON.stringify([sessionId, next.revision]),
        ),
      };
    } catch {
      return { ok: false, error: 'stale-revision' };
    }
  }
}
