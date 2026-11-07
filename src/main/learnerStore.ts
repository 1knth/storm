import { readFile, stat } from 'node:fs/promises';
import type { QuizStore } from './quizStore';
import {
  computeLearnerState,
  type LearnerAttempt,
  type LearnerState,
} from '../shared/learnerModel';
import type {
  QuizQuestion,
  QuizScope,
  QuizSession,
} from '../shared/quizProtocol';

/** Attempts are the only persisted facts; learner state is recomputed by replay. */
type LearnerDatabase = {
  version: 1;
  scopes: Record<string, { attempts: LearnerAttempt[] }>;
};

/** Concepts accumulate per vault so evidence carries across sessions on the same material. */
export function learnerScopeKey(
  scope: QuizScope | undefined,
  sessionId?: string,
): string {
  // Never replay the historical global unscoped pool into unrelated sessions.
  return scope ? `vault:${scope.vaultId}` : `session:${sessionId ?? 'unknown'}`;
}

/** Exact session scope, used only to prioritize concepts from the current material. */
export function learnerScopeSignature(scope: QuizScope | undefined): string {
  if (!scope) return 'unscoped';
  return JSON.stringify([
    scope.vaultId,
    scope.notePath,
    scope.folderPath,
    [...scope.selectedNotePaths].sort(),
  ]);
}

/** Tagged grades inform concepts; all rated grades inform confidence calibration. */
export function learnerAttempt(
  session: Pick<QuizSession, 'id' | 'scope' | 'updatedAt' | 'practiceTestLog'>,
  question: QuizQuestion,
): LearnerAttempt | null {
  if (
    !question.verdict ||
    (!question.learning && question.confidence === undefined)
  )
    return null;
  return {
    id: question.id,
    sessionId: session.id,
    scopeSignature: learnerScopeSignature(session.scope),
    at: question.gradedAt ?? session.updatedAt,
    concepts: [...(question.learning?.concepts ?? [])],
    level: question.learning?.level ?? 'recall',
    support:
      question.suppliedSupport ?? question.learning?.support ?? 'unknown',
    verdict: question.verdict,
    ...(question.confidence !== undefined
      ? { confidence: question.confidence }
      : {}),
    ...(question.fingerprint ? { fingerprint: question.fingerprint } : {}),
    // Only a completed test is test evidence; cancelled or open tests are not.
    ...(question.testId &&
    session.practiceTestLog?.completed.includes(question.testId)
      ? { testId: question.testId }
      : {}),
    ...(question.reasoning ? { reasoning: question.reasoning } : {}),
  };
}

export class LearnerStore {
  private cache?: { signature: string; data: LearnerDatabase };
  constructor(
    private readonly file: string,
    private readonly now = () => new Date(),
  ) {}

  private source?: QuizStore;
  async connect(source: QuizStore): Promise<void> {
    if (!(await source.hasLearnerImport()))
      await source.importLearner((await this.load()).scopes);
    this.source = source;
  }

  private async load(): Promise<LearnerDatabase> {
    try {
      const info = await stat(this.file);
      const signature = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      if (this.cache?.signature === signature) return this.cache.data;
      const data = JSON.parse(
        await readFile(this.file, 'utf8'),
      ) as LearnerDatabase;
      if (data.version !== 1 || !data.scopes || typeof data.scopes !== 'object')
        throw new Error('LEARNER_STORE_INVALID');
      this.cache = { signature, data };
      return data;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT')
        return { version: 1, scopes: {} };
      throw e;
    }
  }

  async attempts(scopeKey: string): Promise<LearnerAttempt[]> {
    if (this.source) return this.source.attempts(scopeKey);
    return structuredClone(
      (await this.load()).scopes[scopeKey]?.attempts ?? [],
    );
  }

  async state(
    scope: QuizScope | undefined,
    sessionId?: string,
  ): Promise<
    LearnerState & { diagnostics: { untagged: number; ratedUntagged: number } }
  > {
    const scopeKey = learnerScopeKey(scope, sessionId);
    const attempts = await this.attempts(scopeKey);
    const state = computeLearnerState(attempts, {
      scopeKey,
      scopeSignature: learnerScopeSignature(scope),
      now: this.now(),
    });
    return {
      ...state,
      diagnostics: {
        untagged: attempts.filter((a) => a.concepts.length === 0).length,
        ratedUntagged: attempts.filter(
          (a) => a.concepts.length === 0 && a.confidence !== undefined,
        ).length,
      },
    };
  }
}
