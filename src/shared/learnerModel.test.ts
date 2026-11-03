import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeLearnerState,
  nextStability,
  retrievability,
  type LearnerAttempt,
} from './learnerModel';

const DAY = 86_400_000;
const start = Date.parse('2026-11-01T09:00:00.000Z');
let sequence = 0;
function attempt(
  overrides: Partial<LearnerAttempt> & { dayOffset?: number } = {},
): LearnerAttempt {
  const { dayOffset = 0, ...rest } = overrides;
  sequence++;
  return {
    id: `q${sequence}`,
    sessionId: 's1',
    scopeSignature: 'scope-a',
    at: new Date(start + dayOffset * DAY + sequence * 1000).toISOString(),
    concepts: ['loops'],
    level: 'recall',
    support: 'independent',
    verdict: 'correct',
    ...rest,
  };
}
const state = (attempts: LearnerAttempt[], dayOffset = 0) =>
  computeLearnerState(attempts, {
    scopeKey: 'vault:v',
    scopeSignature: 'scope-a',
    now: new Date(start + dayOffset * DAY + 3_600_000),
  });

test('an empty history has no concepts, recommendations, or calibration', () => {
  const value = state([]);
  assert.deepEqual(value.concepts, []);
  assert.deepEqual(value.next, []);
  assert.deepEqual(value.calibration, {
    rated: 0,
    meanConfidence: null,
    accuracy: null,
    bias: null,
  });
});

test('independent success moves the frontier up through the levels', () => {
  const attempts = [
    attempt({ level: 'recall' }),
    attempt({ level: 'recall' }),
    attempt({ level: 'explain' }),
    attempt({ level: 'apply' }),
  ];
  const concept = state(attempts).concepts[0]!;
  assert.ok(concept.predicted.recall > concept.predicted.explain);
  assert.ok(concept.predicted.explain > concept.predicted.apply);
  assert.ok(concept.predicted.recall >= 0.85);
  assert.notEqual(concept.recommended.level, 'recall');
  assert.equal(concept.zone, 'zpd');
});

test('an independent success never lowers the recommended level', () => {
  const value = state([attempt({ level: 'apply' })]);
  const concept = value.concepts[0]!;
  assert.ok(concept.predicted.explain < 0.85);
  assert.deepEqual(concept.recommended, {
    level: 'apply',
    support: 'independent',
  });
  const missed = state([
    attempt({ level: 'apply' }),
    attempt({ level: 'apply', verdict: 'incorrect' }),
  ]).concepts[0]!;
  assert.notEqual(missed.recommended.level, 'transfer');
  assert.notEqual(missed.recommended.level, 'apply');
});

test('success only with hints places the concept in the ZPD with hinted support', () => {
  const attempts = [
    attempt({ level: 'apply', verdict: 'incorrect' }),
    attempt({ level: 'apply', verdict: 'incorrect' }),
    attempt({ level: 'apply', support: 'hinted' }),
    attempt({ level: 'apply', support: 'hinted' }),
    attempt({ level: 'apply', support: 'hinted' }),
  ];
  const concept = state(attempts).concepts[0]!;
  assert.equal(concept.zone, 'zpd');
  assert.equal(concept.recommended.support, 'hinted');
  assert.equal(concept.evidence.assisted, 3);
  assert.equal(concept.evidence.independent, 2);
});

test('failure even with help is beyond reach and recommends a worked example', () => {
  const attempts = [
    attempt({ verdict: 'incorrect' }),
    attempt({ verdict: 'incorrect', support: 'hinted' }),
    attempt({ verdict: 'incorrect', support: 'worked' }),
    attempt({ verdict: 'incorrect' }),
  ];
  const value = state(attempts);
  assert.equal(value.concepts[0]!.zone, 'beyond');
  assert.deepEqual(value.next[0], {
    conceptId: 'loops',
    reason: 'beyond',
    level: 'recall',
    support: 'worked',
  });
});

test('assisted attempts do not change memory stability', () => {
  const independent = state([attempt()]).concepts[0]!;
  const withHelp = state([
    attempt(),
    attempt({ support: 'worked', verdict: 'incorrect' }),
  ]).concepts[0]!;
  assert.equal(withHelp.stabilityDays, independent.stabilityDays);
});

