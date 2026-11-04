/**
 * Deterministic learner model shared by the main process and tests.
 *
 * Attempts are the only persisted facts; state is recomputed by replay so the
 * model can change without migrating stored learner records. The design and its
 * evidence are described in docs/ADAPTIVE-LEARNING-RESEARCH.md.
 */
import {
  QUIZ_COGNITIVE_LEVELS,
  type QuizCognitiveLevel,
  type QuizSupport,
} from './quizProtocol';

export type LearnerVerdict = 'correct' | 'partial' | 'incorrect';
export type LearnerSupport = QuizSupport | 'unknown';

/** One graded answer; untagged rated answers contribute only to calibration. */
export type LearnerAttempt = {
  /** Question ID; one attempt per question. */
  id: string;
  sessionId: string;
  /** Normalized session scope, used to prioritize concepts from the current material. */
  scopeSignature: string;
  at: string;
  concepts: string[];
  level: QuizCognitiveLevel;
  support: LearnerSupport;
  verdict: LearnerVerdict;
  confidence?: number;
};

export type LearnerZone = 'new' | 'beyond' | 'zpd' | 'independent';
export type LearnerRecommendationReason =
  | 'confident-error'
  | 'review-due'
  | 'zpd'
  | 'beyond'
  | 'stretch';

export type LearnerConceptState = {
  id: string;
  zone: LearnerZone;
  recommended: { level: QuizCognitiveLevel; support: QuizSupport };
  /** Predicted independent success per level, rounded to two decimals. */
  predicted: Record<QuizCognitiveLevel, number>;
  evidence: {
    independent: number;
    assisted: number;
    /** Sum of verdict scores (correct = 1, partial = 0.5). */
    score: number;
    lastAt: string | null;
  };
  /** Estimated recall probability now; null before any independent attempt. */
  retrievability: number | null;
  /** Memory stability in days; null before any independent attempt. */
  stabilityDays: number | null;
  dueForReview: boolean;
  /** The latest independent attempt was an error made with confidence >= 70. */
  confidentError: boolean;
  /** A partial answer is a candidate for diagnosis, not an assumed misconception. */
  confidentPartial: boolean;
  /** Assisted candidates persist until independent success at that level or higher. */
  assistedConfidentError: boolean;
  assistedConfidentPartial: boolean;
  /**
   * Explain an incorrect answer now; assisted remediation can precede the recheck.
   * This is advice, not a record that a correction was actually delivered.
   */
  confidentReview: {
    sourceSupport: QuizSupport;
    level: QuizCognitiveLevel;
    recheckEligible: boolean;
    recheckAt: string;
    interveningAttempts: number;
    remediationAvailable: boolean;
  } | null;
  /** Attempted in a session with the same scope as the requesting session. */
  inScope: boolean;
};

export type LearnerRecommendation = {
  conceptId: string;
  reason: LearnerRecommendationReason;
  level: QuizCognitiveLevel;
  support: QuizSupport;
};

export type LearnerCalibration = {
  /** Graded attempts with a learner confidence rating (most recent 50). */
  rated: number;
  meanConfidence: number | null;
  /** Mean verdict score as a percentage. */
  accuracy: number | null;
  /** meanConfidence - accuracy; positive means overconfident. */
  bias: number | null;
  /** Mean absolute confidence/verdict difference in percentage points; cannot cancel. */
  meanAbsoluteError: number | null;
  /** Counts within the same rated window, not independent mastery evidence. */
  supportCounts: { independent: number; assisted: number; unknown: number };
  /** Advisory bias guidance requires enough ratings and a meaningful signed bias. */
  guidanceEligible: boolean;
};

export type LearnerState = {
  scopeKey: string;
  generatedAt: string;
  band: { low: number; high: number };
  attempts: { total: number; inScope: number };
  concepts: LearnerConceptState[];
  next: LearnerRecommendation[];
  calibration: LearnerCalibration;
  /** Added by the app after retrying durable grade recording; absent in pure replay. */
  recording?: {
    pending: number;
    failures: number;
    unmodelled: number;
    lastError?: string;
  };
  /** Concepts omitted after the response limit. */
  omittedConcepts: number;
};

