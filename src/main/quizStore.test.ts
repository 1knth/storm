import { describe, it as test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QuizSession } from '../shared/quizProtocol';
import { QuizStore } from './quizStore';

const session = (): QuizSession => ({
  id: 'session-1',
  agentToken: 'secret',
  revision: 0,
  eventCursor: 0,
  scope: {
    vaultId: 'test',
    notePath: null,
    selectedNotePaths: [],
    folderPath: null,
  },
  status: 'connected',
  transcript: [],
  currentQuestion: null,
  freeChatDraft: '',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
});
const event = (revision: number) => ({
  cursor: revision,
  revision,
  type: 'agent-message',
  data: { text: `message-${revision}` },
  createdAt: '2025-01-01T00:00:00.000Z',
});

async function withStore(
  run: (dir: string, store: QuizStore) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), 'storm-quiz-store-'));
  try {
    await run(dir, new QuizStore(join(dir, 'sessions.json')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('QuizStore storage regressions', () => {
  test('draft and activity commits reuse history and leave other sessions untouched', async () => {
    await withStore(async (dir, store) => {
      const first = session();
      await store.create(first);
      await store.create({ ...session(), id: 'other' });
      const path = join(dir, 'sessions.json');
      const before = JSON.parse(await readFile(path, 'utf8'));
      await store.updateDraft(
        { ...first, freeChatDraft: 'private response' },
        0,
      );
      await store.updateActivity(first.id, first.agentToken!, {
        state: 'thinking',
        updatedAt: first.updatedAt,
      });
      const after = JSON.parse(await readFile(path, 'utf8'));
      assert.equal(
        after.sessions[first.id].history,
        before.sessions[first.id].history,
      );
      assert.deepEqual(after.sessions.other, before.sessions.other);
      const history = await readFile(
        join(`${path}.sessions`, after.sessions[first.id].history),
        'utf8',
      );
      assert.equal(history.includes('private response'), false);
      const reopened = await new QuizStore(path).get(first.id);
      assert.equal(reopened?.freeChatDraft, 'private response');
      assert.deepEqual(
        reopened?.activity,
        (await store.get(first.id))?.activity,
      );
    });
  });

  test('picker summaries omit capabilities, history and drafts and isolate nested metadata', async () => {
    await withStore(async (_dir, store) => {
      const saved = session();
      saved.transcript = [
        {
          id: 'm',
          role: 'agent',
          text: 'private history'.repeat(10000),
          createdAt: saved.createdAt,
        },
      ];
      saved.freeChatDraft = 'private draft';
      await store.createDraft(saved);
      assert.deepEqual(await store.listSummaries(), []);
      await store.promote(saved.id);
      const [summary] = await store.listSummaries();
      assert.equal(summary.id, saved.id);
      assert.ok(JSON.stringify(summary).length < 500);
      for (const field of [
        'agentToken',
        'transcript',
        'freeChatDraft',
        'currentQuestion',
        'currentPrompt',
      ])
        assert.equal(field in summary, false);
      summary.scope!.selectedNotePaths.push('mutated.md');
      assert.deepEqual(
        (await store.get(saved.id))!.scope!.selectedNotePaths,
        [],
      );
      assert.equal(
        (await store.get(saved.id))!.transcript[0].text,
        saved.transcript[0].text,
      );
    });
  });
  test('drafts stay in memory until promotion, then persist session, events, and receipts', async () => {
    await withStore(async (dir, store) => {
      const draft = session();
      const path = join(dir, 'sessions.json');
      await store.createDraft(draft);
      assert.equal(await store.get(draft.id), draft);
      assert.deepEqual(await store.list(), []);
      assert.deepEqual(
        (await store.list({ includeDrafts: true })).map(({ id }) => id),
        [draft.id],
      );
      const revised = { ...draft, revision: 1, eventCursor: 1 };
      await store.update(revised, 0, event(1), 'draft-receipt', 'draft-fp');
      assert.deepEqual(await store.events(draft.id), [event(1)]);
      await assert.rejects(stat(path), { code: 'ENOENT' });
      await store.promote(draft.id);
      const saved = await persistedDatabase(path);
      assert.deepEqual(saved.sessions, [revised]);
      assert.deepEqual(saved.events[draft.id], [event(1)]);
      assert.deepEqual(saved.idempotency['draft-receipt'], {
        fingerprint: 'draft-fp',
        sessionId: draft.id,
        revision: 1,
      });
      const reopened = new QuizStore(path);
      assert.deepEqual(await reopened.get(draft.id), revised);
      assert.deepEqual(await reopened.events(draft.id), [event(1)]);
      assert.equal(
        (await reopened.idempotent('draft-receipt', 'draft-fp'))?.id,
        draft.id,
      );
    });
  });

  test('deleting an unsaved draft does not create a store file', async () => {
    await withStore(async (dir, store) => {
      const path = join(dir, 'sessions.json');
      await store.createDraft(session());
      await store.deleteSession('session-1');
      assert.equal(await store.get('session-1'), undefined);
      await assert.rejects(stat(path), { code: 'ENOENT' });
    });
  });
  test('serialized saved-file growth stays approximately linear through 50/100 messages', async () => {
    await withStore(async (dir, store) => {
      let current = session();
      await store.create(current);
      const sizes: number[] = [];
      for (const count of [50, 100]) {
        while (current.transcript.length < count) {
          const revision = current.revision + 1;
          current = {
            ...current,
            revision,
            eventCursor: revision,
            transcript: [
              ...current.transcript,
              {
                id: `m${revision}`,
                role: 'agent',
                text: `message ${revision} `.repeat(20),
                createdAt: current.createdAt,
              },
            ],
          };
          await store.update(
            current,
            revision - 1,
            event(revision),
            `key-${revision}`,
            `fingerprint-${revision}`,
          );
        }
        const path = join(dir, 'sessions.json');
        const manifest = JSON.parse(await readFile(path, 'utf8'));
        const files = manifest.sessions[current.id];
        sizes.push((await stat(join(`${path}.sessions`, files.history))).size);
      }
      // Doubling accumulated messages may add fixed metadata, but must not approach quadratic growth.
      assert.ok(
        sizes[1] / sizes[0] < 3,
        `100/50 size ratio was ${sizes[1] / sizes[0]}`,
      );
      const saved = await persistedDatabase(join(dir, 'sessions.json'));
      assert.equal(saved.idempotency['key-100'].session, undefined);
      assert.equal(saved.idempotency['key-100'].transcript, undefined);
      assert.equal(saved.sessions[0].transcript.length, 100);
    });
  });

  test('deletes only one session and purges its events and receipts from persisted store', async () => {
    await withStore(async (dir, store) => {
      const sourceNote = join(dir, 'source.md');
      await writeFile(sourceNote, 'Keep this vault note.');
      const first = session();
      const second = {
        ...session(),
        id: 'session-2',
        agentToken: 'other-secret',
      };
      await store.create(first);
      await store.create(second);
      await store.update(
        { ...first, revision: 1, eventCursor: 1 },
        0,
        event(1),
        'session-1:key',
        'fp',
      );
      await store.update(
        { ...second, revision: 1, eventCursor: 1 },
        0,
        event(1),
        'session-2:key',
        'fp2',
      );
      await store.deleteSession(first.id);
      const reopened = new QuizStore(join(dir, 'sessions.json'));
      assert.deepEqual(
        (await reopened.list()).map(({ id }) => id),
        ['session-2'],
      );
      assert.deepEqual(await reopened.events(first.id), []);
      assert.equal(await reopened.idempotent('session-1:key', 'fp'), undefined);
      assert.equal(
        (await reopened.idempotent('session-2:key', 'fp2'))?.id,
        'session-2',
      );
      const saved = await persistedDatabase(join(dir, 'sessions.json'));
      assert.deepEqual(Object.keys(saved.events), ['session-2']);
      assert.deepEqual(Object.keys(saved.idempotency), ['session-2:key']);
      assert.equal(await readFile(sourceNote, 'utf8'), 'Keep this vault note.');
    });
  });

  test('a queued update cannot recreate a deleted session', async () => {
    await withStore(async (_dir, store) => {
      const initial = session();
      await store.create(initial);
      const removal = store.deleteSession(initial.id);
      const update = store.update(
        { ...initial, revision: 1 },
        0,
        event(1),
        'late-receipt',
        'fp',
      );
      await removal;
      await assert.rejects(update, /Quiz session disappeared/);
      assert.equal(await store.get(initial.id), undefined);
      assert.equal(await store.idempotent('late-receipt', 'fp'), undefined);
    });
  });

  test('preserves a concurrent metadata rename when an in-flight revision update commits', async () => {
    await withStore(async (_dir, store) => {
      const initial = session();
      await store.create(initial);
      const inFlight = {
        ...initial,
        revision: 1,
        transcript: [
          {
            id: 'm1',
            role: 'agent' as const,
            text: 'committed response',
            createdAt: initial.createdAt,
          },
        ],
      };
      await store.rename(initial.id, 'Renamed session');

      const committed = await store.update(
        inFlight,
        0,
        event(1),
        'concurrent-update',
        'fingerprint',
      );

      assert.equal(committed.name, 'Renamed session');
      assert.equal(committed.revision, 1);
      assert.equal((await store.get(initial.id))?.name, 'Renamed session');
      assert.equal((await store.events(initial.id)).length, 1);
    });
  });

  test('migrates legacy snapshot receipts to compact receipts and preserves authoritative session and drafts', async () => {
    await withStore(async (dir, store) => {
      const latest = {
        ...session(),
        revision: 2,
        eventCursor: 2,
        transcript: [
          {
            id: 'm1',
            role: 'agent' as const,
            text: 'kept transcript',
            createdAt: 'now',
          },
        ],
        currentQuestion: {
          id: 'q1',
          prompt: 'Q',
          choices: [{ id: 'a', text: 'A' }],
          status: 'answered' as const,
          selectedChoiceId: 'a',
          reasoningDraft: 'keep draft',
          feedback: null,
        },
      };
      const oldSnapshot = { ...latest, revision: 1, transcript: [] };
      await writeFile(
        join(dir, 'sessions.json'),
        JSON.stringify({
          version: 1,
          sessions: [latest],
          events: { 'session-1': [] },
          idempotency: { old: { fingerprint: 'fp', session: oldSnapshot } },
        }),
      );

      const retried = await store.idempotent('old', 'fp');
      assert.equal(retried?.revision, 2);
      assert.equal(retried?.transcript[0].text, 'kept transcript');
      assert.equal(retried?.currentQuestion?.reasoningDraft, 'keep draft');
      const saved = await persistedDatabase(join(dir, 'sessions.json'));
      assert.deepEqual(saved.idempotency.old, {
        fingerprint: 'fp',
        sessionId: 'session-1',
        revision: 1,
      });
      assert.equal(
        JSON.stringify(saved.idempotency).includes('kept transcript'),
        false,
      );
      assert.deepEqual(await store.idempotent('old', 'fp'), latest);
      await assert.rejects(
        store.idempotent('old', 'different'),
        /Idempotency key reused/,
      );
    });
  });
});

async function persistedDatabase(path: string) {
  const store = new QuizStore(path);
  const sessions = await store.list();
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  const idempotency: Record<string, Record<string, unknown>> = {};
  for (const files of Object.values(manifest.sessions) as {
    history: string;
  }[]) {
    const history = JSON.parse(
      await readFile(join(`${path}.sessions`, files.history), 'utf8'),
    );
    Object.assign(idempotency, history.idempotency);
  }
  return {
    sessions,
    events: Object.fromEntries(
      await Promise.all(
        sessions.map(async (session) => [
          session.id,
          await store.events(session.id),
        ]),
      ),
    ),
    idempotency,
  };
}
