import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileAgentTargetContent,
  agentTargetDiskRevision,
} from './agentTargetReconciliation';

describe('agent target content reconciliation', () => {
  it('uses fresh disk revision when matching live text still has older snapshot metadata', () => {
    const view = { content: 'saved update', revision: 'old-view-revision' };
    const disk = {
      content: 'saved update',
      revision: 'acknowledged-disk-revision',
    };
    assert.equal(agentTargetDiskRevision(disk, view.content), disk.revision);
    assert.notEqual(agentTargetDiskRevision(disk, view.content), view.revision);
  });
  it('rejects an edit arriving between reconciliation and the final snapshot', () => {
    assert.throws(
      () =>
        agentTargetDiskRevision(
          { content: 'saved', revision: 'r2' },
          'new unsaved edit',
        ),
      /changed while opening/,
    );
  });
  it('accepts content already saved by an agent despite the old baseline', () => {
    assert.equal(
      reconcileAgentTargetContent({
        baseline: 'old',
        tabContent: 'agent update',
        diskContent: 'agent update',
      }),
      'current',
    );
  });

  it('refreshes a clean stale tab from fresh disk', () => {
    assert.equal(
      reconcileAgentTargetContent({
        baseline: 'old',
        tabContent: 'old',
        diskContent: 'new disk content',
      }),
      'refresh',
    );
  });

  it('rejects unsaved local content that differs from baseline and disk', () => {
    assert.equal(
      reconcileAgentTargetContent({
        baseline: 'old',
        tabContent: 'local edit',
        diskContent: 'new disk content',
      }),
      'unsaved',
    );
  });

  it('ignores a stale editor snapshot belonging to another document', () => {
    // The caller only supplies activeContent after checking vault and path.
    assert.equal(
      reconcileAgentTargetContent({
        baseline: 'old',
        tabContent: 'saved agent update',
        diskContent: 'saved agent update',
      }),
      'current',
    );
  });

  it('preserves actual active-editor changes even when the tab snapshot is stale', () => {
    assert.equal(
      reconcileAgentTargetContent({
        baseline: 'old',
        tabContent: 'old',
        diskContent: 'new disk content',
        activeContent: 'active local edit',
      }),
      'unsaved',
    );
  });
});
