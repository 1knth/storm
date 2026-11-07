import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  rename,
  realpath,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StudyContextService } from './studyContextService';
import { StudyContextStore } from './studyContextStore';
import { VaultService } from '../vault/vaultService';
import { VaultMutationCoordinator } from '../vault/mutationCoordinator';
import { readStudySource } from '../vault/studySourceReader';
import { runVaultLifecycleExclusive } from './vaultLifecycle';
import {
  STUDY_LIMITS,
  isStudyRequest,
  validateStudyEvidence,
  type StudyPacket,
  type StudyTree,
} from '../shared/studyContext';
import { QuizService } from './quizService';
import { QuizStore } from './quizStore';
import { quizAgentQuestion } from '../shared/quizAgentContext';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'storm-study-'));
  await mkdir(join(dir, 'vault', 'Course'), { recursive: true });
  const root = await realpath(join(dir, 'vault'));
  await writeFile(
    join(root, 'Course', 'Motion.md'),
    '# Speed\nSpeed is distance divided by time.\n[[Distance]]\n[[Outside]]\n```\n[[Fake]]\n```\n',
  );
  await writeFile(
    join(root, 'Course', 'Distance.md'),
    '# Distance\nDistance measures path length.\n[[Motion]]\n',
  );
  await writeFile(
    join(root, 'Outside.md'),
    '# Private unrelated material\nUNRELATED_SECRET\n',
  );
  const scope = {
    vaultId: 'vault',
    notePath: null,
    folderPath: 'Course',
    selectedNotePaths: [],
  };
  const live = new Map<string, string>();
  const barrier = new VaultMutationCoordinator();
  let available = true;
  const ports = {
    vaults: async () => (available ? [{ id: 'vault', path: root }] : []),
    entries: async () => {
      const vault = new VaultService();
      await vault.selectVault(root);
      return vault.listNotes({ previews: false });
    },
    live: async (_vaultId: string, path: string) =>
      live.has(path)
        ? { text: live.get(path)!, saveState: 'pending' as const }
        : null,
    capture: <T>(path: string, operation: () => Promise<T>) =>
      runVaultLifecycleExclusive(path, () => barrier.run(operation)),
    read: readStudySource,
  };
  const store = new StudyContextStore(join(dir, 'study.json'));
  const service = new StudyContextService(store, ports);
  const opened = (await service.execute({
    action: 'open',
    scope,
  })) as StudyTree;
  const retrieve = async (query = 'Speed') =>
    service.execute({
      action: 'retrieve',
      studyId: opened.studyId,
      query,
    }) as Promise<StudyPacket>;
  return {
    dir,
    root,
    scope,
    live,
    barrier,
    ports,
    store,
    service,
    opened,
    retrieve,
    unload: () => {
      available = false;
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test('scoped tree and source packets share exact hashes, headings and explicit links without reading outside scope', async () => {
  const f = await fixture();
  try {
    assert.ok(
      f.opened.entries.every(
        (e) => e.path === 'Course' || e.path.startsWith('Course/'),
      ),
    );
    const packet = await f.retrieve();
    assert.ok(packet.chunks.some((c) => c.heading === 'Speed'));
    assert.ok(!JSON.stringify(packet).includes('UNRELATED_SECRET'));
    const source = packet.sources.find((s) => s.path.endsWith('Motion.md'))!;
    assert.deepEqual(source.links, [
      { target: 'Distance', path: 'Course/Distance.md' },
      { target: 'Outside', issue: 'outside-scope' },
    ]);
    assert.equal(packet.chunks[0].contentHash, source.contentHash);
    const chunk = packet.chunks[0];
    const reference = {
      snapshotId: packet.snapshotId,
      sourceId: chunk.sourceId,
      contentHash: chunk.contentHash,
      chunkId: chunk.id,
      quote: 'Speed is distance divided by time.',
    };
    assert.deepEqual(validateStudyEvidence(packet, [reference]), []);
    assert.equal(
      validateStudyEvidence(packet, [{ ...reference, quote: 'invented quote' }])
        .length,
      1,
    );
    assert.equal(
      validateStudyEvidence(packet, [
        { ...reference, snapshotId: 'another-snapshot' },
      ]).length,
      1,
    );
    assert.equal(
      isStudyRequest({
        action: 'open',
        scope: { ...f.scope, folderPath: '../' },
      }),
      false,
    );
    assert.equal(
      isStudyRequest({
        action: 'retrieve',
        studyId: f.opened.studyId,
        query: 'x',
        offset: -1,
      }),
      false,
    );
  } finally {
    await f.cleanup();
  }
});

test('source edits change freshness while immutable snapshots survive process reconstruction and file removal', async () => {
  const f = await fixture();
  try {
    const packet = await f.retrieve();
    const original = packet.chunks.map((c) => c.text).join('');
    await writeFile(
      join(f.root, 'Course', 'Motion.md'),
      '# Speed\nCorrected speed material.\n',
    );
    const validation = await f.service.execute({
      action: 'validate',
      studyId: f.opened.studyId,
      snapshotId: packet.snapshotId,
    });
    assert.ok(
      'sources' in validation &&
        validation.sources.some((s) => 'state' in s && s.state === 'changed'),
    );
    const fresh = await f.retrieve();
    assert.notEqual(fresh.snapshotId, packet.snapshotId);
    await rm(join(f.root, 'Course', 'Motion.md'));
    const restarted = new StudyContextService(
      new StudyContextStore(join(f.dir, 'study.json')),
      f.ports,
    );
    const historical = (await restarted.execute({
      action: 'read',
      studyId: f.opened.studyId,
      snapshotId: packet.snapshotId,
    })) as StudyPacket;
    assert.equal(historical.chunks.map((c) => c.text).join(''), original);
    f.unload();
    await assert.rejects(
      restarted.execute({
        action: 'read',
        studyId: f.opened.studyId,
        snapshotId: packet.snapshotId,
      }),
      /STUDY_VAULT_UNAVAILABLE/,
    );
  } finally {
    await f.cleanup();
  }
});

test('live text is labeled and does not trigger a save; renderer calls happen outside capture locks', async () => {
  const f = await fixture();
  try {
    f.live.set('Course/Motion.md', '# Speed\nUnsaved speed definition.\n');
    let locked = false;
    const service = new StudyContextService(f.store, {
      ...f.ports,
      capture: async (root, operation) =>
        f.ports.capture(root, async () => {
          locked = true;
          try {
            return await operation();
          } finally {
            locked = false;
          }
        }),
      live: async (vault, path) => {
        assert.equal(locked, false);
        return f.ports.live(vault, path);
      },
    });
    const packet = (await service.execute({
      action: 'retrieve',
      studyId: f.opened.studyId,
      query: 'speed',
    })) as StudyPacket;
    assert.equal(packet.sources[0].origin, 'editor');
    assert.equal(packet.sources[0].saveState, 'pending');
    assert.match(packet.chunks[0].text, /Unsaved/);
    assert.doesNotMatch(
      await readFile(join(f.root, 'Course', 'Motion.md'), 'utf8'),
      /Unsaved/,
    );
  } finally {
    await f.cleanup();
  }
});

test('capture shares mutation serialization and fails honestly when rename wins the race', async () => {
  const f = await fixture();
  try {
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const move = f.barrier.run(async () => {
      await gate;
      await rename(
        join(f.root, 'Course', 'Motion.md'),
        join(f.root, 'Course', 'Renamed.md'),
      );
    });
    const retrieval = f.retrieve();
    await new Promise((done) => setTimeout(done, 10));
    release();
    await move;
    const packet = await retrieval;
    assert.ok(packet.issues.some((i) => i.path.endsWith('Motion.md')));
    assert.equal(packet.chunks.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('whole-scope ranking finds content beyond note 64 and rejects stale ranked cursors', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 70; i++)
      await writeFile(
        join(f.root, 'Course', `item-${String(i).padStart(3, '0')}.md`),
        `# Item\n${i >= 64 ? 'zebraword' : 'ordinary content'}\n`,
      );
    const page = await f.retrieve('zebraword');
    assert.ok(page.chunks.some((c) => c.text.includes('zebraword')));
    assert.ok(page.nextScanOffset);
    const next = (await f.service.execute({
      action: 'retrieve',
      studyId: f.opened.studyId,
      query: 'zebraword',
      offset: page.nextScanOffset!,
    })) as StudyPacket;
    assert.ok(next.chunks.length);
    assert.ok(
      next.chunks.every((c) => !page.chunks.some((p) => p.id === c.id)),
    );
    await writeFile(join(f.root, 'Course', 'new.md'), 'zebraword');
    await assert.rejects(
      f.service.execute({
        action: 'retrieve',
        studyId: f.opened.studyId,
        query: 'zebraword',
        offset: page.nextScanOffset!,
      }),
      /STUDY_CURSOR_STALE/,
    );
  } finally {
    await f.cleanup();
  }
});

test('content outranks filenames and scope folder names do not qualify passages', async () => {
  const f = await fixture();
  try {
    await writeFile(
      join(f.root, 'Course', 'zebraword.md'),
      'irrelevant material',
    );
    await writeFile(
      join(f.root, 'Course', 'Relevant.md'),
      'zebraword explains the principle',
    );
    const packet = await f.retrieve('zebraword');
    assert.equal(packet.sources[0].path, 'Course/Relevant.md');
    assert.equal((await f.retrieve('Course')).chunks.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('Unicode snapshot reads are byte bounded and reassemble all captured source text', async () => {
  const f = await fixture();
  try {
    const text = '# Speed\n' + 'speed λ🧠 café\n'.repeat(6000);
    await writeFile(join(f.root, 'Course', 'Motion.md'), text);
    const packet = await f.retrieve();
    let offset: number | null = 0;
    let body = '';
    while (offset !== null) {
      const read = (await f.service.execute({
        action: 'read',
        studyId: f.opened.studyId,
        snapshotId: packet.snapshotId,
        offset,
      })) as StudyPacket;
      assert.ok(
        Buffer.byteLength(JSON.stringify(read)) <= STUDY_LIMITS.responseBytes,
      );
      assert.ok(
        read.chunks.every(
          (c) => Buffer.byteLength(c.text) <= STUDY_LIMITS.chunkBytes,
        ),
      );
      body += read.chunks.map((c) => c.text).join('');
      assert.ok(read.nextOffset === null || read.nextOffset > offset);
      offset = read.nextOffset;
    }
    assert.equal(body, text);
  } finally {
    await f.cleanup();
  }
});

test('validated source reader rejects symlinks and oversized notes', async () => {
  const f = await fixture();
  try {
    await symlink(
      join(f.root, 'Outside.md'),
      join(f.root, 'Course', 'Link.md'),
    );
    await assert.rejects(
      readStudySource(f.root, 'Course/Link.md'),
      /STUDY_INVALID_PATH/,
    );
    await writeFile(
      join(f.root, 'Course', 'Large.md'),
      'x'.repeat(STUDY_LIMITS.sourceBytes + 1),
    );
    await assert.rejects(
      readStudySource(f.root, 'Course/Large.md'),
      /STUDY_SOURCE_TOO_LARGE/,
    );
  } finally {
    await f.cleanup();
  }
});

test('question basis is committed with the question, survives source changes, and stale basis rejects new questions', async () => {
  const f = await fixture();
  try {
    const packet = await f.retrieve();
    const quiz = new QuizService(
      new QuizStore(join(f.dir, 'quiz.json')),
      () => true,
      undefined,
      (session, id) =>
        f.service.pinQuestion(`question:${session.id}`, id, session.scope),
    );
    const created = await quiz.createSession(f.scope);
    assert.ok(created.ok);
    const attached = await quiz.attachSession(created.value.id);
    assert.ok(attached.ok);
    let session = attached.value.snapshot.session;
    const question = {
      type: 'pose-question' as const,
      sessionId: session.id,
      agentToken: session.agentToken,
      expectedRevision: session.revision,
      idempotencyKey: 'pose',
      kind: 'short-answer' as const,
      question: 'Explain speed',
      studyBasis: packet.snapshotId,
    };
    const posed = await quiz.request(question);
    assert.ok(posed.ok);
    session = posed.value;
    assert.equal(
      quizAgentQuestion(session.currentQuestion)?.studyBasis,
      packet.snapshotId,
    );
    await writeFile(
      join(f.root, 'Course', 'Motion.md'),
      '# Speed\nNew source\n',
    );
    assert.ok((await quiz.request(question)).ok); // Idempotent retry does not revalidate against replacement sources.
    const answered = await quiz.learnerRequest({
      type: 'answer',
      sessionId: session.id,
      expectedRevision: session.revision,
      idempotencyKey: 'answer',
      answer: 'Distance / time',
    });
    assert.ok(answered.ok);
    const feedback = await quiz.request({
      type: 'feedback',
      sessionId: session.id,
      agentToken: session.agentToken,
      expectedRevision: answered.value.revision,
      idempotencyKey: 'feedback',
      text: 'Correct for the original source',
      verdict: 'correct',
    });
    assert.ok(feedback.ok);
    assert.equal(feedback.value.currentQuestion?.studyBasis, packet.snapshotId);
    const continued = await quiz.learnerRequest({
      type: 'continue',
      sessionId: session.id,
      expectedRevision: feedback.value.revision,
      idempotencyKey: 'continue',
    });
    assert.ok(continued.ok);
    const rejected = await quiz.request({
      ...question,
      expectedRevision: continued.value.revision,
      idempotencyKey: 'new-question',
    });
    assert.deepEqual(rejected, { ok: false, error: 'study-unavailable' });
  } finally {
    await f.cleanup();
  }
});

test('ranked continuation delivers interleaved source passages exactly once', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 6; i++)
      await writeFile(
        join(f.root, 'Course', `rank-${i}.md`),
        '# First\nuniqueterm\n## Second\nuniqueterm\n## Third\nuniqueterm\n',
      );
    const seen = new Set<string>();
    let offset = 0;
    for (let page = 0; page < 20; page++) {
      const packet = (await f.service.execute({
        action: 'retrieve',
        studyId: f.opened.studyId,
        query: 'uniqueterm',
        offset,
      })) as StudyPacket;
      for (const chunk of packet.chunks) {
        assert.ok(
          !seen.has(chunk.id),
          'ranked continuation repeated a passage',
        );
        seen.add(chunk.id);
      }
      if (packet.nextScanOffset === null) break;
      offset = packet.nextScanOffset!;
    }
    assert.equal(seen.size, 18);
  } finally {
    await f.cleanup();
  }
});
