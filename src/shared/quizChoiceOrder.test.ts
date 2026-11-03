import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAnchoredQuizChoice,
  orderQuizChoices,
  orderQuizMatchOptions,
} from './quizChoiceOrder';

const choices = (...texts: string[]) =>
  texts.map((text, index) => ({ id: `c${index}`, text }));
const ids = (items: { id: string }[]) => items.map((item) => item.id);

describe('quiz choice order', () => {
  it('is stable for a seed and preserves every id/text pair exactly once', () => {
    const posed = choices('Alpha', 'Beta', 'Gamma', 'Delta');
    const first = orderQuizChoices(posed, 'question-1');
    const again = orderQuizChoices(posed, 'question-1');
    assert.deepEqual(first, again);
    assert.deepEqual([...ids(first)].sort(), ['c0', 'c1', 'c2', 'c3']);
    for (const choice of posed)
      assert.deepEqual(
        first.find((item) => item.id === choice.id),
        choice,
      );
  });

  it('spreads an always-first correct option across every position', () => {
    const counts = [0, 0, 0, 0];
    for (let index = 0; index < 400; index++) {
      const ordered = orderQuizChoices(
        choices('Correct', 'Wrong one', 'Wrong two', 'Wrong three'),
        `question-${index}`,
      );
      counts[ordered.findIndex((choice) => choice.text === 'Correct')]++;
    }
    assert.equal(
      counts.reduce((total, count) => total + count, 0),
      400,
    );
    for (const count of counts) assert.ok(count > 40, `skewed: ${counts}`);
  });

  it('keeps summary options last and leaves a single option untouched', () => {
    const ordered = orderQuizChoices(
      choices('Only when sorted', 'None of the above', 'All of these', 'Never'),
      'question-anchor',
    );
    assert.deepEqual(
      ordered.slice(2).map((choice) => choice.text),
      ['None of the above', 'All of these'],
    );
    assert.deepEqual(orderQuizChoices(choices('Single'), 'seed'), [
      { id: 'c0', text: 'Single' },
    ]);
    assert.ok(isAnchoredQuizChoice('**all of the above**'));
    assert.ok(!isAnchoredQuizChoice('All employees above pay grade 4'));
  });

  it('sorts quantity options ascending rather than shuffling them', () => {
    for (const seed of ['a', 'b', 'c']) {
      assert.deepEqual(
        orderQuizChoices(choices('$1,200.50', '12 kg', '-3', '7.5%'), seed).map(
          (choice) => choice.text,
        ),
        ['-3', '7.5%', '12 kg', '$1,200.50'],
      );
    }
    const mixed = orderQuizChoices(
      choices('3 apples', 'three apples and a long tail of prose'),
      'seed',
    );
    assert.equal(mixed.length, 2);
  });

  it('never presents matching options in the authored pair order', () => {
    for (let index = 0; index < 200; index++) {
      const posed = choices('Right 1', 'Right 2', 'Right 3');
      const ordered = orderQuizMatchOptions(posed, `question-${index}`);
      assert.deepEqual([...ids(ordered)].sort(), ['c0', 'c1', 'c2']);
      assert.ok(ordered.some((item, position) => item !== posed[position]));
    }
    const pair = choices('Right 1', 'Right 2');
    assert.deepEqual(ids(orderQuizMatchOptions(pair, 'seed')).sort(), [
      'c0',
      'c1',
    ]);
    assert.ok(
      orderQuizMatchOptions(pair, 'seed').some(
        (item, position) => item.id !== pair[position].id,
      ),
    );
  });
});
