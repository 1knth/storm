import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getTabId } from './tabGroups';
import { closeTabTransition } from './tabTransitions';

const emptyTab = (id: string) => ({ kind: 'empty' as const, id });

describe('closeTabTransition', () => {
  it('removes a background tab without changing the active tab', () => {
    const tabs = [emptyTab('first'), emptyTab('active'), emptyTab('last')];
    const result = closeTabTransition(tabs, 'first', 'active', getTabId);

    assert.deepEqual(result, {
      remaining: [tabs[1], tabs[2]],
      wasActive: false,
      nextActive: null,
    });
  });

  it('selects the last remaining tab when the active tab closes', () => {
    const tabs = [emptyTab('first'), emptyTab('active')];
    const result = closeTabTransition(tabs, 'active', 'active', getTabId);

    assert.deepEqual(result, {
      remaining: [tabs[0]],
      wasActive: true,
      nextActive: tabs[0],
    });
  });

  it('returns no fallback when closing the only active tab or with zero tabs', () => {
    const onlyTab = emptyTab('only');
    assert.deepEqual(closeTabTransition([onlyTab], 'only', 'only', getTabId), {
      remaining: [],
      wasActive: true,
      nextActive: null,
    });
    assert.deepEqual(closeTabTransition([], 'missing', null, getTabId), {
      remaining: [],
      wasActive: false,
      nextActive: null,
    });
  });
});