export const LEARNER_LIMITS = {
  attemptsPerScope: 5000,
  conceptsInState: 40,
  recommendations: 3,
  calibrationWindow: 50,
} as const;

/** Target band for predicted independent success during practice (tunable starting values). */
export const LEARNER_BAND = { low: 0.7, high: 0.85 } as const;
/** Confidence at or above this value turns an error into a hypercorrection candidate. */
export const CONFIDENT_ERROR_THRESHOLD = 70;
/** Starting heuristics for guidance and support fading, not validated learner diagnoses. */
export const CALIBRATION_GUIDANCE = {
  minimumRated: 20,
  biasThreshold: 15,
} as const;
export const SUPPORT_FADE = { consecutiveCorrect: 2 } as const;
/** Either a delay or intervening questions separates correction from a recheck. */
export const CONFIDENT_RECHECK = {
  delayDays: 1,
  interveningAttempts: 2,
} as const;
/** Logistic-scale difficulty per level; difficulty attaches to recurring levels, not generated items. */
export const LEVEL_DIFFICULTY: Record<QuizCognitiveLevel, number> = {
  recall: -1.2,
  explain: -0.4,
  apply: 0.4,
  transfer: 1.2,
};
/** Retention target: a concept is due when estimated recall falls below this. */
export const TARGET_RETENTION = 0.9;

const DAY_MS = 86_400_000;
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const round2 = (x: number) => Math.round(x * 100) / 100;
const score = (verdict: LearnerVerdict) =>
  verdict === 'correct' ? 1 : verdict === 'partial' ? 0.5 : 0;
/** Elo K-factor that shrinks with evidence (Pelánek 2016, uncertainty function). */
const kFactor = (n: number) => 1.2 / (1 + 0.1 * n);

/** FSRS-style power forgetting curve: R = 0.9 when elapsed time equals stability. */
export function retrievability(elapsedDays: number, stabilityDays: number) {
  return Math.pow(
    1 + ((19 / 81) * Math.max(0, elapsedDays)) / stabilityDays,
    -0.5,
  );
}

/**
 * Stability update with fixed FSRS-like default weights (not fitted per learner).
 * Successful retrieval at lower retrievability grows stability more, so cramming
 * within a day adds little; failure resets toward a short interval.
 */
export function nextStability(
  stabilityDays: number | null,
  value: number,
  recall: number,
  confidentError: boolean,
) {
  if (stabilityDays === null)
    return value >= 1 ? 2 : value >= 0.5 ? 1 : confidentError ? 0.2 : 0.4;
  if (value < 0.5)
    return confidentError
      ? 0.2
      : Math.max(0.2, Math.min(stabilityDays, stabilityDays * 0.25 + 0.2));
  const growth =
    Math.exp(1.4) *
    6 *
    Math.pow(stabilityDays, -0.11) *
    (Math.exp(1 - recall) - 1);
  return stabilityDays * (1 + growth * (value >= 1 ? 1 : 0.5));
}

type ConfidenceDiagnosis = {
  at: string;
  kind: 'error' | 'partial';
  support: QuizSupport;
  level: QuizCognitiveLevel;
  index: number;
};

type AssistedEvidence = {
  ability: number;
  attempts: number;
  correctStreak: number;
};

type ConceptAccumulator = {
  id: string;
  independentAbility: number;
  helped: Record<'hinted' | 'worked', AssistedEvidence>;
  independent: number;
  assisted: number;
  score: number;
  lastAt: string | null;
  stability: number | null;
  lastReviewAt: number | null;
  independentDiagnosis: ConfidenceDiagnosis | null;
  assistedDiagnosis: ConfidenceDiagnosis | null;
  lastPractice: {
    support: QuizSupport;
    level: QuizCognitiveLevel;
    verdict: LearnerVerdict;
    index: number;
  };
  /** Level of the latest independent attempt if it was fully correct. */
  lastIndependentSuccess: QuizCognitiveLevel | null;
  inScope: boolean;
};