test('a high-confidence error is flagged, rescheduled soon, and recommended first', () => {
  const attempts = [
    attempt({ concepts: ['loops'] }),
    attempt({ concepts: ['conditions'] }),
    attempt({ concepts: ['conditions'], verdict: 'incorrect', confidence: 90 }),
  ];
  const value = state(attempts);
  const conditions = value.concepts.find((c) => c.id === 'conditions')!;
  assert.equal(conditions.confidentError, true);
  assert.equal(conditions.stabilityDays, 0.2);
  assert.equal(value.next[0]!.conceptId, 'conditions');
  assert.equal(value.next[0]!.reason, 'confident-error');
  const lowConfidence = state([
    attempt({ concepts: ['conditions'], verdict: 'incorrect', confidence: 30 }),
  ]).concepts[0]!;
  assert.equal(lowConfidence.confidentError, false);
});

test('recall decays over time and makes a concept due for review', () => {
  const attempts = [attempt()];
  const fresh = state(attempts).concepts[0]!;
  assert.equal(fresh.dueForReview, false);
  const later = state(attempts, 10);
  const concept = later.concepts[0]!;
  assert.ok(concept.retrievability! < 0.9);
  assert.equal(concept.dueForReview, true);
  assert.equal(later.next[0]!.reason, 'review-due');
});

test('spaced retrieval grows stability more than same-day cramming', () => {
  const crammed = state([attempt(), attempt(), attempt()]).concepts[0]!;
  const spaced = state(
    [attempt(), attempt({ dayOffset: 2 }), attempt({ dayOffset: 7 })],
    7,
  ).concepts[0]!;
  assert.ok(spaced.stabilityDays! > crammed.stabilityDays! * 2);
});

test('forgetting curve and stability update follow their stated properties', () => {
  assert.ok(Math.abs(retrievability(5, 5) - 0.9) < 1e-9);
  assert.equal(retrievability(0, 5), 1);
  assert.equal(nextStability(null, 1, 0, false), 2);
  assert.equal(nextStability(null, 0, 0, true), 0.2);
  assert.ok(nextStability(4, 1, 0.99, false) < nextStability(4, 1, 0.8, false));
  assert.ok(
    nextStability(4, 0.5, 0.8, false) < nextStability(4, 1, 0.8, false),
  );
  assert.ok(nextStability(4, 0, 0.8, false) < 4);
});

test('calibration compares mean confidence with verdict accuracy', () => {
  const value = state([
    attempt({ confidence: 90, verdict: 'incorrect' }),
    attempt({ confidence: 80, verdict: 'partial' }),
    attempt({ confidence: 70, verdict: 'correct' }),
    attempt(),
  ]);
  assert.deepEqual(value.calibration, {
    rated: 3,
    meanConfidence: 80,
    accuracy: 50,
    bias: 30,
  });
});

test('concepts from the current scope are prioritized over other material', () => {
  const value = state([
    attempt({ concepts: ['other'], scopeSignature: 'scope-b', level: 'apply' }),
    attempt({ concepts: ['current'], level: 'apply' }),
  ]);
  assert.equal(value.attempts.inScope, 1);
  assert.equal(value.concepts[0]!.id, 'current');
  assert.equal(value.concepts[0]!.inScope, true);
  assert.equal(value.next[0]!.conceptId, 'current');
  assert.equal(value.concepts.find((c) => c.id === 'other')!.inScope, false);
});

test('recommendations are unique and limited', () => {
  const attempts = ['a', 'b', 'c', 'd', 'e'].map((id) =>
    attempt({ concepts: [id], level: 'apply' }),
  );
  const value = state(attempts);
  assert.equal(value.next.length, 3);
  assert.equal(new Set(value.next.map((n) => n.conceptId)).size, 3);
});

test('a multi-concept attempt updates every tagged concept', () => {
  const value = state([attempt({ concepts: ['loops', 'conditions'] })]);
  assert.deepEqual(value.concepts.map((c) => c.id).sort(), [
    'conditions',
    'loops',
  ]);
});
