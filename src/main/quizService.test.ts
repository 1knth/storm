import { describe, it as test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuizService } from './quizService';
import { QuizStore } from './quizStore';
import { quizAgentSession } from '../shared/quizAgentContext';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'storm-quiz-'));
  const store = new QuizStore(join(dir, 'sessions.json'));
  const service = new QuizService(store, (scope) => scope.vaultId === 'vault');
  const created = await service.createSession({
    vaultId: 'vault',
    notePath: 'a.md',
    selectedNotePaths: [],
    folderPath: null,
  });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error('session create failed');
  const agentToken = created.value.agentToken;
  const request = (
    type: 'attach' | 'pose-question' | 'answer' | 'feedback' | 'continue',
    expectedRevision: number,
    idempotencyKey: string,
    extra = {},
  ) =>
    service.request({
      type,
      sessionId: created.value.id,
      agentToken,
      expectedRevision,
      idempotencyKey,
      ...extra,
    } as never);
  return { dir, store, service, session: created.value, agentToken, request };
}

describe('QuizService', () => {
  test('agent activity appears in public snapshots without advancing semantic revision or event cursor', async () => {
    const f = await fixture();
    try {
      const attached = await f.service.attachSession(f.session.id);
      assert.equal(attached.ok, true);
      if (!attached.ok) return;
      const revision = attached.value.snapshot.session.revision;
      const eventCursor = attached.value.snapshot.session.eventCursor;

      const thinking = await f.service.setAgentActivity(
        f.session.id,
        attached.value.agentToken,
        'thinking',
      );
      assert.equal(thinking.ok, true);
      const thinkingSnapshot = await f.service.getSnapshot(f.session.id);
      assert.equal(thinkingSnapshot?.session.activity?.state, 'thinking');
      assert.equal(thinkingSnapshot?.session.revision, revision);
      assert.equal(thinkingSnapshot?.session.eventCursor, eventCursor);
      assert.deepEqual(
        thinkingSnapshot?.events,
        attached.value.snapshot.events,
      );

      const drafting = await f.service.setAgentActivity(
        f.session.id,
        attached.value.agentToken,
        'drafting',
      );
      assert.equal(drafting.ok, true);
      assert.equal(
        (await f.service.getSnapshot(f.session.id))?.session.activity?.state,
        'drafting',
      );

      const idle = await f.service.setAgentActivity(
        f.session.id,
        attached.value.agentToken,
        'idle',
      );
      assert.equal(idle.ok, true);
      assert.equal(
        (await f.service.getSnapshot(f.session.id))?.session.activity?.state,
        'idle',
      );
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test('a posted agent response clears a stale drafting phase', async () => {
    const f = await fixture();
    try {
      const attached = await f.service.attachSession(f.session.id);
      assert.equal(attached.ok, true);
      if (!attached.ok) return;
      const message = await f.service.learnerRequest({
        type: 'message',
        sessionId: f.session.id,
        expectedRevision: attached.value.snapshot.session.revision,
        idempotencyKey: 'learner-question',
        text: 'Why OR?',
      });
      assert.equal(message.ok, true);
      if (!message.ok) return;
      await f.service.setAgentActivity(
        f.session.id,
        attached.value.agentToken,
        'drafting',
      );
      const response = await f.service.request({
        type: 'agent-message',
        sessionId: f.session.id,
        agentToken: attached.value.agentToken,
        expectedRevision: message.value.revision,
        idempotencyKey: 'agent-answer',
        text: 'Not both true means at least one is false.',
      });
      assert.equal(response.ok, true);
      assert.equal(
        (await f.service.getSnapshot(f.session.id))?.session.activity,
        undefined,
      );
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test('accepted learner messages wait for committed agent output, not activity idle', async () => {
    const f = await fixture();
    try {
      const attached = await f.service.attachSession(f.session.id);
      assert.equal(attached.ok, true);
      if (!attached.ok) return;
      const message = await f.service.learnerRequest({
        type: 'message',
        sessionId: f.session.id,
        expectedRevision: attached.value.snapshot.session.revision,
        idempotencyKey: 'learner-message',
        text: 'Please explain this.',
      });
      assert.equal(message.ok, true);
      if (!message.ok) return;
      assert.equal(message.value.awaitingAgent, true);
      assert.equal(message.value.revision, 2);
      const idle = await f.service.setAgentActivity(
        f.session.id,
        f.agentToken,
        'idle',
      );
      assert.equal(idle.ok, true);
      assert.equal(
        (await f.service.getSnapshot(f.session.id))?.session.awaitingAgent,
        true,
      );

      const response = await f.service.request({
        type: 'agent-message',
        sessionId: f.session.id,
        agentToken: f.agentToken,
        expectedRevision: message.value.revision,
        idempotencyKey: 'agent-reply',
        text: 'Here is an explanation.',
      });
      assert.equal(response.ok, true);
      if (response.ok) assert.equal(response.value.awaitingAgent, false);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test('prompt choices are private learner input with persisted drafts and explicit continuation', async () => {
    const f = await fixture();
    try {
      await f.service.attachSession(f.session.id);
      const posed = await f.request('pose-prompt' as never, 1, 'prompt', {
        kind: 'clarification',
        prompt: 'Which part?',
        choices: [
          { id: 'first', text: 'The first part' },
          { id: 'other', text: 'Something else' },
        ],
      });
      assert.equal(posed.ok, true);
      if (!posed.ok) return;
      const prompt = posed.value.currentPrompt!;
      assert.equal(prompt.choices.length, 2);
      assert.equal(posed.value.transcript[0]?.kind, undefined);
      const saved = await f.service.saveDraft(
        f.session.id,
        posed.value.revision,
        {
          questionId: null,
          selectedChoiceId: null,
          reasoningDraft: '',
          freeChatDraft: '',
          promptId: prompt.id,
          selectedPromptChoiceId: 'first',
          promptDetailDraft: 'Keep exact detail',
        },
      );
      assert.equal(saved.ok, true);
      if (!saved.ok) return;
      const restarted = new QuizService(
        new QuizStore(join(f.dir, 'sessions.json')),
        () => true,
      );
      const recovered = await restarted.getSnapshot(f.session.id);
      assert.equal(recovered?.session.currentPrompt?.selectedChoiceId, 'first');
      assert.equal(
        recovered?.session.currentPrompt?.detailDraft,
        'Keep exact detail',
      );
      const reattached = await restarted.attachSession(f.session.id);
      assert.equal(reattached.ok, true);
      const answer = await restarted.learnerRequest({
        type: 'respond-prompt',
        sessionId: f.session.id,
        expectedRevision: reattached.ok
          ? reattached.value.snapshot.session.revision
          : -1,
        idempotencyKey: 'respond',
        promptId: prompt.id,
        choiceId: 'first',
        detail: ' Keep exact detail ',
      });
      assert.equal(answer.ok, true);
      if (!answer.ok) return;
      assert.equal(
        answer.value.transcript.at(-1)?.text,
        'The first part\n Keep exact detail ',
      );
      assert.equal(answer.value.currentPrompt, null);
      assert.equal(
        (
          await restarted.learnerRequest({
            type: 'respond-prompt',
            sessionId: f.session.id,
            expectedRevision: answer.value.revision,
            idempotencyKey: 'unknown-choice',
            promptId: prompt.id,
            choiceId: 'invalid',
          })
        ).ok,
        false,
      );
      assert.equal(
        (
          await restarted.learnerRequest({
            type: 'continue',
            sessionId: f.session.id,
            expectedRevision: answer.value.revision,
            idempotencyKey: 'ordinary-continue',
          })
        ).ok,
        false,
      );
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
  test('keeps quiz image bytes transient while persisting only owned metadata references', async () => {
    const f = await fixture();
    try {
      await f.service.attachSession(f.session.id);
      const data = Uint8Array.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
      ]);
      const added = await f.service.addImage(f.session.id, {
        mimeType: 'image/png',
        data,
      });
      assert.equal(added.ok, true);
      if (!added.ok) return;
      assert.deepEqual(
        await f.service.learnerRequest({
          type: 'message',
          sessionId: f.session.id,
          expectedRevision: 1,
          idempotencyKey: 'image-message',
          text: '',
          attachments: [added.value.id],
        }),
        { ok: true, value: await f.store.get(f.session.id) },
      );
      const session = await f.store.get(f.session.id);
      assert.deepEqual(session?.transcript[0]?.attachments, [added.value]);
      assert.equal(session?.transcript[0]?.text, '');
      const stored = await readFile(join(f.dir, 'sessions.json'), 'utf8');
      assert.equal(
        stored.includes(Buffer.from(data).toString('base64')),
        false,
      );
      assert.equal(stored.includes('89504e470d0a1a0a'), false);
      const imagePath = (await f.service.getImage(f.session.id, added.value.id))
        ?.path;
      assert.ok(imagePath);
      assert.deepEqual(await readFile(imagePath), Buffer.from(data));
      assert.equal(
        (
          await f.service.learnerRequest({
            type: 'message',
            sessionId: f.session.id,
            expectedRevision: 2,
            idempotencyKey: 'removed-image',
            text: '',
            attachments: ['missing'],
          })
        ).ok,
        false,
      );
      await f.service.deleteSession(f.session.id);
      assert.equal(
        await f.service.getImage(f.session.id, added.value.id),
        null,
      );
      assert.equal(
        (
          await f.service.addImage(f.session.id, {
            mimeType: 'image/png',
            data,
          })
        ).ok,
        false,
      );
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test('rejects learner input while waiting for or disconnected from an agent', async () => {
    const f = await fixture();
    try {
      const actions = [
        { type: 'message' as const, text: 'hello' },
        { type: 'answer' as const, choiceId: 'a', reasoning: 'because' },
        { type: 'continue' as const },
      ];
      for (const state of ['waiting-agent', 'disconnected'] as const) {
        if (state === 'disconnected') {
          const attached = await f.service.attachSession(f.session.id);
          assert.equal(attached.ok, true);
          assert.equal((await f.service.stopAgent(f.session.id)).ok, true);
        }
        const before = await f.service.getSnapshot(f.session.id);
        assert.equal(before?.session.status, state);
        for (const [index, action] of actions.entries()) {
          assert.deepEqual(
            await f.service.learnerRequest({
              ...action,
              sessionId: f.session.id,
              expectedRevision: before!.session.revision,
              idempotencyKey: `${state}-${index}`,
            }),
            { ok: false, error: 'invalid-state' },
          );
        }
        const after = await f.service.getSnapshot(f.session.id);
        assert.equal(after?.session.revision, before?.session.revision);
        assert.equal(after?.session.eventCursor, before?.session.eventCursor);
        assert.deepEqual(after?.session.transcript, before?.session.transcript);
        assert.deepEqual(after?.events, before?.events);
      }
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test('deletion persists, revokes an attached capability, and is idempotent', async () => {
    const f = await fixture();
    try {
      const attached = await f.request('attach', 0, 'attach-before-delete');
      assert.equal(attached.ok, true);
      const ack = await f.service.deleteSession(f.session.id);
      assert.deepEqual(ack, { id: f.session.id, deleted: true });
      assert.deepEqual(await f.service.deleteSession(f.session.id), ack);
      const restarted = new QuizService(
        new QuizStore(join(f.dir, 'sessions.json')),
        () => true,
      );
      assert.deepEqual(await restarted.listSessions(), []);
      assert.equal(await restarted.getSnapshot(f.session.id), null);
      assert.deepEqual(
        await restarted.request({
          type: 'agent-message',
          sessionId: f.session.id,
          agentToken: f.agentToken,
          expectedRevision: 1,
          idempotencyKey: 'old-capability',
          text: 'late',
        }),
        { ok: false, error: 'not-found' },
      );
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test('rename persists to list and snapshots without changing session state', async () => {
    const f = await fixture();
    try {
      const before = await f.service.getSnapshot(f.session.id);
      const renamed = await f.service.renameSession(f.session.id, '  Review  ');
      assert.equal(renamed.ok, true);
      if (!renamed.ok) return;
      assert.equal(renamed.value.name, 'Review');
      assert.equal(renamed.value.revision, before?.session.revision);
      assert.equal(renamed.value.agentToken, f.session.agentToken);
      const restarted = new QuizService(
        new QuizStore(join(f.dir, 'sessions.json')),
        () => true,
      );
      assert.equal((await restarted.listSessions())[0].name, 'Review');
      assert.equal(
        (await restarted.getSnapshot(f.session.id))?.session.name,
        'Review',
      );
      assert.deepEqual(await f.service.renameSession(f.session.id, '   '), {
        ok: false,
        error: 'invalid-input',
      });
      assert.deepEqual(await f.service.renameSession('missing', 'Name'), {
        ok: false,
        error: 'not-found',
      });
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
  test('setScope attaches, replaces, and clears scope without changing session state', async () => {
    const f = await fixture();
    try {
      const attached = await f.service.attachSession(f.session.id);
      assert.equal(attached.ok, true);
      if (!attached.ok) return;
      const revision = attached.value.snapshot.session.revision;
      const folder = {
        vaultId: 'vault',
        notePath: null,
        folderPath: 'course/logic',
        selectedNotePaths: [],
      };
      const changed = await f.service.setScope(f.session.id, folder);
      assert.equal(changed.ok, true);
      if (!changed.ok) return;
      assert.deepEqual(changed.value.scope, folder);
      assert.equal(changed.value.revision, revision);
      assert.equal(changed.value.status, 'connected');

      // An in-flight agent write must not revert the learner's new scope.
      const message = await f.service.request({
        type: 'agent-message',
        sessionId: f.session.id,
        agentToken: attached.value.agentToken,
        expectedRevision: revision,
        idempotencyKey: 'after-scope',
        text: 'Hello.',
      } as never);
      assert.equal(message.ok, true);
      assert.deepEqual(
        (await f.service.getSnapshot(f.session.id))?.session.scope,
        folder,
      );

      assert.deepEqual(
        await f.service.setScope(f.session.id, { ...folder, vaultId: 'other' }),
        { ok: false, error: 'unauthorized' },
      );
      assert.deepEqual(
        await f.service.setScope(f.session.id, {
          ...folder,
          notePath: 'a.md',
        }),
        { ok: false, error: 'unauthorized' },
      );
      const cleared = await f.service.setScope(f.session.id, undefined);
      assert.equal(cleared.ok, true);
      assert.equal(
        (await f.service.getSnapshot(f.session.id))?.session.scope,
        undefined,
      );
      assert.deepEqual(await f.service.setScope('missing', undefined), {
        ok: false,
        error: 'not-found',
      });
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
  test('lesson-map updates are metadata-only and question focus follows concepts', async () => {
    const f = await fixture();
    try {
      const attached = await f.service.attachSession(f.session.id);
      assert.equal(attached.ok, true);
      if (!attached.ok) return;
      const token = attached.value.agentToken;
      const revision = attached.value.snapshot.session.revision;
      const mapRequest = (map: unknown, key: string) =>
        f.service.request({
          type: 'lesson-map',
          sessionId: f.session.id,
          agentToken: token,
          expectedRevision: revision,
          idempotencyKey: key,
          map,
        } as never);
      const created = await mapRequest(
        {
          nodes: [
            { id: 'identity-laws', label: 'Identity laws' },
            { id: 'constant-laws', label: 'Constant laws' },
          ],
          edges: [['identity-laws', 'constant-laws']],
        },
        'map-1',
      );
      assert.equal(created.ok, true);
      if (!created.ok) return;
      assert.equal(created.value.revision, revision);
      assert.equal(created.value.lessonMap?.nodes.length, 2);
      assert.deepEqual(await mapRequest({ focus: ['missing'] }, 'map-2'), {
        ok: false,
        error: 'invalid-input',
        message: 'Unknown node missing.',
      });

      const posed = await f.service.request({
        type: 'pose-question',
        sessionId: f.session.id,
        agentToken: token,
        expectedRevision: revision,
        idempotencyKey: 'q-1',
        question: 'Which law applies?',
        kind: 'short-answer',
        concepts: ['constant-laws'],
        level: 'apply',
      } as never);
      assert.equal(posed.ok, true);
      const snapshot = await f.service.getSnapshot(f.session.id);
      assert.deepEqual(snapshot?.session.lessonMap?.focus, ['constant-laws']);
      assert.equal(snapshot?.session.lessonMap?.nodes.length, 2);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
  test('tutor notes are metadata-only, versioned, and survive reattach', async () => {
    const f = await fixture();
    try {
      const attached = await f.service.attachSession(f.session.id);
      assert.equal(attached.ok, true);
      if (!attached.ok) return;
      const revision = attached.value.snapshot.session.revision;
      const notes = (agentToken: string, text: string, key: string) =>
        f.service.request({
          type: 'tutor-notes',
          sessionId: f.session.id,
          agentToken,
          expectedRevision: revision,
          idempotencyKey: key,
          text,
        });
      const token = attached.value.agentToken;
      const first = await notes(token, 'Plan: identity laws first.', 'n-1');
      assert.equal(first.ok, true);
      if (!first.ok) return;
      assert.equal(first.value.revision, revision);
      assert.equal(first.value.tutorNotes?.version, 1);
      const second = await notes(token, '  Next: constant laws.  ', 'n-2');
      assert.equal(second.ok && second.value.tutorNotes?.version, 2);
      assert.equal(
        second.ok && second.value.tutorNotes?.text,
        'Next: constant laws.',
      );
      assert.deepEqual(await notes(token, '   ', 'n-3'), {
        ok: false,
        error: 'invalid-input',
      });
      assert.deepEqual(await notes(token, 'x'.repeat(6001), 'n-4'), {
        ok: false,
        error: 'invalid-input',
      });

      await f.service.disconnectAgent(f.session.id, token);
      const reattached = await f.service.attachSession(f.session.id);
      assert.equal(reattached.ok, true);
      if (!reattached.ok) return;
      const session = reattached.value.snapshot.session;
      assert.equal(session.tutorNotes?.text, 'Next: constant laws.');
      assert.equal(
        quizAgentSession(session).tutorNotes?.text,
        'Next: constant laws.',
      );
      assert.deepEqual(await notes('wrong-token', 'forged', 'n-5'), {
        ok: false,
        error: 'unauthorized',
      });
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
  test('renaming alongside Stop preserves revocation for draft and saved sessions', async () => {
    for (const persisted of [false, true]) {
      for (const renameFirst of [false, true]) {
        const f = await fixture();
        try {
          const attached = await f.service.attachSession(f.session.id);
          assert.equal(attached.ok, true);
          if (!attached.ok) throw new Error('attach failed');
          await f.service.setAgentActivity(
            f.session.id,
            attached.value.agentToken,
            'thinking',
          );
          if (persisted) await f.store.promote(f.session.id);
          const rename = () => f.service.renameSession(f.session.id, 'Review');
          const stop = () => f.service.stopAgent(f.session.id);
          const actions = renameFirst ? [rename, stop] : [stop, rename];
          const results = await Promise.all(actions.map((action) => action()));
          assert.ok(results.every((result) => result.ok));
          const snapshot = await f.service.getSnapshot(f.session.id);
          assert.equal(snapshot?.session.name, 'Review');
          assert.equal(snapshot?.session.status, 'disconnected');
          assert.equal(snapshot?.session.activity, undefined);
          assert.notEqual(
            snapshot?.session.agentToken,
            attached.value.agentToken,
          );
          assert.equal(
            snapshot?.session.revision,
            attached.value.snapshot.session.revision + 1,
          );
          assert.equal(
            snapshot?.session.eventCursor,
            snapshot?.events.at(-1)?.cursor,
          );
          assert.deepEqual(
            await f.service.request({
              type: 'agent-message',
              sessionId: f.session.id,
              agentToken: attached.value.agentToken,
              expectedRevision: snapshot!.session.revision,
              idempotencyKey: 'revoked-after-rename',
              text: 'Must be rejected',
            }),
            { ok: false, error: 'unauthorized' },
          );
        } finally {
          await rm(f.dir, { recursive: true, force: true });
        }
      }
    }
  });

  test('pose-question validates and stores all supported question variants', async () => {
    const variants = [
      {
        kind: 'multiple-choice',
        question: 'Choose one',
        choices: [{ id: 'a', text: 'A' }],
      },
      {
        kind: 'matching',
        question: 'Match these',
        leftItems: [
          { id: 'l1', text: 'Left 1' },
          { id: 'l2', text: 'Left 2' },
        ],
        rightItems: [
          { id: 'r1', text: 'Right 1' },
          { id: 'r2', text: 'Right 2' },
        ],
      },
      { kind: 'short-answer', question: 'Briefly explain' },
      { kind: 'long-answer', question: 'Explain in detail' },
    ];
    for (const [index, variant] of variants.entries()) {
      const f = await fixture();
      try {
        await f.request('attach', 0, 'attach');
        const result = await f.request(
          'pose-question',
          1,
          `q-${index}`,
          variant,
        );
        assert.equal(result.ok, true);
        if (!result.ok) continue;
        const posed = result.value.transcript.at(-1)?.question;
        assert.equal(posed?.kind, variant.kind);
        assert.equal(posed?.prompt, variant.question);
        if (variant.kind === 'matching') {
          assert.deepEqual(posed?.leftItems, variant.leftItems);
          // Match options are presented in Storm's own order, never the
          // authored pair order, but every item survives exactly once.
          assert.deepEqual(
            [...(posed?.rightItems ?? [])].sort((a, b) =>
              a.id.localeCompare(b.id),
            ),
            variant.rightItems,
          );
          assert.ok(
            posed?.rightItems?.some(
              (item, index) => item.id !== variant.rightItems![index].id,
            ),
          );
        }
        assert.equal(
          result.value.transcript.filter((entry) => entry.kind === 'question')
            .length,
          1,
        );
      } finally {
        await rm(f.dir, { recursive: true, force: true });
      }
    }
  });

  test('pose-question rejects invalid variant payloads and preserves legacy normalization', async () => {
    const f = await fixture();
    try {
      await f.request('attach', 0, 'attach');
      const legacy = await f.request('pose-question', 1, 'legacy', {
        question: 'Legacy',
        choices: [
          { id: 'a', text: 'A' },
          { id: 'b', text: 'B' },
        ],
      });
      assert.equal(legacy.ok, true);
      if (!legacy.ok) return;
      assert.equal(
        legacy.value.transcript.at(-1)?.question?.kind,
        'multiple-choice',
      );
      const invalid = [
        { kind: 'multiple-choice', question: 'Q', choices: [] },
        {
          kind: 'multiple-choice',
          question: 'Q',
          choices: Array.from({ length: 7 }, (_, i) => ({
            id: String(i),
            text: 'x',
          })),
        },
        {
          kind: 'matching',
          question: 'Q',
          leftItems: [
            { id: 'x', text: 'X' },
            { id: 'x', text: 'Y' },
          ],
          rightItems: [
            { id: 'z', text: 'Z' },
            { id: 'w', text: 'W' },
          ],
        },
        {
          kind: 'matching',
          question: 'Q',
          leftItems: [
            { id: 'x', text: 'X' },
            { id: 'y', text: 'Y' },
          ],
          rightItems: [{ id: 'z', text: 'Z' }],
        },
        {
          kind: 'short-answer',
          question: 'Q',
          choices: [{ id: 'a', text: 'hidden answer' }],
        },
        { kind: 'long-answer', question: '   ' },
      ];
      assert.equal(invalid.length, 6);
      assert.equal(
        legacy.value.transcript.filter((entry) => entry.kind === 'question')
          .length,
        1,
      );
      const rejected = await f.service.createSession();
      assert.equal(rejected.ok, true);
      if (!rejected.ok) return;
      const invalidFixture = {
        ...f,
        session: rejected.value,
        request: (
          type: 'attach' | 'pose-question' | 'answer' | 'feedback' | 'continue',
          expectedRevision: number,
          key: string,
          extra = {},
        ) =>
          f.service.request({
            type,
            sessionId: rejected.value.id,
            agentToken: rejected.value.agentToken,
            expectedRevision,
            idempotencyKey: key,
            ...extra,
          } as never),
      };
      await invalidFixture.request('attach', 0, 'invalid-attach');
      for (const [index, payload] of invalid.entries())
        assert.deepEqual(
          await invalidFixture.request(
            'pose-question',
            1,
            `invalid-${index}`,
            payload,
          ),
          { ok: false, error: 'invalid-input' },
          `invalid payload index ${index}`,
        );
      const saved = await f.service.getSnapshot(rejected.value.id);
      assert.equal(saved?.session.transcript.length, 0);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test('agent-message is distinct, idempotent, and preserves learner question state', async () => {
    const f = await fixture();
    try {
      await f.request('attach', 0, 'attach');
      const before = await f.request('pose-question', 1, 'q', {
        question: 'Why?',
        choices: [
          { id: 'a', text: 'A' },
          { id: 'b', text: 'B' },
        ],
      });
      assert.equal(before.ok, true);
      if (!before.ok) return;
      const posedEntry = before.value.transcript.at(-1);
      // Display order is assigned when the question is posed; compare by ID.
      assert.deepEqual(
        {
          ...posedEntry?.question,
          choices: [...(posedEntry?.question?.choices ?? [])].sort((a, b) =>
            a.id.localeCompare(b.id),
          ),
        },
        {
          id: before.value.currentQuestion?.id,
          fingerprint: before.value.currentQuestion?.fingerprint,
          kind: 'multiple-choice',
          prompt: 'Why?',
          choices: [
            { id: 'a', text: 'A' },
            { id: 'b', text: 'B' },
          ],
        },
      );
      assert.deepEqual(
        posedEntry?.question?.choices,
        before.value.currentQuestion?.choices,
      );
      assert.equal(posedEntry?.kind, 'question');
      assert.equal(posedEntry?.role, 'agent');
      assert.equal(posedEntry?.text, 'Why?');
      assert.equal(JSON.stringify(posedEntry).includes(f.agentToken), false);
      const input = {
        type: 'agent-message' as const,
        sessionId: f.session.id,
        agentToken: f.agentToken,
        expectedRevision: 2,
        idempotencyKey: 'chat-1',
        text: 'Hello, learner.',
      };
      const sent = await f.service.request(input);
      const retried = await f.service.request(input);
      assert.equal(sent.ok, true);
      assert.equal(retried.ok, true);
      const snapshot = await f.service.getSnapshot(f.session.id);
      assert.equal(snapshot?.session.revision, 3);
      assert.equal(
        snapshot?.session.transcript.filter(
          (message) => message.kind === 'question',
        ).length,
        1,
      );
      assert.equal(snapshot?.session.transcript.at(-1)?.role, 'agent');
      assert.equal(snapshot?.session.transcript.at(-1)?.text, input.text);
      assert.equal(
        snapshot?.session.currentQuestion?.id,
        before.value.currentQuestion?.id,
      );
      assert.equal(snapshot?.session.currentQuestion?.selectedChoiceId, null);
      assert.equal(snapshot?.session.currentQuestion?.reasoningDraft, '');
      assert.equal(
        snapshot?.events.filter((event) => event.type === 'agent-message')
          .length,
        1,
      );
      assert.deepEqual(
        await f.service.request({
          type: 'message',
          sessionId: f.session.id,
          agentToken: f.agentToken,
          expectedRevision: 3,
          idempotencyKey: 'wrong-kind',
          text: 'not agent-message',
        } as never),
        { ok: false, error: 'invalid-input' },
      );
      assert.deepEqual(
        await f.service.learnerRequest({
          type: 'agent-message',
          sessionId: f.session.id,
          expectedRevision: 3,
          idempotencyKey: 'learner-forgery',
          text: 'forged',
        } as never),
        { ok: false, error: 'invalid-input' },
      );
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test('same-key retry after later revisions acknowledges without replaying; changed payload is rejected', async () => {
    const f = await fixture();
    try {
      await f.request('attach', 0, 'attach');
      const original = {
        type: 'agent-message' as const,
        sessionId: f.session.id,
        agentToken: f.agentToken,
        expectedRevision: 1,
        idempotencyKey: 'once',
        text: 'Original action',
      };
      const first = await f.service.request(original);
      assert.equal(first.ok, true);
      const later = await f.service.request({
        ...original,
        expectedRevision: 2,
        idempotencyKey: 'later',
        text: 'Later action',
      });
      assert.equal(later.ok, true);
      const retry = await f.service.request(original);
      assert.equal(retry.ok, true);
      if (!retry.ok) return;
      assert.equal(retry.value.revision, 3);
      const changed = await f.service.request({ ...original, text: 'Changed' });
      assert.deepEqual(changed, { ok: false, error: 'invalid-input' });
      const snapshot = await f.service.getSnapshot(f.session.id);
      assert.equal(snapshot?.events.length, 3);
      assert.deepEqual(
        snapshot?.session.transcript.map((message) => message.text),
        ['Original action', 'Later action'],
      );
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test('persists answer, reasoning and feedback; continuation is explicit and retry is idempotent', async () => {
    const f = await fixture();
    try {
      assert.equal((await f.request('attach', 0, 'attach')).ok, true);
      assert.equal(
        (
          await f.request('pose-question', 1, 'q', {
            question: 'Why?',
            choices: [
              { id: 'a', text: 'A' },
              { id: 'b', text: 'B' },
            ],
          })
        ).ok,
        true,
      );
      assert.equal(
        (
          await f.service.learnerRequest({
            type: 'answer',
            sessionId: f.session.id,
            expectedRevision: 2,
            idempotencyKey: 'answer',
            choiceId: 'b',
            reasoning: 'Because',
          })
        ).ok,
        true,
      );
      const restarted = f.service;
      const snap = await restarted.getSnapshot(f.session.id);
      assert.equal(snap?.session.scope?.notePath, 'a.md');
      assert.equal(snap?.session.currentQuestion?.reasoningDraft, 'Because');
      assert.equal(snap?.session.currentQuestion?.selectedChoiceId, 'b');
      assert.equal(
        snap?.session.transcript.at(-1)?.text,
        'B\nReasoning: Because',
      );
      const feedback = {
        type: 'feedback' as const,
        sessionId: f.session.id,
        agentToken: f.agentToken,
        expectedRevision: 3,
        idempotencyKey: 'feedback',
        text: 'Correct',
      };
      assert.equal((await restarted.request(feedback)).ok, true);
      assert.equal((await restarted.request(feedback)).ok, true);
      assert.equal(
        (await restarted.getSnapshot(f.session.id))?.session.revision,
        4,
      );
      assert.equal(
        (
          await restarted.learnerRequest({
            type: 'continue',
            sessionId: f.session.id,
            expectedRevision: 4,
            idempotencyKey: 'continue',
          })
        ).ok,
        true,
      );
      const completed = await restarted.getSnapshot(f.session.id);
      assert.equal(completed?.session.currentQuestion, null);
      assert.deepEqual(
        completed?.session.transcript
          .filter((message) => message.kind === 'question')
          .map((message) => message.question?.prompt),
        ['Why?'],
      );
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test('enforces agent capability, revisions, pending question lifecycle, reconnect and startup disconnect', async () => {
    const f = await fixture();
    try {
      const wrong = await f.service.request({
        type: 'attach',
        sessionId: f.session.id,
        agentToken: 'wrong',
        expectedRevision: 0,
        idempotencyKey: 'wrong',
      });
      assert.deepEqual(wrong, { ok: false, error: 'unauthorized' });
      assert.equal(
        (
          await f.service.createSession({
            vaultId: 'other',
            notePath: null,
            selectedNotePaths: [],
            folderPath: null,
          })
        ).ok,
        false,
      );
      for (const scope of [
        {
          vaultId: 'vault',
          notePath: 'a.md',
          selectedNotePaths: ['b.md'],
          folderPath: null,
        },
        {
          vaultId: 'vault',
          notePath: 'a.md',
          selectedNotePaths: [],
          folderPath: 'folder',
        },
        {
          vaultId: 'vault',
          notePath: null,
          selectedNotePaths: [],
          folderPath: '',
        },
      ])
        assert.equal((await f.service.createSession(scope)).ok, false);
      assert.equal(
        (
          await f.service.createSession({
            vaultId: 'vault',
            notePath: null,
            selectedNotePaths: [],
            folderPath: null,
          })
        ).ok,
        true,
      );
      assert.equal(
        (
          await f.service.createSession({
            vaultId: 'vault',
            notePath: null,
            selectedNotePaths: ['a.md', 'b.md'],
            folderPath: null,
          })
        ).ok,
        true,
      );
      assert.equal((await f.request('attach', 0, 'a')).ok, true);
      const question = {
        question: 'Q',
        choices: [
          { id: 'a', text: 'A' },
          { id: 'b', text: 'B' },
        ],
      };
      assert.equal(
        (await f.request('pose-question', 1, 'q', question)).ok,
        true,
      );
      assert.equal(
        (await f.request('pose-question', 2, 'q2', question)).ok,
        false,
      );
      assert.equal(
        (await f.service.disconnectAgent(f.session.id, f.agentToken)).ok,
        true,
      );
      const reconnected = await f.request('attach', 3, 'reconnect');
      assert.equal(reconnected.ok, true);
      assert.equal(
        (
          await f.service.learnerRequest({
            type: 'answer',
            sessionId: f.session.id,
            expectedRevision: 4,
            idempotencyKey: 'restart-answer',
            choiceId: 'a',
            reasoning: 'preserve this draft',
          })
        ).ok,
        true,
      );
      const restarted = new QuizService(
        new QuizStore(join(f.dir, 'sessions.json')),
        () => true,
      );
      const sessions = await restarted.listSessions();
      assert.equal(sessions[0].status, 'disconnected');
      assert.equal(sessions[0].currentQuestion?.status, 'answered');
      assert.equal(
        sessions[0].currentQuestion?.reasoningDraft,
        'preserve this draft',
      );
      assert.equal(sessions[0].transcript.length, 2);
      const recoveredRevision = sessions[0].revision;
      const handoff = await restarted.attachSession(f.session.id);
      assert.equal(handoff.ok, true);
      if (!handoff.ok) return;
      const attachedRevision = handoff.value.snapshot.session.revision;
      const attachedToken = handoff.value.agentToken;
      for (let i = 0; i < 3; i++) {
        const listed = (await restarted.listSessions())[0];
        const snapshot = await restarted.getSnapshot(f.session.id);
        assert.equal(listed.status, 'connected');
        assert.equal(listed.revision, attachedRevision);
        assert.equal(snapshot?.session.status, 'connected');
        assert.equal(snapshot?.session.revision, attachedRevision);
        assert.equal(attachedToken, f.agentToken);
      }
      assert.equal(attachedRevision, recoveredRevision + 1);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test('user stop revokes capability, preserves learner state, and permits fresh attach', async () => {
    const f = await fixture();
    try {
      const attached = await f.service.attachSession(f.session.id);
      assert.equal(attached.ok, true);
      if (!attached.ok) return;
      const token = attached.value.agentToken;
      const question = await f.service.request({
        type: 'pose-question',
        sessionId: f.session.id,
        agentToken: token,
        expectedRevision: 1,
        idempotencyKey: 'question',
        question: 'Keep me?',
        choices: [
          { id: 'a', text: 'A' },
          { id: 'b', text: 'B' },
        ],
      });
      assert.equal(question.ok, true);
      const draft = await f.service.saveDraft(f.session.id, 2, {
        questionId: question.ok
          ? (question.value.currentQuestion?.id ?? null)
          : null,
        selectedChoiceId: 'b',
        reasoningDraft: 'draft',
        freeChatDraft: 'chat draft',
      });
      assert.equal(draft.ok, true);
      if (draft.ok) {
        assert.equal(
          draft.value.revision,
          question.ok ? question.value.revision : -1,
        );
        assert.equal(
          draft.value.eventCursor,
          question.ok ? question.value.eventCursor : -1,
        );
      }
      const stopped = await f.service.stopAgent(f.session.id);
      assert.equal(stopped.ok, true);
      if (!stopped.ok) return;
      assert.equal(stopped.value.status, 'disconnected');
      assert.equal(stopped.value.revision, 3);
      assert.equal(stopped.value.transcript.length, 1);
      assert.equal(stopped.value.currentQuestion?.selectedChoiceId, 'b');
      assert.equal(stopped.value.currentQuestion?.reasoningDraft, 'draft');
      assert.equal(stopped.value.freeChatDraft, 'chat draft');
      assert.deepEqual(await f.service.stopAgent(f.session.id), {
        ok: true,
        value: stopped.value,
      });
      assert.deepEqual(
        await f.service.request({
          type: 'agent-message',
          sessionId: f.session.id,
          agentToken: token,
          expectedRevision: 3,
          idempotencyKey: 'after-stop',
          text: 'stale',
        }),
        { ok: false, error: 'unauthorized' },
      );
      const handoff = await f.service.attachSession(f.session.id);
      assert.equal(handoff.ok, true);
      if (!handoff.ok) return;
      assert.notEqual(handoff.value.agentToken, token);
      assert.equal(handoff.value.snapshot.session.revision, 4);
      assert.equal(
        handoff.value.snapshot.session.currentQuestion?.id,
        stopped.value.currentQuestion?.id,
      );
      const oldRequest = await f.service.request({
        type: 'agent-message',
        sessionId: f.session.id,
        agentToken: token,
        expectedRevision: 4,
        idempotencyKey: 'old-after-attach',
        text: 'stale',
      });
      assert.deepEqual(oldRequest, { ok: false, error: 'unauthorized' });
      const newRequest = await f.service.request({
        type: 'agent-message',
        sessionId: f.session.id,
        agentToken: handoff.value.agentToken,
        expectedRevision: 4,
        idempotencyKey: 'fresh',
        text: 'fresh agent',
      });
      assert.equal(newRequest.ok, true);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test('concurrent handoffs allow exactly one caller to attach', async () => {
    const f = await fixture();
    try {
      const results = await Promise.all([
        f.service.attachSession(f.session.id),
        f.service.attachSession(f.session.id),
      ]);
      assert.equal(results.filter((result) => result.ok).length, 1);
      assert.equal(results.filter((result) => !result.ok).length, 1);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test('authenticated handoff grants capability only for waiting/disconnected sessions', async () => {
    const f = await fixture();
    try {
      const handoff = await f.service.attachSession(f.session.id);
      assert.equal(handoff.ok, true);
      if (!handoff.ok) return;
      assert.equal(handoff.value.agentToken, f.agentToken);
      assert.equal(handoff.value.snapshot.session.status, 'connected');
      assert.equal((await f.service.attachSession(f.session.id)).ok, false);
      assert.equal(
        (
          await f.service.request({
            type: 'pose-question',
            sessionId: f.session.id,
            agentToken: handoff.value.agentToken,
            expectedRevision: handoff.value.snapshot.session.revision,
            idempotencyKey: 'q',
            question: 'Q',
            choices: [
              { id: 'a', text: 'A' },
              { id: 'b', text: 'B' },
            ],
          })
        ).ok,
        true,
      );
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test('trusted learner requests work without agent capability while agent requests still require it', async () => {
    const f = await fixture();
    try {
      await f.request('attach', 0, 'attach');
      await f.request('pose-question', 1, 'question', {
        question: 'Q',
        choices: [
          { id: 'a', text: 'A' },
          { id: 'b', text: 'B' },
        ],
      });
      const learnerRequest = {
        type: 'answer' as const,
        sessionId: f.session.id,
        expectedRevision: 2,
        idempotencyKey: 'learner-answer',
        choiceId: 'a',
        reasoning: 'Reason',
      };
      assert.equal((await f.service.learnerRequest(learnerRequest)).ok, true);
      assert.deepEqual(
        await f.service.request({
          ...learnerRequest,
          agentToken: f.agentToken,
        }),
        { ok: false, error: 'invalid-input' },
      );
      for (const request of [
        {
          type: 'answer' as const,
          sessionId: f.session.id,
          agentToken: f.agentToken,
          expectedRevision: 2,
          idempotencyKey: 'agent-answer',
          choiceId: 'a',
          reasoning: 'x',
        },
        {
          type: 'continue' as const,
          sessionId: f.session.id,
          agentToken: f.agentToken,
          expectedRevision: 2,
          idempotencyKey: 'agent-continue',
        },
        {
          type: 'message' as const,
          sessionId: f.session.id,
          agentToken: f.agentToken,
          expectedRevision: 2,
          idempotencyKey: 'agent-message',
          text: 'x',
        },
      ])
        assert.deepEqual(await f.service.request(request), {
          ok: false,
          error: 'invalid-input',
        });
      const snapshot = await f.service.getSnapshot(f.session.id);
      assert.equal(snapshot?.session.currentQuestion?.selectedChoiceId, 'a');
      assert.equal(snapshot?.session.transcript.at(-1)?.role, 'learner');
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test('concurrent same-revision learner updates conflict atomically and idempotent retry replays', async () => {
    const f = await fixture();
    try {
      await f.request('attach', 0, 'attach');
      await f.request('pose-question', 1, 'question', {
        question: 'Q',
        choices: [
          { id: 'a', text: 'A' },
          { id: 'b', text: 'B' },
        ],
      });
      const baseRevision = 2;
      const requests = [
        {
          type: 'answer' as const,
          sessionId: f.session.id,
          expectedRevision: baseRevision,
          idempotencyKey: 'same-revision',
          choiceId: 'a',
          reasoning: 'reason',
        },
        {
          type: 'answer' as const,
          sessionId: f.session.id,
          expectedRevision: baseRevision,
          idempotencyKey: 'other',
          choiceId: 'b',
          reasoning: 'other reason',
        },
      ];
      assert.notEqual(requests[0].idempotencyKey, requests[1].idempotencyKey);
      assert.equal(requests[0].expectedRevision, requests[1].expectedRevision);
      const results = await Promise.all(
        requests.map((request) => f.service.learnerRequest(request)),
      );
      const winnerIndex = results.findIndex((result) => result.ok);
      const loserIndex = winnerIndex === 0 ? 1 : 0;
      assert.notEqual(winnerIndex, -1);
      assert.equal(
        results[loserIndex].ok ||
          results[loserIndex].error !== 'stale-revision',
        false,
      );
      const winnerRequest = requests[winnerIndex];
      const winnerResult = results[winnerIndex];
      assert.equal(winnerResult.ok, true);
      if (!winnerResult.ok) return;
      const retry = await f.service.learnerRequest(winnerRequest);
      assert.deepEqual(retry, winnerResult);
      const changedPayload = await f.service.learnerRequest({
        ...winnerRequest,
        reasoning: 'changed reason',
      });
      assert.deepEqual(changedPayload, { ok: false, error: 'invalid-input' });
      const snapshot = await f.service.getSnapshot(f.session.id);
      assert.equal(snapshot?.session.revision, 3);
      assert.equal(snapshot?.events.length, 3);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test('unscoped drafts remain memory-only until learner activity, then recover persisted draft fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'storm-quiz-lazy-'));
    const path = join(dir, 'sessions.json');
    try {
      const store = new QuizStore(path);
      const service = new QuizService(store, () => {
        throw new Error(
          'unscoped sessions must not request scope authorization',
        );
      });
      const created = await service.createSession();
      assert.equal(created.ok, true);
      if (!created.ok) return;
      assert.equal(created.value.scope, undefined);
      assert.equal((await store.get(created.value.id)) !== undefined, true);
      assert.deepEqual(await service.listSessions(), []);
      assert.deepEqual(
        (await service.listSessions({ includeDrafts: true })).map(
          ({ id }) => id,
        ),
        [created.value.id],
      );
      await assert.rejects(stat(path), { code: 'ENOENT' });

      const attached = await service.attachSession(created.value.id);
      assert.equal(attached.ok, true);
      assert.equal(
        (
          await service.setAgentActivity(
            created.value.id,
            created.value.agentToken,
            'thinking',
          )
        ).ok,
        true,
      );
      assert.deepEqual(await service.listSessions(), []);
      await assert.rejects(stat(path), { code: 'ENOENT' });
      const draft = await service.saveDraft(created.value.id, 1, {
        questionId: null,
        selectedChoiceId: null,
        reasoningDraft: '',
        freeChatDraft: 'unsaved until transcript activity',
      });
      assert.equal(draft.ok, true);

      // A process restart discards the intentionally ephemeral draft.
      const restartedBeforeActivity = new QuizService(
        new QuizStore(path),
        () => true,
      );
      assert.deepEqual(await restartedBeforeActivity.listSessions(), []);
      assert.deepEqual(
        await restartedBeforeActivity.listSessions({ includeDrafts: true }),
        [],
      );

      // First learner transcript entry promotes the session and all current state.
      const message = await service.learnerRequest({
        type: 'message',
        sessionId: created.value.id,
        expectedRevision: 1,
        idempotencyKey: 'first-learner-message',
        text: 'Start our review',
      });
      assert.equal(message.ok, true);
      const recovered = new QuizService(new QuizStore(path), () => true);
      const listed = await recovered.listSessions();
      assert.equal(listed.length, 1);
      assert.equal(listed[0].scope, undefined);
      assert.equal(
        listed[0].freeChatDraft,
        'unsaved until transcript activity',
      );
      assert.equal(listed[0].transcript[0]?.text, 'Start our review');
      assert.equal(
        (await recovered.getSnapshot(created.value.id))?.session.id,
        created.value.id,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('first agent question promotes; invalid operations, stop, and disconnect do not promote a draft', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'storm-quiz-lazy-'));
    const path = join(dir, 'sessions.json');
    try {
      const service = new QuizService(new QuizStore(path), () => true);
      const created = await service.createSession();
      assert.equal(created.ok, true);
      if (!created.ok) return;
      assert.deepEqual(
        await service.request({
          type: 'agent-message',
          sessionId: created.value.id,
          agentToken: created.value.agentToken,
          expectedRevision: 0,
          idempotencyKey: 'invalid-before-attach',
          text: 'not allowed',
        }),
        { ok: false, error: 'invalid-state' },
      );
      assert.deepEqual(await service.listSessions(), []);
      await assert.rejects(stat(path), { code: 'ENOENT' });

      const attached = await service.attachSession(created.value.id);
      assert.equal(attached.ok, true);
      assert.equal((await service.stopAgent(created.value.id)).ok, true);
      assert.deepEqual(await service.listSessions(), []);
      await assert.rejects(stat(path), { code: 'ENOENT' });
      const reattached = await service.attachSession(created.value.id);
      assert.equal(reattached.ok, true);
      assert.equal(
        (
          await service.disconnectAgent(
            created.value.id,
            reattached.ok ? reattached.value.agentToken : '',
          )
        ).ok,
        true,
      );
      await assert.rejects(stat(path), { code: 'ENOENT' });

      const active = await service.attachSession(created.value.id);
      assert.equal(active.ok, true);
      const questionRequest = {
        type: 'pose-question' as const,
        sessionId: created.value.id,
        agentToken: active.ok ? active.value.agentToken : '',
        expectedRevision: active.ok
          ? active.value.snapshot.session.revision
          : -1,
        idempotencyKey: 'first-question',
        question: 'Why?',
        choices: [
          { id: 'a', text: 'A' },
          { id: 'b', text: 'B' },
        ],
      };
      const results = await Promise.all([
        service.request(questionRequest),
        service.request(questionRequest),
      ]);
      assert.equal(
        results.every((result) => result.ok),
        true,
      );
      const recovered = new QuizService(new QuizStore(path), () => true);
      const snapshot = await recovered.getSnapshot(created.value.id);
      assert.equal((await recovered.listSessions()).length, 1);
      assert.equal(snapshot?.session.transcript.length, 1);
      assert.equal(
        snapshot?.events.filter((event) => event.type === 'pose-question')
          .length,
        1,
      );
      assert.equal(snapshot?.session.transcript[0]?.kind, 'question');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('posed choice order is fixed once and survives answering, feedback and reattachment', async () => {
    const f = await fixture();
    try {
      await f.request('attach', 0, 'attach');
      const authored = [
        { id: 'a', text: 'Because the guard runs first' },
        { id: 'b', text: 'Because the counter resets' },
        { id: 'c', text: 'Because the list is copied' },
        { id: 'd', text: 'Because the index is cached' },
      ];
      const posed = await f.request('pose-question', 1, 'q', {
        kind: 'multiple-choice',
        question: 'Why does the loop end?',
        choices: authored,
      });
      assert.equal(posed.ok, true);
      if (!posed.ok) return;
      const order = posed.value.currentQuestion!.choices.map(
        (choice) => choice.id,
      );
      assert.deepEqual([...order].sort(), ['a', 'b', 'c', 'd']);
      for (const choice of authored)
        assert.deepEqual(
          posed.value.currentQuestion!.choices.find(
            (stored) => stored.id === choice.id,
          ),
          choice,
        );
      assert.deepEqual(
        posed.value.transcript
          .at(-1)
          ?.question?.choices.map((choice) => choice.id),
        order,
      );

      const answered = await f.service.learnerRequest({
        type: 'answer',
        sessionId: f.session.id,
        expectedRevision: 2,
        idempotencyKey: 'answer-1',
        choiceId: 'c',
        reasoning: 'the copy is independent',
        confidence: 60,
      });
      assert.equal(answered.ok, true);
      if (!answered.ok) return;
      assert.equal(answered.value.currentQuestion?.selectedChoiceId, 'c');
      assert.equal(
        answered.value.transcript
          .at(-1)
          ?.text.startsWith('Because the list is copied'),
        true,
      );
      assert.deepEqual(
        answered.value.currentQuestion!.choices.map((choice) => choice.id),
        order,
      );

      const feedback = await f.request('feedback', 3, 'f', {
        text: 'A copy leaves the original untouched.',
        verdict: 'correct',
      });
      assert.equal(feedback.ok, true);
      if (!feedback.ok) return;
      assert.equal(
        feedback.value.transcript.at(-1)?.question?.answerLabel,
        'Because the list is copied',
      );
      assert.deepEqual(
        feedback.value.transcript
          .at(-1)
          ?.question?.choices.map((choice) => choice.id),
        order,
      );

      const restarted = new QuizService(
        new QuizStore(join(f.dir, 'sessions.json')),
        () => true,
      );
      const reattached = await restarted.attachSession(f.session.id);
      assert.equal(reattached.ok, true);
      if (!reattached.ok) return;
      assert.deepEqual(
        reattached.value.snapshot.session.currentQuestion?.choices.map(
          (choice) => choice.id,
        ),
        order,
      );
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test('corrupt stores fail closed without overwriting data', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'storm-quiz-corrupt-'));
    const path = join(dir, 'sessions.json');
    try {
      await writeFile(path, '{broken', 'utf8');
      const store = new QuizStore(path);
      await assert.rejects(store.list());
      await assert.rejects(store.create({} as never));
      assert.equal(await readFile(path, 'utf8'), '{broken');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
