import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getClipboardImages,
  getQuizAnswerFields,
  getQuizConfidenceLabel,
  getQuizComposerIntent,
  handleQuizComposerEnter,
  isCompleteQuestionAnswer,
  quizCliInstructions,
  quizPiAttachCommand,
  shouldClearSubmittedDraft,
} from './quizComposer';
import type { QuizQuestion } from '../shared/quizProtocol';

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

test('clipboard images ignore distinct duplicate File objects from files', () => {
  const fromItem = { type: 'image/png' } as File;
  const fromFiles = { type: 'image/png' } as File;
  const result = getClipboardImages({
    items: [{ kind: 'file', type: 'image/png', getAsFile: () => fromItem }],
    files: [fromFiles],
  });
  assert.deepEqual(result, [fromItem]);
  assert.deepEqual(getClipboardImages({ items: [], files: [fromFiles] }), [
    fromFiles,
  ]);
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

test('composer sends messages before prompt responses and never submits answers', () => {
  assert.equal(getQuizComposerIntent('  hello  '), 'message');
  assert.equal(getQuizComposerIntent(''), null);
  assert.equal(getQuizComposerIntent('continue'), 'message');
  assert.equal(getQuizComposerIntent('clear it'), 'message');
  assert.equal(getQuizComposerIntent('', 1), 'message');
  assert.equal(getQuizComposerIntent('', 1, true), 'message');
  assert.equal(getQuizComposerIntent('optional detail', 0, true), 'message');
  assert.equal(getQuizComposerIntent('', 0, true), 'prompt');
  assert.equal(getQuizComposerIntent('  '), null);
});

test('quiz composer Enter sends once only for plain Enter', () => {
  assert.deepEqual(press(), { prevented: true, sends: 1 });
  assert.deepEqual(press({ shiftKey: true }), { prevented: false, sends: 0 });
  assert.deepEqual(press({ isComposing: true }), {
    prevented: false,
    sends: 0,
  });
});

test('composer intent does nothing when blank', () => {
  assert.equal(getQuizComposerIntent(''), null);
  assert.equal(getQuizComposerIntent('  '), null);
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
  assert.equal(getQuizComposerIntent('chat draft'), 'message');
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

test('confidence anchors cover every slider step and bucket boundaries', () => {
  const buckets = [
    [0, 20, 'Guessing'],
    [25, 45, 'Unsure'],
    [50, 65, 'Fairly sure'],
    [70, 90, 'Confident'],
    [95, 100, 'Certain'],
  ] as const;
  for (const [start, end, label] of buckets) {
    for (let confidence = start; confidence <= end; confidence += 5)
      assert.equal(getQuizConfidenceLabel(confidence), label);
  }
});

const question: QuizQuestion = {
  id: 'question-a',
  prompt: 'Choose an answer',
  choices: [{ id: 'a', text: 'A' }],
  status: 'open',
  selectedChoiceId: 'a',
  reasoningDraft: 'Because…',
  feedback: null,
};

test('answer submission requires a complete answer and valid explicit confidence', () => {
  for (const confidence of [null, -1, 101, 50.5, NaN])
    assert.equal(getQuizAnswerFields(question, confidence), null);
  assert.equal(
    getQuizAnswerFields({ ...question, selectedChoiceId: null }, 70),
    null,
  );
  for (const status of ['answered', 'feedback'] as const)
    assert.equal(getQuizAnswerFields({ ...question, status }, 70), null);
  assert.deepEqual(getQuizAnswerFields(question, 0), {
    choiceId: 'a',
    reasoning: 'Because…',
    confidence: 0,
  });
});

test('all four answer payloads include the learner confidence and existing fields', () => {
  assert.deepEqual(getQuizAnswerFields(question, 70), {
    choiceId: 'a',
    reasoning: 'Because…',
    confidence: 70,
  });
  const matching: QuizQuestion = {
    ...question,
    kind: 'matching',
    leftItems: [{ id: 'left', text: 'Left' }],
    rightItems: [{ id: 'right', text: 'Right' }],
    matchesDraft: { left: 'right' },
  };
  assert.deepEqual(getQuizAnswerFields(matching, 85), {
    matches: { left: 'right' },
    reasoning: 'Because…',
    confidence: 85,
  });
  assert.equal(
    getQuizAnswerFields({ ...matching, matchesDraft: {} }, 85),
    null,
  );
  assert.equal(getQuizAnswerFields(matching, null), null);
  for (const kind of ['short-answer', 'long-answer'] as const) {
    assert.deepEqual(
      getQuizAnswerFields({ ...question, kind, textDraft: 'My answer' }, 100),
      { answer: 'My answer', confidence: 100 },
    );
    assert.equal(
      getQuizAnswerFields({ ...question, kind, textDraft: ' ' }, 100),
      null,
    );
    assert.equal(
      getQuizAnswerFields({ ...question, kind, textDraft: 'My answer' }, null),
      null,
    );
  }
});

test('the Pi clipboard route carries only the attach command', () => {
  assert.equal(quizPiAttachCommand('quiz-1'), '/storm-quiz attach quiz-1');
});

test('CLI instructions bootstrap an agent without restating help', () => {
  const scoped = quizCliInstructions('quiz-1', true);
  assert.ok(scoped.includes('storm quiz attach quiz-1'));
  assert.ok(scoped.includes('bun scripts/storm.ts quiz attach quiz-1'));
  assert.ok(scoped.includes('storm quiz --help'));
  assert.ok(scoped.includes('result.value.agentToken'));
  assert.ok(scoped.includes('does not keep your host alive'));
  assert.ok(scoped.includes('Never assign a verdict to a chat command'));
  assert.ok(scoped.includes('Inspect scope'));
  // Guidance the attach prompt and CLI help already own stays out of the clipboard.
  assert.ok(!scoped.includes('--after CURSOR'));
  assert.ok(!scoped.includes('expectedRevision'));
  assert.ok(scoped.length < 700);
  const unscoped = quizCliInstructions('quiz-1', false);
  assert.ok(unscoped.includes('Sources not selected'));
  assert.ok(!unscoped.includes('Inspect scope'));
});
