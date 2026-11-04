import { createHash, randomUUID } from 'node:crypto';
import {
  isQuizConfidence,
  QUIZ_SUPPORTS,
  quizLearningFromRequest,
  type QuizAgentRequest,
  type QuizChoice,
  type QuizEvent,
  type QuizMessage,
  type QuizLearnerRequest,
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
    for (const session of sessions) {
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
      for (const question of questions.values())
        entries.push({ session, question });
    }
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

  /** Lesson maps are display metadata: no revision, event, or Continue gate. */
  private async setLessonMap(
    request: Extract<QuizAgentRequest, { type: 'lesson-map' }>,
  ): Promise<QuizResult<QuizSession>> {
    if (!isLessonMapUpdate(request.map))
      return { ok: false, error: 'invalid-input' };
    const result = await this.store.setLessonMap(
      request.sessionId,
      request.agentToken,
      (session) => {
        if (session.status !== 'connected') return 'invalid-state';
        const map = applyLessonMapUpdate(
          session.lessonMap,
          request.map,
          this.now(),
        );
        return typeof map === 'string'
          ? 'invalid-input'
          : { ...session, lessonMap: map };
      },
    );
    if (result === undefined) return { ok: false, error: 'unauthorized' };
    if (result === 'invalid-state' || result === 'invalid-input')
      return { ok: false, error: result };
    if (typeof result === 'string')
      return { ok: false, error: 'invalid-input' };
    return { ok: true, value: result };
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
    if (request.type === 'lesson-map') return this.setLessonMap(request);
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
        const focused = focusLessonMap(
          next.lessonMap,
          learning?.concepts,
          timestamp,
        );
        if (focused) next.lessonMap = focused;
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
      case 'feedback':
        if (
          next.status !== 'connected' ||
          next.currentQuestion?.status !== 'answered' ||
          !request.text.trim()
        )
          return { ok: false, error: 'invalid-state' };
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
