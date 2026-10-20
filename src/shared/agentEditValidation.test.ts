import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isAgentEditPlan } from './agentEditValidation';

describe('isAgentEditPlan', () => {
  it('accepts replace and replaceText plans', () => {
    assert.equal(isAgentEditPlan({ type: 'replace', content: '# Note' }), true);
    assert.equal(
      isAgentEditPlan({
        type: 'replaceText',
        replacements: [{ find: 'before', replace: 'after' }],
      }),
      true,
    );
    assert.equal(
      isAgentEditPlan({ type: 'replaceText', replacements: [] }),
      true,
    );
  });

  it('rejects malformed plans and replacements', () => {
    for (const value of [
      null,
      [],
      { type: 'replace' },
      { type: 'replace', content: 1 },
      { type: 'append', content: 'x' },
      { type: 'replaceText', replacements: {} },
      { type: 'replaceText', replacements: [{ find: '', replace: 'x' }] },
      { type: 'replaceText', replacements: [{ find: 'x', replace: 1 }] },
    ]) {
      assert.equal(isAgentEditPlan(value), false, JSON.stringify(value));
    }
  });
});