function accumulate(
  attempts: LearnerAttempt[],
  scopeSignature: string | null,
): Map<string, ConceptAccumulator> {
  const concepts = new Map<string, ConceptAccumulator>();
  const ordered = [...attempts].sort((a, b) => a.at.localeCompare(b.at));
  for (const [index, attempt] of ordered.entries()) {
    // Unknown support cannot establish independent retrieval or helped reach.
    // Untagged rated answers are retained for calibration below.
    if (attempt.support === 'unknown') continue;
    const value = score(attempt.verdict);
    const at = Date.parse(attempt.at);
    const confidentError =
      value < 0.5 &&
      attempt.confidence !== undefined &&
      attempt.confidence >= CONFIDENT_ERROR_THRESHOLD;
    const diagnosis: ConfidenceDiagnosis | null =
      attempt.verdict !== 'correct' &&
      attempt.confidence !== undefined &&
      attempt.confidence >= CONFIDENT_ERROR_THRESHOLD
        ? {
            at: attempt.at,
            kind: attempt.verdict === 'incorrect' ? 'error' : 'partial',
            support: attempt.support,
            level: attempt.level,
            index,
          }
        : null;
    for (const id of attempt.concepts) {
      let concept = concepts.get(id);
      if (!concept) {
        concept = {
          id,
          independentAbility: 0,
          helped: {
            hinted: { ability: 0, attempts: 0, correctStreak: 0 },
            worked: { ability: 0, attempts: 0, correctStreak: 0 },
          },
          independent: 0,
          assisted: 0,
          score: 0,
          lastAt: null,
          stability: null,
          lastReviewAt: null,
          independentDiagnosis: null,
          assistedDiagnosis: null,
          lastPractice: {
            support: attempt.support,
            level: attempt.level,
            verdict: attempt.verdict,
            index,
          },
          lastIndependentSuccess: null,
          inScope: false,
        };
        concepts.set(id, concept);
      }
      concept.score += value;
      concept.lastAt = attempt.at;
      if (scopeSignature !== null && attempt.scopeSignature === scopeSignature)
        concept.inScope = true;
      const difficulty = LEVEL_DIFFICULTY[attempt.level];
      if (attempt.support === 'independent') {
        const expected = sigmoid(concept.independentAbility - difficulty);
        concept.independentAbility +=
          kFactor(concept.independent) * (value - expected);
        concept.independent++;
        const elapsed =
          concept.lastReviewAt === null || !Number.isFinite(at)
            ? 0
            : (at - concept.lastReviewAt) / DAY_MS;
        const recall =
          concept.stability === null
            ? 0
            : retrievability(elapsed, concept.stability);
        concept.stability = nextStability(
          concept.stability,
          value,
          recall,
          confidentError,
        );
        if (Number.isFinite(at)) concept.lastReviewAt = at;
        concept.independentDiagnosis = diagnosis;
        if (
          attempt.verdict === 'correct' &&
          concept.assistedDiagnosis &&
          QUIZ_COGNITIVE_LEVELS.indexOf(attempt.level) >=
            QUIZ_COGNITIVE_LEVELS.indexOf(concept.assistedDiagnosis.level)
        )
          concept.assistedDiagnosis = null;
        concept.lastIndependentSuccess = value >= 1 ? attempt.level : null;
      } else {
        // Assisted success is evidence about the zone of proximal development,
        // not retrieval; it does not change memory stability.
        const helped = concept.helped[attempt.support];
        const expected = sigmoid(helped.ability - difficulty);
        helped.ability += kFactor(helped.attempts) * (value - expected);
        helped.attempts++;
        helped.correctStreak =
          attempt.verdict === 'correct'
            ? concept.lastPractice.support === attempt.support &&
              concept.lastPractice.level === attempt.level
              ? helped.correctStreak + 1
              : 1
            : 0;
        concept.assisted++;
        if (diagnosis) concept.assistedDiagnosis = diagnosis;
      }
      concept.lastPractice = {
        support: attempt.support,
        level: attempt.level,
        verdict: attempt.verdict,
        index,
      };
    }
  }
  return concepts;
}

