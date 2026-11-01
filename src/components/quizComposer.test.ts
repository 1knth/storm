import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getClipboardImages,
  getQuizComposerIntent,
  handleQuizComposerEnter,
  isCompleteQuestionAnswer,
  shouldClearSubmittedDraft,
} from './quizComposer';

function press(
  overrides: Partial<{
    key: string;
    shiftKey: boolean;
    isComposing: boolean;
  }> = {},
) {
  let prevented = false;
  let sends = 0;
  handleQuizComposerEnter(
    {
      key: 'Enter',
      shiftKey: false,
      isComposing: false,
      preventDefault: () => {
        prevented = true;
      },
      ...overrides,
    },
    true,
    () => sends++,
  );
  return { prevented, sends };
}

test('clipboard images use item data when files is empty and deduplicate fallback files', () => {
  const file = { type: 'image/png' } as File;
  const textFile = { type: 'text/plain' } as File;
  const result = getClipboardImages({
    items: [
      { kind: 'file', type: 'image/png', getAsFile: () => file },
      { kind: 'string', type: 'text/plain', getAsFile: () => textFile },
      { kind: 'file', type: 'image/jpeg', getAsFile: () => null },
    ],
    files: [file, textFile],
  });
  assert.deepEqual(result, [file]);
});

test('successful sends clear the exact submitted draft, not normalized text or later typing', () => {
  const multiline = 'first line\nsecond line\n';
  assert.equal(shouldClearSubmittedDraft(multiline, multiline), true);
  assert.equal(shouldClearSubmittedDraft('new text', multiline), false);
  assert.equal(
    shouldClearSubmittedDraft('first line\nsecond line', multiline),
    false,
  );
});

test('answer, chat, and prompt intents preserve their priority', () => {
  assert.equal(getQuizComposerIntent('  hello  ', true), 'answer');
  assert.equal(getQuizComposerIntent('', true), 'answer');
  assert.equal(getQuizComposerIntent('  hello  ', false), 'message');
  assert.equal(
    getQuizComposerIntent('optional detail', false, 0, true),
    'message',
  );
  assert.equal(getQuizComposerIntent('', false, 0, true), 'prompt');
  assert.equal(getQuizComposerIntent('  ', false), null);
});

test('quiz composer Enter sends once only for plain Enter', () => {
  assert.deepEqual(press(), { prevented: true, sends: 1 });
  assert.deepEqual(press({ shiftKey: true }), { prevented: false, sends: 0 });
  assert.deepEqual(press({ isComposing: true }), {
    prevented: false,
    sends: 0,
  });
});

test('composer intent does nothing when blank and answer is incomplete', () => {
  assert.equal(getQuizComposerIntent('', false), null);
  assert.equal(getQuizComposerIntent('  ', false), null);
});

test('answer completeness covers choice, unique complete matching, and text', () => {
  assert.equal(isCompleteQuestionAnswer('multiple-choice', {}), false);
  assert.equal(
    isCompleteQuestionAnswer('multiple-choice', { choiceId: 'a' }),
    true,
  );
  const leftItems = ['one', 'two'];
  assert.equal(
    isCompleteQuestionAnswer('matching', { leftItems, matches: { one: 'x' } }),
    false,
  );
  assert.equal(
    isCompleteQuestionAnswer('matching', {
      leftItems,
      matches: { one: 'x', two: 'x' },
    }),
    false,
  );
  const completeMatching = isCompleteQuestionAnswer('matching', {
    leftItems,
    matches: { one: 'x', two: 'y' },
  });
  assert.equal(completeMatching, true);
  assert.equal(getQuizComposerIntent('chat draft', completeMatching), 'answer');
  assert.equal(
    getQuizComposerIntent(
      'chat draft',
      isCompleteQuestionAnswer('matching', {
        leftItems,
        matches: { one: 'x' },
      }),
    ),
    'message',
  );
  assert.equal(
    isCompleteQuestionAnswer('matching', {
      leftItems,
      matches: { one: 'x', two: 'y', stale: 'z' },
    }),
    true,
  );
  assert.equal(
    isCompleteQuestionAnswer('matching', { leftItems: [], matches: {} }),
    false,
  );
  for (const kind of ['short-answer', 'long-answer'] as const) {
    assert.equal(isCompleteQuestionAnswer(kind, { text: '  ' }), false);
    assert.equal(isCompleteQuestionAnswer(kind, { text: 'answer' }), true);
  }
});

test('plain Enter is consumed without sending when disconnected', () => {
  let prevented = false;
  let sends = 0;
  handleQuizComposerEnter(
    {
      key: 'Enter',
      shiftKey: false,
      isComposing: false,
      preventDefault: () => {
        prevented = true;
      },
    },
    false,
    () => sends++,
  );
  assert.equal(prevented, true);
  assert.equal(sends, 0);
});
