import { mkdir, readFile, rename, writeFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { KeyedQueue } from '../shared/asyncQueue';
import { STUDY_LIMITS, type StudySnapshot } from '../shared/studyContext';
import type { QuizScope } from '../shared/quizProtocol';

type StudyDatabase = {
  version: 1;
  scopes: Record<string, QuizScope>;
  snapshots: StudySnapshot[];
  pins: Record<string, string>;
};
export class StudyContextStore {
  private readonly queue = new KeyedQueue();
  private cache?: { signature: string; data: StudyDatabase };
  constructor(private readonly file: string) {}
  private async load(): Promise<StudyDatabase> {
    try {
      const info = await stat(this.file);
      const signature = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      if (this.cache?.signature === signature) return this.cache.data;
      const data = JSON.parse(
        await readFile(this.file, 'utf8'),
      ) as StudyDatabase;
      if (
        data.version !== 1 ||
        !data.scopes ||
        !Array.isArray(data.snapshots) ||
        !data.pins
      )
        throw new Error('STUDY_STORE_INVALID');
      this.cache = { signature, data };
      return data;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT')
        return { version: 1, scopes: {}, snapshots: [], pins: {} };
      throw e;
    }
  }
  private async update<T>(
    mutate: (data: StudyDatabase) => T,
    protectedSnapshot?: string,
  ): Promise<T> {
    return this.queue.run('store', async () => {
      const data = structuredClone(await this.load());
      const value = mutate(data);
      let encoded = JSON.stringify(data);
      while (Buffer.byteLength(encoded) > STUDY_LIMITS.storeBytes) {
        const index = data.snapshots.findIndex(
          (s) =>
            s.id !== protectedSnapshot &&
            !Object.values(data.pins).includes(s.id),
        );
        if (index < 0) throw new Error('STUDY_STORAGE_FULL');
        data.snapshots.splice(index, 1);
        encoded = JSON.stringify(data);
      }
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, encoded, { mode: 0o600 });
      await rename(temporary, this.file);
      this.cache = undefined;
      return value;
    });
  }
  async bind(id: string, scope: QuizScope) {
    await this.update((data) => {
      if (!data.scopes[id] && Object.keys(data.scopes).length >= 100)
        throw new Error('STUDY_SCOPE_LIMIT');
      data.scopes[id] = scope;
    });
  }
  async scope(id: string) {
    return structuredClone((await this.load()).scopes[id]);
  }
  async save(snapshot: StudySnapshot) {
    await this.update((data) => {
      if (!data.snapshots.some((s) => s.id === snapshot.id))
        data.snapshots.push(snapshot);
      // Bounded retention; pinned question evidence survives ordinary cache eviction.
      while (data.snapshots.length > 64) {
        const index = data.snapshots.findIndex(
          (s) =>
            !Object.values(data.pins).includes(s.id) && s.id !== snapshot.id,
        );
        if (index < 0) throw new Error('STUDY_STORAGE_FULL');
        data.snapshots.splice(index, 1);
      }
    }, snapshot.id);
  }
  async snapshot(id: string) {
    return structuredClone(
      (await this.load()).snapshots.find((s) => s.id === id),
    );
  }
  async pin(key: string, id: string) {
    await this.update((data) => {
      if (!data.snapshots.some((s) => s.id === id))
        throw new Error('STUDY_SNAPSHOT_UNAVAILABLE');
      data.pins[key] = id;
    });
  }
  async finalizeQuestion(
    sessionId: string,
    snapshotId: string | undefined,
    pendingKey: string,
    revision: number,
  ) {
    await this.update((data) => {
      delete data.pins[pendingKey];
      const prefix = `question:${sessionId}:`;
      const keys = Object.keys(data.pins).filter((k) => k.startsWith(prefix));
      if (keys.some((k) => Number(k.slice(prefix.length)) > revision)) return;
      for (const key of keys) delete data.pins[key];
      if (snapshotId) data.pins[`${prefix}${revision}`] = snapshotId;
    });
  }
  async reconcileQuestions(
    questions: Array<{
      id: string;
      revision: number;
      currentQuestion: { studyBasis?: string } | null;
    }>,
  ) {
    await this.update((data) => {
      data.pins = Object.fromEntries(
        questions.flatMap((q) =>
          q.currentQuestion?.studyBasis
            ? [[`question:${q.id}:${q.revision}`, q.currentQuestion.studyBasis]]
            : [],
        ),
      );
    });
  }
}
