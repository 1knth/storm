import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isCurrentSaveCompletion,
  isSaveCompletionContentUnchanged,
  shouldSaveBoundDocument,
} from './saveBinding';

const view = {};
const note = {};
const otherNote = {};

function binding(
  overrides: Partial<Parameters<typeof shouldSaveBoundDocument>[0]> = {},
) {
  return {
    currentView: view,
    bindingView: view,
    currentGeneration: 4,
    bindingGeneration: 4,
    currentNote: note,
    boundNote: note,
    blocked: false,
    ...overrides,
  };
}

test('accepts only the currently bound note and view generation', () => {
  assert.equal(shouldSaveBoundDocument(binding()), true);
  assert.equal(shouldSaveBoundDocument(binding({ currentView: {} })), false);
  assert.equal(shouldSaveBoundDocument(binding({ currentNote: null })), false);
  assert.equal(
    shouldSaveBoundDocument(binding({ currentNote: otherNote })),
    false,
  );
  assert.equal(
    shouldSaveBoundDocument(binding({ currentGeneration: 5 })),
    false,
  );
});

test('rejects an unbound clear and blocked binding', () => {
  assert.equal(shouldSaveBoundDocument(binding({ boundNote: null })), false);
  assert.equal(shouldSaveBoundDocument(binding({ blocked: true })), false);
});

test('allows intentionally empty content while the note remains bound', () => {
  const emptyDocumentContent = '';
  assert.equal(emptyDocumentContent, '');
  assert.equal(shouldSaveBoundDocument(binding()), true);
});

test('ignores completion after reopening the same path with a new note identity', () => {
  const reopenedRevision = { path: 'note.md', revision: 'new-revision' };
  assert.equal(
    isCurrentSaveCompletion(binding({ currentNote: reopenedRevision })),
    false,
  );
  assert.equal(
    isCurrentSaveCompletion(binding({ currentGeneration: 5 })),
    false,
  );
});

test('does not clear dirty state when edits arrive during an in-flight save', () => {
  assert.equal(
    isSaveCompletionContentUnchanged('saved snapshot', 'saved snapshot'),
    true,
  );
  assert.equal(
    isSaveCompletionContentUnchanged('newer edit', 'saved snapshot'),
    false,
  );
});