function conceptState(
  concept: ConceptAccumulator,
  now: number,
  totalAttempts: number,
): LearnerConceptState {
  const predicted = Object.fromEntries(
    QUIZ_COGNITIVE_LEVELS.map((level) => [
      level,
      round2(sigmoid(concept.independentAbility - LEVEL_DIFFICULTY[level])),
    ]),
  ) as Record<QuizCognitiveLevel, number>;
  const assisted = (support: 'hinted' | 'worked', level: QuizCognitiveLevel) =>
    sigmoid(concept.helped[support].ability - LEVEL_DIFFICULTY[level]);
  const recall =
    concept.stability === null || concept.lastReviewAt === null
      ? null
      : retrievability(
          (now - concept.lastReviewAt) / DAY_MS,
          concept.stability,
        );
  let zone: LearnerZone;
  let recommended: LearnerConceptState['recommended'];
  const frontier = QUIZ_COGNITIVE_LEVELS.find(
    (level) => predicted[level] < LEARNER_BAND.high,
  );
  if (concept.independent + concept.assisted === 0) {
    zone = 'new';
    recommended = { level: 'recall', support: 'worked' };
  } else if (!frontier) {
    zone = concept.independent >= 3 ? 'independent' : 'zpd';
    recommended = { level: 'transfer', support: 'independent' };
  } else if (
    concept.independent > 0 &&
    predicted[frontier] >= LEARNER_BAND.low
  ) {
    zone = 'zpd';
    recommended = { level: frontier, support: 'independent' };
  } else if (
    concept.helped.hinted.attempts > 0 &&
    assisted('hinted', frontier) >= LEARNER_BAND.low
  ) {
    zone = 'zpd';
    recommended = { level: frontier, support: 'hinted' };
  } else {
    zone = 'beyond';
    recommended = { level: frontier, support: 'worked' };
  }
  // With sparse evidence the frontier can sit below a level just answered
  // correctly; never step down right after an independent success.
  const last = concept.lastIndependentSuccess;
  if (
    concept.lastPractice.support === 'independent' &&
    last &&
    zone !== 'independent' &&
    QUIZ_COGNITIVE_LEVELS.indexOf(recommended.level) <
      QUIZ_COGNITIVE_LEVELS.indexOf(last)
  ) {
    zone = 'zpd';
    recommended = { level: last, support: 'independent' };
  }
  // Observed help overrides an optimistic independent prior. Fade only after
  // repeated full successes at the same level and support; the next less
  // supported attempt is a probe, not proof of independent mastery.
  const practice = concept.lastPractice;
  if (practice.support !== 'independent') {
    const helped = concept.helped[practice.support];
    if (practice.verdict !== 'correct') {
      zone = practice.verdict === 'incorrect' ? 'beyond' : 'zpd';
      recommended = {
        level:
          QUIZ_COGNITIVE_LEVELS.indexOf(practice.level) <
          QUIZ_COGNITIVE_LEVELS.indexOf(recommended.level)
            ? practice.level
            : recommended.level,
        support: practice.verdict === 'incorrect' ? 'worked' : practice.support,
      };
    } else {
      const fade =
        helped.correctStreak >= SUPPORT_FADE.consecutiveCorrect &&
        assisted(practice.support, practice.level) >= LEARNER_BAND.low;
      zone = 'zpd';
      recommended = {
        level: practice.level,
        support: fade
          ? practice.support === 'worked'
            ? 'hinted'
            : 'independent'
          : practice.support,
      };
    }
  }
  const error = [concept.independentDiagnosis, concept.assistedDiagnosis]
    .filter((item): item is ConfidenceDiagnosis => item?.kind === 'error')
    .sort((a, b) => b.index - a.index)[0];
  if (
    error &&
    error.support !== 'independent' &&
    QUIZ_COGNITIVE_LEVELS.indexOf(practice.level) <
      QUIZ_COGNITIVE_LEVELS.indexOf(error.level)
  ) {
    // Easier practice does not establish readiness to retry a harder helped
    // misconception independently, even when the easier answer was correct.
    zone = 'beyond';
    recommended = { level: error.level, support: 'worked' };
  }
  const recheckAt =
    Date.parse(error?.at ?? concept.lastAt!) +
    CONFIDENT_RECHECK.delayDays * DAY_MS;
  const interveningAttempts = Math.max(
    0,
    totalAttempts - (error?.index ?? practice.index) - 1,
  );
  const confidentReview: LearnerConceptState['confidentReview'] = error
    ? {
        sourceSupport: error.support,
        level: error.level,
        recheckEligible:
          now >= recheckAt ||
          interveningAttempts >= CONFIDENT_RECHECK.interveningAttempts,
        recheckAt: new Date(recheckAt).toISOString(),
        interveningAttempts,
        remediationAvailable:
          practice.index > error.index && recommended.support !== 'independent',
      }
    : null;
  return {
    id: concept.id,
    zone,
    recommended,
    predicted,
    evidence: {
      independent: concept.independent,
      assisted: concept.assisted,
      score: concept.score,
      lastAt: concept.lastAt,
    },
    retrievability: recall === null ? null : round2(recall),
    stabilityDays:
      concept.stability === null ? null : round2(concept.stability),
    dueForReview: recall !== null && recall < TARGET_RETENTION,
    confidentError: concept.independentDiagnosis?.kind === 'error',
    confidentPartial: concept.independentDiagnosis?.kind === 'partial',
    assistedConfidentError: concept.assistedDiagnosis?.kind === 'error',
    assistedConfidentPartial: concept.assistedDiagnosis?.kind === 'partial',
    confidentReview,
    inScope: concept.inScope,
  };
}

