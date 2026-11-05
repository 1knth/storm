import { mkdir, readFile, rename, writeFile, stat, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { KeyedQueue } from '../shared/asyncQueue';
import {
  LEARNER_LIMITS,
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
  private readonly queue = new KeyedQueue();
  private cache?: { signature: string; data: LearnerDatabase };
  constructor(
    private readonly file: string,
    private readonly now = () => new Date(),
  ) {}

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

  /** Idempotent by question ID; a batch performs one load, comparison and write. */
  async recordMany(
    scopeKey: string,
    attempts: LearnerAttempt[],
  ): Promise<void> {
    if (!attempts.length) return;
    await this.queue.run('store', async () => {
      const original = await this.load();
      const previous = original.scopes[scopeKey]?.attempts ?? [];
      const merged = new Map(previous.map((attempt) => [attempt.id, attempt]));
      for (const attempt of attempts) merged.set(attempt.id, attempt);
      const next = [...merged.values()]
        .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
        .slice(-LEARNER_LIMITS.attemptsPerScope);
      if (JSON.stringify(previous) === JSON.stringify(next)) return;
      const data = structuredClone(original);
      data.scopes[scopeKey] = { attempts: structuredClone(next) };
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
        await rename(temporary, this.file);
      } finally {
        await rm(temporary, { force: true });
      }
      this.cache = undefined;
    });
  }

  async record(scopeKey: string, attempt: LearnerAttempt): Promise<void> {
    await this.recordMany(scopeKey, [attempt]);
  }

  /** Group a full replay across sessions into one merge per learning pool. */
  async recordGrades(
    entries: Array<{
      session: Pick<
        QuizSession,
        'id' | 'scope' | 'updatedAt' | 'practiceTestLog'
      >;
      question: QuizQuestion;
    }>,
  ): Promise<void> {
    const scopes = new Map<string, LearnerAttempt[]>();
    for (const { session, question } of entries) {
      const attempt = learnerAttempt(session, question);
      if (!attempt) continue;
      const key = learnerScopeKey(session.scope, session.id);
      const attempts = scopes.get(key) ?? [];
      attempts.push(attempt);
      scopes.set(key, attempts);
    }
    for (const [key, attempts] of scopes) await this.recordMany(key, attempts);
  }

  async recordQuestion(
    session: Pick<
      QuizSession,
      'id' | 'scope' | 'updatedAt' | 'practiceTestLog'
    >,
    question: QuizQuestion,
  ): Promise<void> {
    await this.recordGrades([{ session, question }]);
  }

  async attempts(scopeKey: string): Promise<LearnerAttempt[]> {
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
