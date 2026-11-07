import { createHash } from 'node:crypto';
import type { QuizQuestion, QuizSession } from '../shared/quizProtocol';
import type { LearnerAttempt } from '../shared/learnerModel';
import {
  questionFingerprintSource,
  type MasteryExposure,
} from '../shared/mastery';
import type { QuizEvent } from '../shared/quizProtocol';
import { learnerScopeKey, learnerScopeSignature } from './learnerStore';
import { learnerAttempt } from './learnerStore';
/** Every graded question in a session, rebuilt from its durable transcript. */
export function gradedQuestions(session: QuizSession): QuizQuestion[] {
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
export const fingerprintOf = (
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
export function sessionEvidence(session: QuizSession): {
  attempts: LearnerAttempt[];
  exposures: MasteryExposure[];
  unmodelled: number;
  tests: Record<string, string>;
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
  return {
    attempts,
    exposures,
    tests: Object.fromEntries(
      gradedQuestions(session).flatMap((question) =>
        question.testId ? [[question.id, question.testId]] : [],
      ),
    ),
    unmodelled: gradedQuestions(session).filter(
      (question) => !question.learning,
    ).length,
  };
}

export type QuizFacts = ReturnType<typeof sessionEvidence>;
export type PoolEvidence = Pick<QuizFacts, 'attempts' | 'exposures'>;

/** Advance canonical facts from the operation, without replaying durable history. */
export function advanceQuizFacts(
  facts: QuizFacts,
  before: QuizSession,
  after: QuizSession,
  event?: QuizEvent,
): QuizFacts {
  let { attempts, exposures, unmodelled, tests } = facts;
  const question = after.currentQuestion;
  if (event?.type === 'pose-question' && question)
    exposures = [
      ...exposures,
      {
        id: question.id,
        at: event.createdAt,
        fingerprint: question.fingerprint ?? fingerprintOf(question),
      },
    ];
  if (event?.type === 'feedback' && question?.verdict) {
    const attempt = learnerAttempt(after, question);
    if (attempt)
      attempts = [
        ...attempts.filter((item) => item.id !== attempt.id),
        attempt,
      ];
    if (!question.learning) unmodelled++;
    if (question.testId) tests = { ...tests, [question.id]: question.testId };
  }
  if (before.practiceTestLog !== after.practiceTestLog) {
    attempts = attempts.map((attempt) => {
      const testId = tests[attempt.id];
      return testId && after.practiceTestLog?.completed.includes(testId)
        ? { ...attempt, testId }
        : attempt;
    });
  }
  if (before.scope !== after.scope)
    attempts = attempts.map((attempt) => ({
      ...attempt,
      scopeSignature: learnerScopeSignature(after.scope),
    }));
  if (
    attempts === facts.attempts &&
    exposures === facts.exposures &&
    tests === facts.tests &&
    unmodelled === facts.unmodelled
  )
    return facts;
  return { attempts, exposures, tests, unmodelled };
}

/** A transaction-local index of canonical facts; pools are materialized at most once. */
export class QuizEvidenceIndex {
  private pools = new Map<string, PoolEvidence>();
  constructor(
    private sessions: QuizSession[],
    private facts: Record<string, QuizFacts>,
    private archived?: {
      scopes: Record<string, LearnerAttempt[]>;
      exposures?: Record<string, MasteryExposure[]>;
    },
  ) {}
  session(id: string): QuizFacts {
    const facts = this.facts[id];
    if (!facts) throw new Error(`Missing canonical quiz facts: ${id}`);
    return facts;
  }
  pool(session: Pick<QuizSession, 'id' | 'scope'>): PoolEvidence {
    return this.scope(learnerScopeKey(session.scope, session.id));
  }
  scope(key: string): PoolEvidence {
    const cached = this.pools.get(key);
    if (cached) return cached;
    const attempts = new Map(
      (this.archived?.scopes[key] ?? []).map((attempt) => [
        attempt.id,
        attempt,
      ]),
    );
    const exposures = [...(this.archived?.exposures?.[key] ?? [])];
    for (const session of this.sessions) {
      if (learnerScopeKey(session.scope, session.id) !== key) continue;
      const facts = this.session(session.id);
      for (const attempt of facts.attempts) attempts.set(attempt.id, attempt);
      exposures.push(...facts.exposures);
    }
    const pool = { attempts: [...attempts.values()], exposures };
    this.pools.set(key, pool);
    return pool;
  }
  seen(session: QuizSession, fingerprint: string): boolean {
    const pool = this.pool(session);
    return [...pool.exposures, ...pool.attempts].some(
      (item) => item.fingerprint === fingerprint,
    );
  }
}