/** Highest level the learner already handles independently, for consolidating reviews. */
function reviewLevel(concept: LearnerConceptState): QuizCognitiveLevel {
  const levels = QUIZ_COGNITIVE_LEVELS.filter(
    (level) => concept.predicted[level] >= LEARNER_BAND.low,
  );
  return levels[levels.length - 1] ?? 'recall';
}

export function recommend(
  concepts: LearnerConceptState[],
  limit: number = LEARNER_LIMITS.recommendations,
): LearnerRecommendation[] {
  const result: LearnerRecommendation[] = [];
  const used = new Set<string>();
  const push = (
    concept: LearnerConceptState,
    reason: LearnerRecommendationReason,
    level: QuizCognitiveLevel,
    support: QuizSupport,
  ) => {
    if (used.has(concept.id) || result.length >= limit) return;
    used.add(concept.id);
    result.push({ conceptId: concept.id, reason, level, support });
  };
  // Current material first, then other concepts in the same vault.
  const byScope = (a: LearnerConceptState, b: LearnerConceptState) =>
    Number(b.inScope) - Number(a.inScope);
  // Pending correction is surfaced in concept state immediately. Do not turn
  // it into an immediate independent retest. Assisted remediation remains available.
  const practice = concepts.filter(
    (c) =>
      !c.confidentReview ||
      c.confidentReview.recheckEligible ||
      c.confidentReview.remediationAvailable,
  );
  for (const concept of practice
    .filter((c) => c.confidentReview?.recheckEligible)
    .sort(byScope))
    push(
      concept,
      'confident-error',
      concept.recommended.level,
      concept.recommended.support,
    );
  for (const concept of concepts
    .filter(
      (c) =>
        c.dueForReview &&
        !c.confidentReview &&
        c.recommended.support === 'independent',
    )
    .sort(
      (a, b) =>
        byScope(a, b) || (a.retrievability ?? 1) - (b.retrievability ?? 1),
    ))
    push(concept, 'review-due', reviewLevel(concept), 'independent');
  // Region of proximal learning: easiest not-yet-mastered concept first.
  const frontierP = (c: LearnerConceptState) =>
    c.predicted[c.recommended.level];
  for (const concept of practice
    .filter((c) => c.zone === 'zpd')
    .sort((a, b) => byScope(a, b) || frontierP(b) - frontierP(a)))
    push(
      concept,
      'zpd',
      concept.recommended.level,
      concept.recommended.support,
    );
  for (const concept of practice
    .filter((c) => c.zone === 'beyond')
    .sort(byScope))
    push(concept, 'beyond', concept.recommended.level, 'worked');
  for (const concept of practice
    .filter((c) => c.zone === 'independent' && c.inScope)
    .sort((a, b) => (a.retrievability ?? 1) - (b.retrievability ?? 1)))
    push(concept, 'stretch', 'transfer', 'independent');
  return result;
}

