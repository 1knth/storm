/**
 * Evidence check behind the lesson map's `mastered` and `retained` statuses.
 * The tutor grades every answer and its reasoning; Storm only confirms that
 * the recorded grades meet the teach skill's mastery criteria before it lets
 * the tutor declare a node mastered (skills/storm/TUTOR.md).
 */
import { CONFIDENT_ERROR_THRESHOLD, type LearnerAttempt } from './learnerModel';
import type { QuizQuestion } from './quizProtocol';

export const MASTERY_CRITERIA = {
  /** Fresh independent correct items, at least one at apply level or higher. */
  freshIndependentCorrect: 2,
} as const;

/**
 * Normalized identity of a posed item. Two items share a fingerprint only when
 * their wording and options match after case and whitespace normalization, so
 * new numbers or a new context make a fresh item.
 */
export function questionFingerprintSource(
  question: Pick<
    QuizQuestion,
    'kind' | 'prompt' | 'choices' | 'leftItems' | 'rightItems'
  >,
): string {
  const norm = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();
  const texts = (items: Array<{ text: string }> | undefined) =>
    (items ?? []).map((item) => norm(item.text)).sort();
  return JSON.stringify([
    question.kind ?? 'multiple-choice',
    norm(question.prompt),
    texts(question.choices),
    texts(question.leftItems),
    texts(question.rightItems),
  ]);
}

export type MasteryEvidence = {
  concept: string;
  mastered: boolean;
  retained: boolean;
  /** Unmet criteria, phrased as what the tutor still needs to record. */
  missing: string[];
  counts: {
    freshIndependentCorrect: number;
    applyOrHigher: number;
    finalTest: number;
    soundReasoning: number;
    uncheckedConfidentErrors: number;
  };
};

const ordered = (attempts: LearnerAttempt[]) =>
  [...attempts].sort(
    (a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id),
  );

/** Mastery criteria over one concept's attempts, already in time order. */
function evaluate(
  concept: string,
  attempts: LearnerAttempt[],
  firstSeen: Map<string, string>,
): Omit<MasteryEvidence, 'retained'> {
  // An item is fresh when the learner had not seen the same wording before,
  // graded or not. Attempts recorded before fingerprints existed do not count.
  const fresh = (attempt: LearnerAttempt) =>
    !!attempt.fingerprint && firstSeen.get(attempt.fingerprint) === attempt.id;
  const qualifying = attempts.filter(
    (a) => a.support === 'independent' && a.verdict === 'correct' && fresh(a),
  );
  const applyOrHigher = qualifying.filter(
    (a) => a.level === 'apply' || a.level === 'transfer',
  ).length;
  const finalTest = qualifying.filter((a) => a.testId).length;
  const soundReasoning = qualifying.filter(
    (a) => a.reasoning === 'sound',
  ).length;
  const correctAfter = (index: number, mustBeFresh: boolean) =>
    attempts
      .slice(index + 1)
      .some(
        (later) =>
          later.support === 'independent' &&
          later.verdict === 'correct' &&
          (!mustBeFresh || fresh(later)),
      );
  // A confident error needs a later correct independent answer on a new item.
  const uncheckedConfidentErrors = attempts.filter(
    (error, index) =>
      error.verdict === 'incorrect' &&
      (error.confidence ?? 0) >= CONFIDENT_ERROR_THRESHOLD &&
      !correctAfter(index, true),
  ).length;
  const lastMiss = attempts.findLastIndex(
    (a) => a.support === 'independent' && a.verdict === 'incorrect',
  );
  const missing: string[] = [];
  const need = MASTERY_CRITERIA.freshIndependentCorrect - qualifying.length;
  if (need > 0)
    missing.push(
      `${need} more fresh independent correct item${need === 1 ? '' : 's'}`,
    );
  if (!applyOrHigher)
    missing.push('a fresh independent correct item at apply level or higher');
  if (!finalTest)
    missing.push('a fresh independent correct item in a practice test');
  if (!soundReasoning)
    missing.push(
      'feedback with reasoning "sound" on one of those correct items',
    );
  if (uncheckedConfidentErrors)
    missing.push(
      `a correct independent recheck on a new item for ${uncheckedConfidentErrors} confident error${uncheckedConfidentErrors === 1 ? '' : 's'}`,
    );
  if (lastMiss >= 0 && !correctAfter(lastMiss, false))
    missing.push(
      'a correct independent answer since the latest independent miss',
    );
  return {
    concept,
    mastered: missing.length === 0,
    missing,
    counts: {
      freshIndependentCorrect: qualifying.length,
      applyOrHigher,
      finalTest,
      soundReasoning,
      uncheckedConfidentErrors,
    },
  };
}

/** An item shown to the learner, graded or not (skipped, untagged, unrated). */
export type MasteryExposure = { id: string; at: string; fingerprint: string };

/**
 * Whether the recorded evidence supports `mastered` for a concept, and whether
 * it has since been retained: a correct independent answer in a later session
 * than the one where mastery was first demonstrated, with mastery still holding.
 */
export function masteryEvidence(
  concept: string,
  allAttempts: LearnerAttempt[],
  exposures: MasteryExposure[] = [],
): MasteryEvidence {
  const all = ordered(allAttempts);
  const firstSeen = new Map<string, string>();
  const shown = [
    ...exposures,
    ...all.flatMap((a) =>
      a.fingerprint ? [{ id: a.id, at: a.at, fingerprint: a.fingerprint }] : [],
    ),
  ].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  for (const item of shown)
    if (!firstSeen.has(item.fingerprint))
      firstSeen.set(item.fingerprint, item.id);
  const attempts = all.filter((a) => a.concepts.includes(concept));
  const current = evaluate(concept, attempts, firstSeen);
  let retained = false;
  if (current.mastered) {
    const firstMastered = attempts.findIndex(
      (_, index) =>
        evaluate(concept, attempts.slice(0, index + 1), firstSeen).mastered,
    );
    const masteredIn = attempts[firstMastered]!.sessionId;
    retained = attempts
      .slice(firstMastered + 1)
      .some(
        (a) =>
          a.sessionId !== masteredIn &&
          a.support === 'independent' &&
          a.verdict === 'correct',
      );
  }
  return { ...current, retained };
}

/** One line per concept that the tutor can act on. */
export function masteryShortfall(evidence: MasteryEvidence[]): string {
  return evidence
    .map((e) => `${e.concept}: needs ${e.missing.join('; ')}.`)
    .join(' ');
}
