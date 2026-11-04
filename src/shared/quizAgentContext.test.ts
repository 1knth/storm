import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  quizAgentEvent,
  quizAgentQuestion,
  quizHistoryPage,
} from './quizAgentContext';

test('agent context preserves submitted confidence and strongest supplied help without capabilities', () => {
  const question = quizAgentQuestion({
    id: 'q',
    status: 'answered',
    confidence: 95,
    suppliedSupport: 'worked',
    gradedAt: '2026-11-04T00:00:00Z',
    unmodelledReason: 'Orientation check',
    agentToken: 'private',
  });
  assert.equal(question?.confidence, 95);
  assert.equal(question?.suppliedSupport, 'worked');
  assert.equal(question?.gradedAt, '2026-11-04T00:00:00Z');
  assert.equal(question?.unmodelledReason, 'Orientation check');
  assert.equal(question?.agentToken, undefined);
  assert.equal(
    quizAgentQuestion({ id: 'q', status: 'open', confidence: 95 })?.confidence,
    undefined,
  );
});

test('support updates survive event projection and leave private fields out', () => {
  const event = quizAgentEvent({
    type: 'support-update',
    data: { questionId: 'q', support: 'hinted', agentToken: 'private' },
  });
  assert.deepEqual(event.data, { questionId: 'q', support: 'hinted' });
});

test('graded history retains confidence even without a live question status', () => {
  const history = quizHistoryPage([
    {
      id: 'feedback',
      role: 'agent',
      text: 'Correction',
      question: {
        id: 'q',
        verdict: 'incorrect',
        confidence: 95,
        suppliedSupport: 'hinted',
      },
    },
  ]);
  assert.equal(history.entries[0]?.question.confidence, 95);
  assert.equal(history.entries[0]?.question.suppliedSupport, 'hinted');
});
