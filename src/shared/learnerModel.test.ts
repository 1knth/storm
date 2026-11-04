import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeLearnerState,
  calibration,
  CALIBRATION_GUIDANCE,
  CONFIDENT_RECHECK,
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
    meanAbsoluteError: null,
    supportCounts: { independent: 0, assisted: 0, unknown: 0 },
    guidanceEligible: false,
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

test('one hinted success stays in the ZPD with hinted support', () => {
  const attempts = [
    attempt({ level: 'apply', verdict: 'incorrect' }),
    attempt({ level: 'apply', verdict: 'incorrect' }),
    attempt({ level: 'apply', support: 'hinted' }),
  ];
  const concept = state(attempts).concepts[0]!;
  assert.equal(concept.zone, 'zpd');
  assert.equal(concept.recommended.support, 'hinted');
  assert.equal(concept.evidence.assisted, 1);
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

test('a high-confidence error needs correction before a delayed supported recheck', () => {
  const attempts = [
    attempt({ concepts: ['loops'] }),
    attempt({ concepts: ['conditions'] }),
    attempt({ concepts: ['conditions'], verdict: 'incorrect', confidence: 90 }),
  ];
  const value = state(attempts);
  const conditions = value.concepts.find((c) => c.id === 'conditions')!;
  assert.equal(conditions.confidentError, true);
  assert.equal(conditions.stabilityDays, 0.2);
  assert.equal(conditions.confidentReview!.sourceSupport, 'independent');
  assert.equal(conditions.confidentReview!.recheckEligible, false);
  assert.ok(!value.next.some((item) => item.conceptId === 'conditions'));
  const later = state(attempts, 1);
  assert.equal(later.next[0]!.conceptId, 'conditions');
  assert.equal(later.next[0]!.reason, 'confident-error');
  assert.equal(later.next[0]!.support, 'worked');
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
    meanAbsoluteError: 50,
    supportCounts: { independent: 3, assisted: 0, unknown: 0 },
    guidanceEligible: false,
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

test('ten worked misses cannot inherit independent success from the prior', () => {
  const attempts = Array.from({ length: 10 }, () =>
    attempt({ support: 'worked', verdict: 'incorrect' }),
  );
  for (let count = 1; count <= attempts.length; count++) {
    const value = state(attempts.slice(0, count));
    const concept = value.concepts[0]!;
    assert.equal(concept.zone, 'beyond');
    assert.deepEqual(concept.recommended, {
      level: 'recall',
      support: 'worked',
    });
    assert.equal(concept.evidence.independent, 0);
    assert.equal(concept.stabilityDays, null);
    assert.equal(concept.retrievability, null);
    assert.equal(value.next[0]!.support, 'worked');
  }
});

test('helped failure overrides an optimistic prior from earlier independent success', () => {
  const attempts = Array.from({ length: 8 }, () => attempt());
  const independent = state(attempts).concepts[0]!;
  const withFailure = state([
    ...attempts,
    attempt({ support: 'hinted', verdict: 'incorrect' }),
  ]).concepts[0]!;
  assert.deepEqual(withFailure.predicted, independent.predicted);
  assert.equal(withFailure.stabilityDays, independent.stabilityDays);
  assert.equal(withFailure.zone, 'beyond');
  assert.equal(withFailure.recommended.support, 'worked');
});

test('support fades one step after repeated full success at the same level', () => {
  const worked = [attempt({ support: 'worked' })];
  assert.equal(state(worked).concepts[0]!.recommended.support, 'worked');
  worked.push(attempt({ support: 'worked' }));
  assert.equal(state(worked).concepts[0]!.recommended.support, 'hinted');
  worked.push(attempt({ support: 'hinted' }));
  assert.equal(state(worked).concepts[0]!.recommended.support, 'hinted');
  worked.push(attempt({ support: 'hinted' }));
  const concept = state(worked).concepts[0]!;
  assert.equal(concept.recommended.support, 'independent');
  assert.equal(concept.zone, 'zpd');
  assert.equal(concept.evidence.independent, 0);
  assert.equal(concept.stabilityDays, null);
});

test('partial answers and changed levels cannot count as repeated full successes for fading', () => {
  const partial = state([
    attempt({ support: 'worked' }),
    attempt({ support: 'worked', verdict: 'partial' }),
    attempt({ support: 'worked' }),
  ]).concepts[0]!;
  assert.equal(partial.recommended.support, 'worked');
  const changedLevel = state([
    attempt({ support: 'worked', level: 'recall' }),
    attempt({ support: 'worked', level: 'apply' }),
  ]).concepts[0]!;
  assert.deepEqual(changedLevel.recommended, {
    level: 'apply',
    support: 'worked',
  });
});

test('opposing confidence errors cannot disappear in a zero signed bias', () => {
  const value = state(
    Array.from({ length: 20 }, (_, index) =>
      attempt(
        index % 2 === 0
          ? { confidence: 100, verdict: 'incorrect' }
          : { confidence: 0, verdict: 'correct' },
      ),
    ),
  ).calibration;
  assert.equal(value.bias, 0);
  assert.equal(value.meanAbsoluteError, 100);
  assert.equal(value.guidanceEligible, false);
});

test('calibration guidance requires at least twenty ratings and fifteen points of bias', () => {
  const ratings = (length: number, confidence: number) =>
    Array.from({ length }, () => attempt({ confidence, verdict: 'incorrect' }));
  assert.equal(CALIBRATION_GUIDANCE.minimumRated, 20);
  assert.equal(CALIBRATION_GUIDANCE.biasThreshold, 15);
  assert.equal(calibration(ratings(19, 100)).guidanceEligible, false);
  assert.equal(calibration(ratings(20, 14.99)).bias, 15);
  assert.equal(calibration(ratings(20, 14.99)).guidanceEligible, false);
  assert.equal(calibration(ratings(20, 15)).guidanceEligible, true);
  const underconfident = ratings(20, 85).map((item) => ({
    ...item,
    verdict: 'correct' as const,
  }));
  assert.equal(calibration(underconfident).guidanceEligible, true);
});

test('untagged unknown-support ratings affect calibration but never concept or memory state', () => {
  const known = attempt({ confidence: 70 });
  const untagged = attempt({
    concepts: [],
    support: 'unknown',
    confidence: 90,
    verdict: 'incorrect',
  });
  const value = state([known, untagged]);
  assert.deepEqual(value.concepts, state([known]).concepts);
  assert.deepEqual(value.calibration.supportCounts, {
    independent: 1,
    assisted: 0,
    unknown: 1,
  });
  assert.equal(value.calibration.rated, 2);
  assert.equal(value.attempts.total, 2);
  const calibrationOnly = state([untagged]);
  assert.deepEqual(calibrationOnly.concepts, []);
  assert.deepEqual(calibrationOnly.next, []);
});

test('calibration support counts and error metric use only the latest fifty valid ratings', () => {
  const attempts = [
    ...Array.from({ length: 10 }, () =>
      attempt({ support: 'worked', confidence: 100 }),
    ),
    ...Array.from({ length: 20 }, () => attempt({ confidence: 100 })),
    ...Array.from({ length: 20 }, () =>
      attempt({ support: 'hinted', confidence: 100 }),
    ),
    ...Array.from({ length: 10 }, () =>
      attempt({ support: 'unknown', concepts: [], confidence: 100 }),
    ),
    attempt(),
    attempt({ confidence: Number.NaN }),
    attempt({ confidence: 101 }),
  ];
  const value = calibration(attempts.reverse());
  assert.equal(value.rated, 50);
  assert.equal(value.meanAbsoluteError, 0);
  assert.deepEqual(value.supportCounts, {
    independent: 20,
    assisted: 20,
    unknown: 10,
  });
});

test('confident partial answers invite diagnosis without a full misconception or short reset', () => {
  const partial = state([attempt({ verdict: 'partial', confidence: 95 })])
    .concepts[0]!;
  const incorrect = state([attempt({ verdict: 'incorrect', confidence: 95 })])
    .concepts[0]!;
  assert.equal(partial.confidentPartial, true);
  assert.equal(partial.confidentError, false);
  assert.equal(partial.confidentReview, null);
  assert.equal(partial.stabilityDays, 1);
  assert.equal(incorrect.confidentPartial, false);
  assert.equal(incorrect.confidentError, true);
  assert.equal(incorrect.stabilityDays, 0.2);
  const assistedPartial = state([
    attempt({ verdict: 'partial', confidence: 95, support: 'hinted' }),
  ]).concepts[0]!;
  assert.equal(assistedPartial.assistedConfidentPartial, true);
  assert.equal(assistedPartial.assistedConfidentError, false);
  assert.equal(assistedPartial.confidentReview, null);
  assert.equal(assistedPartial.stabilityDays, null);
  assert.equal(assistedPartial.recommended.support, 'hinted');
});

test('recent successes do not fade support while repeated helped failures still dominate', () => {
  const attempts = [
    ...Array.from({ length: 10 }, () =>
      attempt({ support: 'worked', verdict: 'incorrect' }),
    ),
    attempt({ support: 'worked' }),
    attempt({ support: 'worked' }),
  ];
  assert.equal(state(attempts).concepts[0]!.recommended.support, 'worked');
});

test('easier independent success cannot erase an assisted misconception at a higher level', () => {
  const attempts = [
    attempt({
      support: 'worked',
      level: 'transfer',
      verdict: 'incorrect',
      confidence: 90,
    }),
    attempt({ level: 'recall' }),
  ];
  const concept = state(attempts).concepts[0]!;
  assert.equal(concept.assistedConfidentError, true);
  assert.equal(concept.confidentReview!.level, 'transfer');
  assert.deepEqual(concept.recommended, {
    level: 'transfer',
    support: 'worked',
  });
  assert.equal(state(attempts, 1).next[0]!.support, 'worked');
});

test('assisted confident errors remain visible without becoming independent memory evidence', () => {
  const attempts = [
    attempt(),
    attempt({ support: 'worked', verdict: 'incorrect', confidence: 90 }),
  ];
  const value = state(attempts);
  const concept = value.concepts[0]!;
  assert.equal(concept.confidentError, false);
  assert.equal(concept.assistedConfidentError, true);
  assert.equal(concept.confidentReview!.sourceSupport, 'worked');
  assert.equal(
    concept.stabilityDays,
    state(attempts.slice(0, 1)).concepts[0]!.stabilityDays,
  );
  assert.ok(!value.next.some((item) => item.conceptId === 'loops'));
  const later = state(attempts, 1);
  assert.equal(later.next[0]!.reason, 'confident-error');
  assert.equal(later.next[0]!.support, 'worked');
});

test('intervening questions allow a confident recheck without waiting a full day', () => {
  const error = attempt({ verdict: 'incorrect', confidence: 90 });
  const oneOther = [error, attempt({ concepts: ['conditions'] })];
  assert.ok(!state(oneOther).next.some((item) => item.conceptId === 'loops'));
  const enough = [...oneOther, attempt({ concepts: ['functions'] })];
  const value = state(enough);
  const concept = value.concepts.find((item) => item.id === 'loops')!;
  assert.equal(
    concept.confidentReview!.interveningAttempts,
    CONFIDENT_RECHECK.interveningAttempts,
  );
  assert.equal(concept.confidentReview!.recheckEligible, true);
  assert.equal(value.next[0]!.conceptId, 'loops');
  assert.equal(value.next[0]!.support, concept.recommended.support);
});

test('assisted remediation preserves diagnosis without restarting the recheck gap', () => {
  const error = attempt({
    support: 'worked',
    verdict: 'incorrect',
    confidence: 90,
  });
  const interleaved = [
    error,
    attempt({ concepts: ['a'] }),
    attempt({ concepts: ['b'] }),
  ];
  assert.equal(
    state(interleaved).concepts.find((item) => item.id === 'loops')!
      .confidentReview!.recheckEligible,
    true,
  );
  const remediation = [...interleaved, attempt({ support: 'worked' })];
  const value = state(remediation);
  const concept = value.concepts.find((item) => item.id === 'loops')!;
  assert.equal(concept.assistedConfidentError, true);
  assert.equal(concept.confidentError, false);
  assert.equal(concept.stabilityDays, null);
  assert.equal(concept.confidentReview!.recheckEligible, true);
  assert.equal(concept.confidentReview!.interveningAttempts, 3);
  assert.equal(concept.recommended.support, 'worked');
  assert.ok(value.next.some((item) => item.conceptId === 'loops'));
  const verified = state([...remediation, attempt()]).concepts.find(
    (item) => item.id === 'loops',
  )!;
  assert.equal(verified.assistedConfidentError, false);
  assert.equal(verified.confidentReview, null);
  assert.ok(verified.stabilityDays !== null);
});

test('a confident recheck becomes eligible exactly at its delay boundary', () => {
  const error = attempt({
    at: new Date(start).toISOString(),
    verdict: 'incorrect',
    confidence: 70,
  });
  const check = (milliseconds: number) =>
    computeLearnerState([error], {
      scopeKey: 'vault:v',
      scopeSignature: 'scope-a',
      now: new Date(milliseconds),
    });
  const eligibleAt = start + CONFIDENT_RECHECK.delayDays * DAY;
  assert.equal(
    check(eligibleAt - 1).concepts[0]!.confidentReview!.recheckEligible,
    false,
  );
  assert.equal(
    check(eligibleAt).concepts[0]!.confidentReview!.recheckEligible,
    true,
  );
  assert.equal(check(eligibleAt).next[0]!.reason, 'confident-error');
});

test('same-concept helped practice counts toward spacing and stays in recommendations', () => {
  const error = attempt({ verdict: 'incorrect', confidence: 90 });
  const first = state([error, attempt({ support: 'worked' })]);
  const c = first.concepts.find((c) => c.id === 'loops')!;
  assert.equal(c.confidentReview!.recheckEligible, false);
  assert.equal(c.confidentReview!.interveningAttempts, 1);
  assert.equal(c.confidentReview!.remediationAvailable, true);
  assert.ok(
    first.next.some((n) => n.conceptId === 'loops' && n.support === 'worked'),
  );
  const second = state([
    error,
    attempt({ support: 'worked' }),
    attempt({ support: 'worked' }),
  ]);
  assert.equal(second.concepts[0].confidentReview!.recheckEligible, true);
  assert.equal(second.next[0].support, 'hinted');
});
