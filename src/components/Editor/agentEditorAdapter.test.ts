import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  agentWritingLockExtensions,
  shouldBlockAgentEditorMouseDown,
} from './agentEditorAdapter';

describe('agent editor writing lock', () => {
  it('blocks mouse selection starts while leaving scrolling events alone', () => {
    assert.equal(shouldBlockAgentEditorMouseDown(true), true);
    assert.equal(shouldBlockAgentEditorMouseDown(false), false);
    // The lock intercepts mousedown only; wheel and touch scrolling are not
    // cancelled or covered by an overlay.
  });

  it('marks the view non-editable but permits owner-driven document updates', () => {
    const state = EditorState.create({
      doc: 'before',
      extensions: agentWritingLockExtensions(true),
    });
    assert.equal(state.facet(EditorState.readOnly), true);
    assert.equal(state.facet(EditorView.editable), false);

    const ownerUpdate = state.update({
      changes: { from: 0, to: 6, insert: 'remote' },
    });
    assert.equal(ownerUpdate.state.doc.toString(), 'remote');
  });

  it('restores editing extensions after writing ends', () => {
    const state = EditorState.create({
      doc: 'before',
      extensions: agentWritingLockExtensions(false),
    });
    assert.equal(state.facet(EditorState.readOnly), false);
    assert.equal(state.facet(EditorView.editable), true);
  });
});
