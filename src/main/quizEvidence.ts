import { createHash } from 'node:crypto';
import type { QuizQuestion, QuizSession } from '../shared/quizProtocol';
import type { LearnerAttempt } from '../shared/learnerModel';
import {
  questionFingerprintSource,
  type MasteryExposure,
} from '../shared/mastery';
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
    unmodelled: gradedQuestions(session).filter(
      (question) => !question.learning,
    ).length,
  };
}
