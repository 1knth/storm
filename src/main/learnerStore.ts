import { mkdir, readFile, rename, writeFile, stat } from 'node:fs/promises';
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
  session: Pick<QuizSession, 'id' | 'scope' | 'updatedAt'>,
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

  /** Idempotent by question ID: a regraded question replaces its earlier attempt. */
  async record(scopeKey: string, attempt: LearnerAttempt): Promise<void> {
    await this.queue.run('store', async () => {
      const data = structuredClone(await this.load());
      const scope = (data.scopes[scopeKey] ??= { attempts: [] });
      scope.attempts = scope.attempts.filter((item) => item.id !== attempt.id);
      scope.attempts.push(structuredClone(attempt));
      scope.attempts.sort(
        (a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id),
      );
      if (scope.attempts.length > LEARNER_LIMITS.attemptsPerScope)
        scope.attempts.splice(
          0,
          scope.attempts.length - LEARNER_LIMITS.attemptsPerScope,
        );
      if (JSON.stringify(data) === JSON.stringify(await this.load())) return;
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
      await rename(temporary, this.file);
      this.cache = undefined;
    });
  }

  async recordQuestion(
    session: Pick<QuizSession, 'id' | 'scope' | 'updatedAt'>,
    question: QuizQuestion,
  ): Promise<void> {
    const attempt = learnerAttempt(session, question);
    if (attempt)
      await this.record(learnerScopeKey(session.scope, session.id), attempt);
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
