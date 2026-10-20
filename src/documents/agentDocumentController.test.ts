import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { AgentDocumentController } from './agentDocumentController';

describe('AgentDocumentController', () => {
  it('previews exact original-snapshot replacements, rejects invalid plans, and applies atomically', async () => {
    const saved: string[] = [];
    const controller = new AgentDocumentController(async ({ content }) => {
      saved.push(content);
      return { revision: 'r2' };
    });
    const document = controller.attach(
      'edit',
      '/vault',
      'a.md',
      EditorState.create({ doc: 'A🙂 B A' }),
      'r1',
    );
    assert.deepEqual(
      controller.previewEdit(document, 0, {
        type: 'replaceText',
        replacements: [
          { find: '🙂', replace: 'é\n' },
          { find: 'B', replace: '' },
        ],
      }),
      { content: 'Aé\n  A', changed: true },
    );
    for (const plan of [
      {
        type: 'replaceText' as const,
        replacements: [{ find: 'missing', replace: '' }],
      },
      {
        type: 'replaceText' as const,
        replacements: [{ find: 'A', replace: '' }],
      },
      {
        type: 'replaceText' as const,
        replacements: [
          { find: '🙂 B', replace: '' },
          { find: 'B A', replace: '' },
        ],
      },
    ])
      assert.throws(() => controller.previewEdit(document, 0, plan));
    assert.equal(document.state.doc.toString(), 'A🙂 B A');
    const result = await controller.applyEdit(document, 0, {
      type: 'replace',
      content: '',
    });
    assert.equal(result.content, '');
    assert.deepEqual(saved, ['']);
    assert.equal(document.acceptedVersion, 1);
  });

  it('acknowledges a clean no-op against the attached revision and content', async () => {
    let calls = 0;
    const controller = new AgentDocumentController(async () => {
      calls++;
      return { revision: 'unexpected' };
    });
    const document = controller.attach(
      'doc',
      '/vault',
      'a.md',
      EditorState.create({ doc: 'same' }),
      'r1',
    );
    assert.deepEqual(
      await controller.applyEdit(document, 0, {
        type: 'replace',
        content: 'same',
      }),
      {
        version: 0,
        content: 'same',
      },
    );
    assert.equal(document.revision, 'r1');
    assert.equal(document.persistedContent, 'same');
    assert.equal(calls, 0);
  });

  it('does not acknowledge a no-op edit until pre-existing dirty content is persisted', async () => {
    let resolveSave!: (value: { revision: string }) => void;
    const controller = new AgentDocumentController(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    const document = controller.attach(
      'doc',
      '/vault',
      'a.md',
      EditorState.create({ doc: 'same' }),
      'r1',
    );
    controller.updateFromEditor('doc', EditorState.create({ doc: 'same' }));
    const applying = controller.applyEdit(document, 1, {
      type: 'replace',
      content: 'same',
    });
    await Promise.resolve();
    let acknowledged = false;
    void applying.then(() => {
      acknowledged = true;
    });
    await Promise.resolve();
    assert.equal(acknowledged, false);
    resolveSave({ revision: 'r2' });
    assert.deepEqual(await applying, { version: 1, content: 'same' });
  });

  it('rejects an edit acknowledgment if a human edit arrives during its save', async () => {
    let resolveSave!: (value: { revision: string }) => void;
    let calls = 0;
    const controller = new AgentDocumentController(() => {
      calls++;
      if (calls > 1) return Promise.resolve({ revision: 'r3' });
      return new Promise((resolve) => {
        resolveSave = resolve;
      });
    });
    const document = controller.attach(
      'doc',
      '/vault',
      'a.md',
      EditorState.create({ doc: 'old' }),
      'r1',
    );
    const applying = controller.applyEdit(document, 0, {
      type: 'replace',
      content: 'agent',
    });
    await Promise.resolve();
    controller.updateFromEditor(
      'doc',
      EditorState.create({ doc: 'human edit' }),
    );
    resolveSave({ revision: 'r2' });
    await assert.rejects(applying, /changed while saving/);
    assert.equal(document.state.doc.toString(), 'human edit');
    assert.equal(document.persistedContent, 'human edit');
    assert.equal(document.dirty, false);
  });

  it('guards against human unsaved edits and reports save failures without partial target changes', async () => {
    const controller = new AgentDocumentController(async () => {
      throw new Error('save failed');
    });
    const document = controller.attach(
      'edit',
      '/vault',
      'a.md',
      EditorState.create({ doc: 'old' }),
      'disk-r1',
    );
    controller.updateFromEditor(
      'edit',
      EditorState.create({ doc: 'human unsaved' }),
    );
    assert.throws(
      () =>
        controller.previewEdit(document, 0, {
          type: 'replace',
          content: 'new',
        }),
      /Stale/,
    );
    await assert.rejects(
      controller.applyEdit(document, 1, { type: 'replace', content: 'new' }),
      /save failed/,
    );
    assert.equal(document.state.doc.toString(), 'new');
    assert.equal(document.dirty, true);
  });

  it('keeps per-document state isolated across background appends', async () => {
    const controller = new AgentDocumentController();
    const first = controller.attach(
      'one',
      '/vault/one.md',
      EditorState.create({ doc: 'one' }),
    );
    const second = controller.attach(
      'two',
      '/vault/two.md',
      EditorState.create({ doc: 'two' }),
    );
    await controller.append(first, '\nagent');
    assert.equal(second.state.doc.toString(), 'two');
    assert.equal(first.state.doc.toString(), 'one\nagent');
  });

  it('preserves human edits and accepts agent appends against the current document', async () => {
    const controller = new AgentDocumentController();
    const document = controller.attach(
      'one',
      '/vault/one.md',
      EditorState.create({ doc: '- [ ] task' }),
    );
    const checkbox = document.state.update({
      changes: { from: 3, to: 4, insert: 'x' },
    });
    controller.publishHumanTransaction(document, checkbox);
    await controller.append(document, '\nagent text');
    assert.equal(document.state.doc.toString(), '- [x] task\nagent text');
    assert.equal(document.acceptedVersion, 2);
  });

  it('applies appends to a background document without disturbing another active buffer', async () => {
    const controller = new AgentDocumentController();
    const background = controller.attach(
      'background',
      '/vault/background.md',
      EditorState.create({ doc: 'start' }),
    );
    const active = controller.attach(
      'active',
      '/vault/active.md',
      EditorState.create({ doc: 'untouched' }),
    );
    await controller.append(background, '\nagent');
    assert.equal(background.state.doc.toString(), 'start\nagent');
    assert.equal(active.state.doc.toString(), 'untouched');
  });

  it('persists background edits with captured vault path and revision, including edits made in flight', async () => {
    let resolveSave!: (value: { revision: string }) => void;
    const requests: Array<{
      vaultPath: string;
      path: string;
      content: string;
      revision: string;
    }> = [];
    const controller = new AgentDocumentController((request) => {
      requests.push(request);
      return new Promise((resolve) => {
        resolveSave = resolve;
      });
    });
    const document = controller.attach(
      'doc',
      '/vault-a',
      'notes/a.md',
      EditorState.create({ doc: 'first' }),
      'r1',
    );
    controller.updateFromEditor('doc', EditorState.create({ doc: 'second' }));
    await Promise.resolve();
    assert.deepEqual(requests[0], {
      vaultPath: '/vault-a',
      path: 'notes/a.md',
      content: 'second',
      revision: 'r1',
    });
    controller.updateFromEditor('doc', EditorState.create({ doc: 'third' }));
    resolveSave({ revision: 'r2' });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(requests[1]?.content, 'third');
    assert.equal(requests[1]?.revision, 'r2');
    resolveSave({ revision: 'r3' });
    assert.equal(await controller.flush(document), true);
  });

  it('notifies for agent and human updates; conflicts retain dirty state without retry', async () => {
    let calls = 0;
    const controller = new AgentDocumentController(async () => {
      calls++;
      throw new Error('conflict');
    });
    const observed: string[] = [];
    controller.subscribe((document) =>
      observed.push(`${document.state.doc.toString()}:${document.status}`),
    );
    const document = controller.attach(
      'doc',
      '/vault',
      'a.md',
      EditorState.create({ doc: 'base' }),
      'r',
    );
    controller.publishHumanTransaction(
      document,
      document.state.update({ changes: { from: 0, insert: 'H' } }),
    );
    await assert.rejects(controller.flush(document), /conflict/);
    assert.equal(document.dirty, true);
    assert.equal(document.conflict, true);
    assert.equal(calls, 1);
    assert.ok(observed.includes('Hbase:connected'));
    const pending = controller.append(document, '!');
    await pending;
    assert.ok(observed.includes('Hbase!:writing'));
    assert.equal(calls, 1);
  });

  it('saves an accepted editor update when close starts immediately', async () => {
    const requests: Array<{ content: string; revision: string }> = [];
    const controller = new AgentDocumentController(async (request) => {
      requests.push(request);
      return { revision: 'saved-r2' };
    });
    const document = controller.attach(
      'doc',
      '/vault',
      'a.md',
      EditorState.create({ doc: 'old' }),
      'r1',
    );
    controller.updateFromEditor('doc', EditorState.create({ doc: 'new' }));
    const closing = controller.close(document, () =>
      controller.flush(document),
    );
    assert.equal(await closing, true);
    assert.deepEqual(requests, [
      {
        vaultPath: '/vault',
        path: 'a.md',
        content: 'new',
        revision: 'r1',
      },
    ]);
    assert.equal(document.closed, true);
    assert.equal(document.dirty, false);
  });

  it('saves the latest in-flight editor update before close completes', async () => {
    const requests: string[] = [];
    let finishFirst!: (value: { revision: string }) => void;
    const controller = new AgentDocumentController(async (request) => {
      requests.push(request.content);
      if (requests.length === 1)
        return new Promise((resolve) => {
          finishFirst = resolve;
        });
      return { revision: 'r3' };
    });
    const document = controller.attach(
      'doc',
      '/vault',
      'a.md',
      EditorState.create({ doc: 'first' }),
      'r1',
    );
    controller.updateFromEditor(
      'doc',
      EditorState.create({ doc: 'first edit' }),
    );
    await Promise.resolve();
    controller.updateFromEditor('doc', EditorState.create({ doc: 'latest' }));
    const closing = controller.close(document, () =>
      controller.flush(document),
    );
    finishFirst({ revision: 'r2' });
    assert.equal(await closing, true);
    assert.deepEqual(requests, ['first edit', 'latest']);
  });

  it('leaves failed close recoverable and rejects appends during close', async () => {
    let calls = 0;
    const controller = new AgentDocumentController(async () => {
      calls++;
      if (calls === 1) throw new Error('save failed');
      return { revision: 'r2' };
    });
    const document = controller.attach(
      'doc',
      '/vault',
      'a.md',
      EditorState.create({ doc: 'old' }),
      'r1',
    );
    controller.updateFromEditor('doc', EditorState.create({ doc: 'new' }));
    await assert.rejects(
      controller.close(document, () => controller.flush(document)),
      /save failed/,
    );
    assert.equal(document.closed, false);
    assert.equal(document.dirty, true);
    assert.equal(document.conflict, true);
    assert.equal(
      await controller.append(document, 'late').catch(() => false),
      false,
    );
    document.conflict = false;
    document.saveError = undefined;
    assert.equal(await controller.flush(document), true);
    assert.equal(document.dirty, false);
  });

  it('cancels not-yet-accepted queued work at close and flushes', async () => {
    const controller = new AgentDocumentController();
    const document = controller.attach(
      'one',
      '/vault/one.md',
      EditorState.create({ doc: 'start' }),
    );
    const pending = controller.append(document, '\nqueued');
    const flushed: string[] = [];
    const closing = controller.close(document, async () => {
      flushed.push(document.state.doc.toString());
      return true;
    });
    await assert.rejects(pending, /closed before operation acceptance/);
    assert.equal(await closing, true);
    assert.deepEqual(flushed, ['start']);
    assert.equal(document.state.doc.toString(), 'start');
  });
});