export function calibration(attempts: LearnerAttempt[]): LearnerCalibration {
  const rated = [...attempts]
    .filter(
      (attempt) =>
        attempt.confidence !== undefined &&
        Number.isFinite(attempt.confidence) &&
        attempt.confidence >= 0 &&
        attempt.confidence <= 100,
    )
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-LEARNER_LIMITS.calibrationWindow);
  const supportCounts = { independent: 0, assisted: 0, unknown: 0 };
  for (const attempt of rated) {
    if (attempt.support === 'independent') supportCounts.independent++;
    else if (attempt.support === 'unknown') supportCounts.unknown++;
    else supportCounts.assisted++;
  }
  if (!rated.length)
    return {
      rated: 0,
      meanConfidence: null,
      accuracy: null,
      bias: null,
      meanAbsoluteError: null,
      supportCounts,
      guidanceEligible: false,
    };
  const meanConfidence =
    rated.reduce((sum, attempt) => sum + attempt.confidence!, 0) / rated.length;
  const accuracy =
    (rated.reduce((sum, attempt) => sum + score(attempt.verdict), 0) /
      rated.length) *
    100;
  const meanAbsoluteError =
    rated.reduce(
      (sum, attempt) =>
        sum + Math.abs(attempt.confidence! - score(attempt.verdict) * 100),
      0,
    ) / rated.length;
  return {
    rated: rated.length,
    meanConfidence: Math.round(meanConfidence),
    accuracy: Math.round(accuracy),
    bias: Math.round(meanConfidence - accuracy),
    meanAbsoluteError: Math.round(meanAbsoluteError),
    supportCounts,
    guidanceEligible:
      rated.length >= CALIBRATION_GUIDANCE.minimumRated &&
      Math.abs(meanConfidence - accuracy) >= CALIBRATION_GUIDANCE.biasThreshold,
  };
}

export function computeLearnerState(
  attempts: LearnerAttempt[],
  options: { scopeKey: string; scopeSignature: string | null; now: Date },
): LearnerState {
  const now = options.now.getTime();
  const all = [...accumulate(attempts, options.scopeSignature).values()].map(
    (concept) => conceptState(concept, now, attempts.length),
  );
  const next = recommend(all);
  const recommended = new Set(next.map((item) => item.conceptId));
  // Keep recommended, in-scope, due, then most recent concepts within the limit.
  const priority = (c: LearnerConceptState) =>
    (recommended.has(c.id) ? 8 : 0) +
    (c.inScope ? 4 : 0) +
    (c.dueForReview ||
    c.confidentReview ||
    c.confidentPartial ||
    c.assistedConfidentPartial
      ? 2
      : 0);
  const concepts = [...all]
    .sort(
      (a, b) =>
        priority(b) - priority(a) ||
        (b.evidence.lastAt ?? '').localeCompare(a.evidence.lastAt ?? ''),
    )
    .slice(0, LEARNER_LIMITS.conceptsInState);
  return {
    scopeKey: options.scopeKey,
    generatedAt: options.now.toISOString(),
    band: { ...LEARNER_BAND },
    attempts: {
      total: attempts.length,
      inScope:
        options.scopeSignature === null
          ? 0
          : attempts.filter((a) => a.scopeSignature === options.scopeSignature)
              .length,
    },
    concepts,
    next,
    calibration: calibration(attempts),
    omittedConcepts: all.length - concepts.length,
  };
}
