/** Local aggregate observations only: no answer text, ratings, IDs, or network calls. */
export const QUIZ_CONFIDENCE_METRICS_KEY = 'storm.quizConfidenceMetrics.v1';
export type ConfidenceObservation = {
  ratedAfterMs: number | null;
  durationMs: number;
  submitted: boolean;
};
export type ConfidenceMetrics = {
  observations: number;
  rated: number;
  submitted: number;
  leftUnrated: number;
  totalRatingMs: number;
  totalSubmissionMs: number;
};
const empty = (): ConfidenceMetrics => ({
  observations: 0,
  rated: 0,
  submitted: 0,
  leftUnrated: 0,
  totalRatingMs: 0,
  totalSubmissionMs: 0,
});
const duration = (ms: number) =>
  Number.isFinite(ms) ? Math.max(0, Math.min(ms, 86_400_000)) : 0;
export function addConfidenceObservation(
  previous: unknown,
  observation: ConfidenceObservation,
): ConfidenceMetrics {
  const metrics = empty();
  if (previous && typeof previous === 'object') {
    for (const key of Object.keys(metrics) as (keyof ConfidenceMetrics)[]) {
      const value = (previous as Record<string, unknown>)[key];
      if (
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value >= 0
      )
        metrics[key] = value;
    }
  }
  metrics.observations++;
  if (observation.ratedAfterMs !== null) {
    metrics.rated++;
    metrics.totalRatingMs += Math.round(duration(observation.ratedAfterMs));
  } else if (!observation.submitted) metrics.leftUnrated++;
  if (observation.submitted) {
    metrics.submitted++;
    metrics.totalSubmissionMs += Math.round(duration(observation.durationMs));
  }
  return metrics;
}
export function recordConfidenceObservation(
  observation: ConfidenceObservation,
): void {
  try {
    const saved = localStorage.getItem(QUIZ_CONFIDENCE_METRICS_KEY);
    let previous: unknown;
    try {
      previous = saved ? JSON.parse(saved) : undefined;
    } catch {
      /* Reset malformed counters. */
    }
    localStorage.setItem(
      QUIZ_CONFIDENCE_METRICS_KEY,
      JSON.stringify(addConfidenceObservation(previous, observation)),
    );
  } catch {
    /* Optional diagnostics must never interrupt an answer. */
  }
}
