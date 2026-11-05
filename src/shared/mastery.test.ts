import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LearnerAttempt } from './learnerModel';
import {
  masteryEvidence,
  masteryShortfall,
  questionFingerprintSource,
} from './mastery';

let clock = 0;
const attempt = (fields: Partial<LearnerAttempt>): LearnerAttempt => {
  clock += 1;
  return {
    id: `q${clock}`,
    sessionId: 's1',
    scopeSignature: 'scope',
    at: new Date(Date.UTC(2026, 10, 1, 0, clock)).toISOString(),
    concepts: ['loops'],
    level: 'recall',
    support: 'independent',
    verdict: 'correct',
    fingerprint: `f${clock}`,
    ...fields,
  };
};

/** Two fresh independent correct items: one apply in a test, one with sound reasoning. */
const mastered = () => [
  attempt({ level: 'explain', reasoning: 'sound' }),
  attempt({ level: 'apply', testId: 't1' }),
];

test('mastery requires every recorded criterion', () => {
  const evidence = masteryEvidence('loops', mastered());
  assert.equal(evidence.mastered, true);
  assert.deepEqual(evidence.missing, []);
  assert.deepEqual(evidence.counts, {
    freshIndependentCorrect: 2,
    applyOrHigher: 1,
    finalTest: 1,
    soundReasoning: 1,
    uncheckedConfidentErrors: 0,
  });
});

test('each missing criterion is named for the tutor', () => {
  const evidence = masteryEvidence('loops', [attempt({ level: 'recall' })]);
  assert.equal(evidence.mastered, false);
  assert.deepEqual(evidence.missing, [
    '1 more fresh independent correct item',
    'a fresh independent correct item at apply level or higher',
    'a fresh independent correct item in a practice test',
    'feedback with reasoning "sound" on one of those correct items',
  ]);
  assert.match(masteryShortfall([evidence]), /^loops: needs 1 more fresh/);
});

test('assisted, repeated and legacy items do not count', () => {
  const [first, second] = mastered();
  const evidence = masteryEvidence('loops', [
    first!,
    // Same wording as the first item: not fresh.
    attempt({ level: 'apply', testId: 't1', fingerprint: first!.fingerprint }),
    attempt({ level: 'apply', testId: 't1', support: 'hinted' }),
    // Recorded before fingerprints existed: freshness is unproven.
    attempt({ level: 'apply', testId: 't1', fingerprint: undefined }),
  ]);
  assert.equal(evidence.counts.freshIndependentCorrect, 1);
  assert.equal(evidence.mastered, false);
  assert.equal(masteryEvidence('loops', [first!, second!]).mastered, true);
});

test('a confident error needs a correct recheck on a new item', () => {
  const error = attempt({ verdict: 'incorrect', confidence: 90 });
  const unchecked = masteryEvidence('loops', [error, ...mastered()]);
  // The later correct items recheck the error, so mastery holds.
  assert.equal(unchecked.counts.uncheckedConfidentErrors, 0);
  assert.equal(unchecked.mastered, true);
  const late = masteryEvidence('loops', [
    ...mastered(),
    attempt({ verdict: 'incorrect', confidence: 90, support: 'hinted' }),
  ]);
  assert.equal(late.counts.uncheckedConfidentErrors, 1);
  assert.equal(late.mastered, false);
});

test('the latest independent miss withdraws mastery until a correct answer follows', () => {
  const lapsed = [...mastered(), attempt({ verdict: 'incorrect' })];
  assert.equal(masteryEvidence('loops', lapsed).mastered, false);
  assert.equal(
    masteryEvidence('loops', [...lapsed, attempt({})]).mastered,
    true,
  );
});

test('retained needs a correct independent answer in a later session', () => {
  const base = mastered();
  assert.equal(masteryEvidence('loops', base).retained, false);
  assert.equal(
    masteryEvidence('loops', [...base, attempt({})]).retained,
    false,
    'same session is not a delayed check',
  );
  assert.equal(
    masteryEvidence('loops', [...base, attempt({ sessionId: 's2' })]).retained,
    true,
  );
});

test('other concepts do not count, but their wording still blocks reuse', () => {
  const other = attempt({ concepts: ['arrays'], fingerprint: 'shared' });
  const evidence = masteryEvidence('loops', [
    other,
    attempt({ level: 'explain', reasoning: 'sound', fingerprint: 'shared' }),
    attempt({ level: 'apply', testId: 't1' }),
  ]);
  assert.equal(evidence.counts.freshIndependentCorrect, 1);
});

test('fingerprints ignore case, spacing and option order but not content', () => {
  const base = {
    kind: 'multiple-choice' as const,
    prompt: 'What is  2 + 2?',
    choices: [
      { id: 'a', text: 'Four' },
      { id: 'b', text: 'Five' },
    ],
  };
  const same = {
    ...base,
    prompt: 'what is 2 + 2?',
    choices: [
      { id: 'x', text: 'five' },
      { id: 'y', text: 'FOUR' },
    ],
  };
  assert.equal(
    questionFingerprintSource(base),
    questionFingerprintSource(same),
  );
  assert.notEqual(
    questionFingerprintSource(base),
    questionFingerprintSource({ ...base, prompt: 'What is 3 + 3?' }),
  );
});

test('a partial answer after a miss does not restore mastery', () => {
  const lapsed = [
    ...mastered(),
    attempt({ verdict: 'incorrect' }),
    attempt({ verdict: 'partial' }),
  ];
  assert.equal(masteryEvidence('loops', lapsed).mastered, false);
});

test('a familiar item cannot clear a confident error', () => {
  const [first, second] = mastered();
  const evidence = masteryEvidence('loops', [
    first!,
    second!,
    attempt({ verdict: 'incorrect', confidence: 90 }),
    attempt({ fingerprint: first!.fingerprint }),
  ]);
  assert.equal(evidence.counts.uncheckedConfidentErrors, 1);
  assert.equal(evidence.mastered, false);
});

test('an item shown earlier without a grade is not fresh', () => {
  const [first, second] = mastered();
  const exposure = {
    id: 'skipped',
    at: '2026-10-01T00:00:00.000Z',
    fingerprint: second!.fingerprint!,
  };
  const evidence = masteryEvidence('loops', [first!, second!], [exposure]);
  assert.equal(evidence.counts.freshIndependentCorrect, 1);
  assert.equal(evidence.mastered, false);
});
