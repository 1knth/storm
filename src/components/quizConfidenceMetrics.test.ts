import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addConfidenceObservation } from './quizConfidenceMetrics';

test('local observations separate completed rating/submission from leaving unrated', () => {
  let result = addConfidenceObservation(undefined, {
    ratedAfterMs: 1200,
    durationMs: 3000,
    submitted: true,
  });
  result = addConfidenceObservation(result, {
    ratedAfterMs: null,
    durationMs: 900,
    submitted: false,
  });
  result = addConfidenceObservation(result, {
    ratedAfterMs: 500,
    durationMs: 800,
    submitted: false,
  });
  assert.deepEqual(result, {
    observations: 3,
    rated: 2,
    submitted: 1,
    leftUnrated: 1,
    totalRatingMs: 1700,
    totalSubmissionMs: 3000,
  });
});
test('malformed counters and clock anomalies cannot poison local aggregates', () => {
  assert.deepEqual(
    addConfidenceObservation(
      { observations: -3, totalRatingMs: 'bad' },
      { ratedAfterMs: NaN, durationMs: -100, submitted: true },
    ),
    {
      observations: 1,
      rated: 1,
      submitted: 1,
      leftUnrated: 0,
      totalRatingMs: 0,
      totalSubmissionMs: 0,
    },
  );
});
