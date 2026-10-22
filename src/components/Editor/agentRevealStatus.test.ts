import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorState } from '@codemirror/state';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentDocumentController } from '../../documents/agentDocumentController';
import { AgentStatusBar } from './AgentStatusBar';
import {
  createRevealProgressState,
  deriveFinalPreviewState,
  shouldShowRevealingStatus,
} from './managedPreviewBatch';

test('one full append followed by finish stays Writing until its explicit generation drains', async () => {
  const controller = new AgentDocumentController();
  const document = controller.attach(
    'note',
    '/vault/note.md',
    EditorState.create(),
  );
  const markdown = 'A complete review arrives in one append.';
  await controller.append(document, markdown);
  controller.finish(document);
  assert.equal(document.status, 'finished');
  assert.equal(document.acceptedVersion, 1);
  assert.deepEqual(document.reveal.ranges, [{ from: 0, to: markdown.length }]);

  // No intermediate writing render or legacy append baseline is needed.
  const revealId = JSON.stringify([
    'note',
    document.reveal.generation,
    document.reveal.documentVersion,
  ]);
  const generation = JSON.stringify(['note', revealId]);
  const receipts = new Map([
    [1, { generationId: generation, previewKey: 1, pending: true }],
  ]);
  const drained = () =>
    deriveFinalPreviewState({
      activeDocumentKey: 'note',
      latestAcceptedMarkdown: document.state.doc.toString(),
      publishedSnapshot: { docKey: 'note', markdown, previewRevision: 1 },
      batchPending: false,
      generationKey: generation,
      receiptsMap: receipts,
    });
  const label = () =>
    renderToStaticMarkup(
      createElement(AgentStatusBar, {
        status: {
          sessionId: 'session',
          absolutePath: '/vault/note.md',
          state: 'finished',
          documentVersion: 1,
          diskRevision: 'saved',
          pendingOperations: 0,
        },
        previewPending: shouldShowRevealingStatus(
          true,
          false,
          document.reveal.ranges.length > 0,
          drained(),
        ),
      }),
    );
  assert.match(label(), />Writing</);
  assert.doesNotMatch(label(), /Revealing/);
  assert.doesNotMatch(label(), /Stop agent/);
  receipts.set(1, { generationId: generation, previewKey: 1, pending: false });
  assert.match(label(), />Finished</);

  // Reduced motion emits a drained receipt without waiting for animations.
  const reduced = createRevealProgressState(generation, 1, ['word'], true);
  receipts.set(1, {
    generationId: generation,
    previewKey: 1,
    pending: reduced.pendingKeys.size > 0,
  });
  assert.match(label(), />Finished</);
  // A completion from another generation must not finish this reveal.
  receipts.set(1, {
    generationId: 'previous-generation',
    previewKey: 1,
    pending: false,
  });
  assert.match(label(), />Writing</);
  assert.doesNotMatch(label(), /Revealing/);
});
