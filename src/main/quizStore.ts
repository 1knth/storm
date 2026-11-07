import {
  mkdir,
  readFile,
  rename,
  writeFile,
  stat,
  copyFile,
  rm,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import type {
  QuizEvent,
  QuizScope,
  QuizSession,
  QuizSessionSummary,
} from '../shared/quizProtocol';
import { quizAgentEvent } from '../shared/quizAgentContext';
import {
  changeQuizScope,
  applyQuizRevision,
  type QuizRevisionChange,
} from './quizOperations';
import { sessionEvidence } from './quizEvidence';
import type { LearnerAttempt } from '../shared/learnerModel';
import { learnerScopeKey } from './learnerStore';

export type QuizDatabase = {
  version: 1;
  facts?: Record<string, ReturnType<typeof sessionEvidence>>;
  learning?: { imported: boolean; scopes: Record<string, LearnerAttempt[]> };
  sessions: QuizSession[];
  events: Record<string, QuizEvent[]>;
  idempotency: Record<
    string,
    { fingerprint: string; sessionId: string; revision: number }
  >;
};
type Manifest = {
  version: 2;
  learning?: string;
  sessions: Record<string, { history: string; transient: string }>;
};

function copyDatabase(db: QuizDatabase): QuizDatabase {
  return {
    ...db,
    sessions: [...db.sessions],
    events: { ...db.events },
    facts: { ...db.facts },
    idempotency: db.idempotency,
  };
}

function splitSession(session: QuizSession) {
  const { activity, freeChatDraft, currentPrompt, currentQuestion, ...rest } =
    session;
  const {
    selectedChoiceId: promptChoice,
    detailDraft,
    ...prompt
  } = currentPrompt ?? {};
  const {
    selectedChoiceId,
    reasoningDraft,
    matchesDraft,
    textDraft,
    ...question
  } = currentQuestion ?? {};
  return {
    history: {
      ...rest,
      currentPrompt: currentPrompt ? prompt : currentPrompt,
      currentQuestion: currentQuestion ? question : currentQuestion,
    },
    transient: {
      activity,
      freeChatDraft,
      prompt: { selectedChoiceId: promptChoice, detailDraft },
      question: { selectedChoiceId, reasoningDraft, matchesDraft, textDraft },
    },
  };
}

function sanitizeEvent(event: QuizEvent): QuizEvent {
  return { ...event, data: quizAgentEvent(event).data ?? {} };
}

function mergeDraftFields(
  current: QuizSession,
  incoming: QuizSession,
): QuizSession {
  const merged: QuizSession = {
    ...current,
    freeChatDraft: incoming.freeChatDraft,
  };
  if (
    current.currentPrompt &&
    incoming.currentPrompt &&
    current.currentPrompt.id === incoming.currentPrompt.id
  ) {
    merged.currentPrompt = {
      ...current.currentPrompt,
      selectedChoiceId: incoming.currentPrompt.selectedChoiceId,
      detailDraft: incoming.currentPrompt.detailDraft,
    };
  }
  if (
    current.currentQuestion &&
    incoming.currentQuestion &&
    current.currentQuestion.id === incoming.currentQuestion.id
  ) {
    merged.currentQuestion = {
      ...current.currentQuestion,
      selectedChoiceId: incoming.currentQuestion.selectedChoiceId,
      reasoningDraft: incoming.currentQuestion.reasoningDraft,
      matchesDraft: incoming.currentQuestion.matchesDraft,
      textDraft: incoming.currentQuestion.textDraft,
    };
  }
  return merged;
}

const emptyDatabase = (): QuizDatabase => ({
  version: 1,
  sessions: [],
  events: {},
  idempotency: {},
});

/** Per-session immutable files, published together by an atomic versioned manifest. */
export class QuizStore {
  private queue: Promise<unknown> = Promise.resolve();
  private cache?: { signature: string; database: QuizDatabase };
  private drafts = new Map<
    string,
    {
      session: QuizSession;
      events: QuizEvent[];
      idempotency: QuizDatabase['idempotency'];
    }
  >();
  private manifest?: Manifest;
  constructor(private readonly filePath: string) {}

  protected async atomicWrite(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value), {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporary, path);
    } finally {
      await import('node:fs/promises').then(({ rm }) =>
        rm(temporary, { force: true }),
      );
    }
  }

  private async read(): Promise<QuizDatabase> {
    let manifestExists = false;
    try {
      const info = await stat(this.filePath);
      manifestExists = true;
      const signature = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      if (this.cache?.signature === signature) return this.cache.database;
      let value: unknown = JSON.parse(await readFile(this.filePath, 'utf8'));
      if ((value as Manifest).version === 2) {
        const manifest = value as Manifest;
        const db = emptyDatabase();
        for (const [id, files] of Object.entries(manifest.sessions)) {
          const root = `${this.filePath}.sessions`;
          const history = JSON.parse(
            await readFile(join(root, files.history), 'utf8'),
          );
          const transient = JSON.parse(
            await readFile(join(root, files.transient), 'utf8'),
          );
          const session = history.session;
          const { prompt, question, ...draftFields } = transient;
          db.sessions.push({
            ...session,
            ...draftFields,
            ...(session.currentPrompt
              ? { currentPrompt: { ...session.currentPrompt, ...prompt } }
              : {}),
            ...(session.currentQuestion
              ? { currentQuestion: { ...session.currentQuestion, ...question } }
              : {}),
          });
          (db.facts ??= {})[id] =
            history.facts ?? sessionEvidence(db.sessions.at(-1)!);
          db.events[id] = history.events;
          Object.assign(db.idempotency, history.idempotency);
        }
        if (manifest.learning)
          db.learning = JSON.parse(
            await readFile(
              join(`${this.filePath}.sessions`, manifest.learning),
              'utf8',
            ),
          );
        this.manifest = manifest;
        value = db;
      } else this.manifest = undefined;
      if (
        !value ||
        typeof value !== 'object' ||
        (value as QuizDatabase).version !== 1 ||
        !Array.isArray((value as QuizDatabase).sessions)
      )
        throw new Error('Unsupported quiz store format');
      const database = value as QuizDatabase & {
        idempotency?: Record<
          string,
          {
            fingerprint: string;
            session?: QuizSession;
            sessionId?: string;
            revision?: number;
          }
        >;
      };
      const legacyReceipts = Object.values(database.idempotency ?? {}).some(
        (receipt) => 'session' in receipt,
      );
      database.idempotency = Object.fromEntries(
        Object.entries(database.idempotency ?? {}).map(([key, receipt]) => {
          let fingerprint = receipt.fingerprint;
          // Previous versions persisted JSON request bodies as receipts. Hash
          // those legacy values while retaining idempotency comparisons.
          if (fingerprint.startsWith('{') || fingerprint.startsWith('['))
            fingerprint = createHash('sha256')
              .update(fingerprint)
              .digest('hex');
          return [
            key,
            receipt.session
              ? {
                  fingerprint,
                  sessionId: receipt.session.id,
                  revision: receipt.session.revision,
                }
              : {
                  fingerprint,
                  sessionId: receipt.sessionId!,
                  revision: receipt.revision!,
                },
          ];
        }),
      );
      database.facts ??= Object.fromEntries(
        database.sessions.map((session) => [
          session.id,
          sessionEvidence(session),
        ]),
      );
      database.events ??= {};
      // Older versions persisted entire requests in event.data, including the
      // agent capability. Sanitize only structured event data, never transcript
      // text, and persist the migration on the next normal write.
      database.events = Object.fromEntries(
        Object.entries(database.events).map(([id, events]) => [
          id,
          events.map(sanitizeEvent),
        ]),
      );
      this.cache = { signature, database };
      if (legacyReceipts || !this.manifest) await this.write(database);
      return database;
    } catch (error) {
      if (!manifestExists && (error as NodeJS.ErrnoException).code === 'ENOENT')
        return emptyDatabase();
      throw error;
    }
  }

  private async write(database: QuizDatabase): Promise<void> {
    const previous = this.cache?.database;
    const manifest: Manifest = { version: 2, sessions: {} };
    const root = `${this.filePath}.sessions`;
    let receiptsBySession: Map<string, QuizDatabase['idempotency']> | undefined;
    for (const session of database.sessions) {
      const old = previous?.sessions.find((item) => item.id === session.id);
      const files = this.manifest?.sessions[session.id];
      if (
        files &&
        old === session &&
        previous?.events[session.id] === database.events[session.id]
      ) {
        manifest.sessions[session.id] = files;
        continue;
      }
      const parts = splitSession(session);
      const oldParts = old && splitSession(old);
      const historyUnchanged =
        files &&
        oldParts &&
        JSON.stringify(parts.history) === JSON.stringify(oldParts.history) &&
        previous?.events[session.id] === database.events[session.id];
      const historyFile = historyUnchanged
        ? files.history
        : `${crypto.randomUUID()}.history.json`;
      const transientFile = `${crypto.randomUUID()}.transient.json`;
      if (!historyUnchanged) {
        if (!receiptsBySession) {
          receiptsBySession = new Map();
          for (const [key, receipt] of Object.entries(database.idempotency)) {
            let group = receiptsBySession.get(receipt.sessionId);
            if (!group) {
              group = {};
              receiptsBySession.set(receipt.sessionId, group);
            }
            group[key] = receipt;
          }
        }
        const receipts = receiptsBySession.get(session.id) ?? {};
        await this.atomicWrite(join(root, historyFile), {
          session: parts.history,
          events: database.events[session.id] ?? [],
          idempotency: receipts,
          facts: ((database.facts ??= {})[session.id] =
            sessionEvidence(session)),
        });
      }
      await this.atomicWrite(join(root, transientFile), parts.transient);
      manifest.sessions[session.id] = {
        history: historyFile,
        transient: transientFile,
      };
    }
    if (database.learning) {
      if (this.manifest?.learning && previous?.learning === database.learning)
        manifest.learning = this.manifest.learning;
      else {
        manifest.learning = `${crypto.randomUUID()}.learning.json`;
        await this.atomicWrite(
          join(root, manifest.learning),
          database.learning,
        );
      }
    }
    if (!this.manifest && previous) {
      // Keep the original bytes for rollback; interrupted imports can safely retry.
      try {
        await copyFile(this.filePath, `${this.filePath}.v1-backup`, 1);
      } catch (error) {
        if (
          !['EEXIST', 'ENOENT'].includes(
            (error as NodeJS.ErrnoException).code ?? '',
          )
        )
          throw error;
      }
    }
    const oldManifest = this.manifest;
    // The manifest is the commit point, including changes spanning multiple sessions.
    await this.atomicWrite(this.filePath, manifest);
    this.manifest = manifest;
    const live = new Set(
      Object.values(manifest.sessions).flatMap(({ history, transient }) => [
        history,
        transient,
      ]),
    );
    if (manifest.learning) live.add(manifest.learning);
    if (oldManifest?.learning && !live.has(oldManifest.learning))
      await rm(join(root, oldManifest.learning), { force: true }).catch(
        () => {},
      );
    // Only remove files superseded by this successful commit. Failed writes leave
    // unreachable files, never a manifest referencing partially written state.
    for (const files of Object.values(oldManifest?.sessions ?? {})) {
      for (const name of [files.history, files.transient]) {
        if (!live.has(name))
          await rm(join(root, name), { force: true }).catch(() => {});
      }
    }
    const info = await stat(this.filePath);
    this.cache = {
      signature: `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`,
      database,
    };
  }

  /** Every session, saved and draft, as seen inside a serialized operation. */
  private sessionsIn(db: QuizDatabase): QuizSession[] {
    return [
      ...db.sessions,
      ...[...this.drafts.values()].map((draft) => draft.session),
    ];
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
  /** Recover prior-process connections in one atomic manifest commit. */
  async recoverConnections(at: string): Promise<QuizSession[]> {
    return this.serialize(async () => {
      const db = copyDatabase(await this.read());
      db.idempotency = { ...db.idempotency };
      let changed = false;
      db.sessions = db.sessions.map((session) => {
        if (session.status !== 'connected') return session;
        changed = true;
        const next: QuizSession = {
          ...session,
          status: 'disconnected',
          activity: undefined,
          awaitingAgent: false,
          revision: session.revision + 1,
          eventCursor: session.eventCursor + 1,
          updatedAt: at,
        };
        db.events[session.id] = [
          ...(db.events[session.id] ?? []),
          {
            cursor: next.eventCursor,
            revision: next.revision,
            type: 'disconnect',
            data: {},
            createdAt: at,
          },
        ];
        db.idempotency[`${session.id}:disconnect:${next.revision}`] = {
          fingerprint: JSON.stringify([session.id, next.revision]),
          sessionId: session.id,
          revision: next.revision,
        };
        return next;
      });
      if (changed) await this.write(db);
      return structuredClone(db.sessions);
    });
  }

  recordingDiagnostics(sessionIds?: ReadonlySet<string>) {
    const sessions = [
      ...(this.cache?.database.sessions ?? []),
      ...[...this.drafts.values()].map((draft) => draft.session),
    ];
    return {
      pending: 0,
      failures: 0,
      unmodelled: sessions
        .filter((session) => !sessionIds || sessionIds.has(session.id))
        .reduce(
          (total, session) =>
            total +
            (
              this.cache?.database.facts?.[session.id] ??
              sessionEvidence(session)
            ).unmodelled,
          0,
        ),
    };
  }

  async hasLearnerImport(): Promise<boolean> {
    await this.queue;
    return !!(await this.read()).learning?.imported;
  }

  async importLearner(
    scopes: Record<string, { attempts: LearnerAttempt[] }>,
  ): Promise<void> {
    return this.serialize(async () => {
      const db = copyDatabase(await this.read());
      if (db.learning?.imported) return;
      const currentIds = new Set(db.sessions.map((session) => session.id));
      const previous = db.learning?.scopes ?? {};
      db.learning = { imported: true, scopes: { ...previous } };
      for (const [key, value] of Object.entries(scopes)) {
        db.learning.scopes[key] = [
          ...(previous[key] ?? []),
          ...value.attempts.filter(
            (attempt) => !currentIds.has(attempt.sessionId),
          ),
        ];
      }
      await this.write(db);
    });
  }

  async attempts(scopeKey: string): Promise<LearnerAttempt[]> {
    await this.queue;
    const db = await this.read();
    const attempts = new Map(
      (db.learning?.scopes[scopeKey] ?? []).map((attempt) => [
        attempt.id,
        attempt,
      ]),
    );
    for (const session of this.sessionsIn(db)) {
      if (learnerScopeKey(session.scope, session.id) !== scopeKey) continue;
      for (const attempt of (this.drafts.has(session.id)
        ? sessionEvidence(session)
        : db.facts?.[session.id]
      )?.attempts ?? [])
        attempts.set(attempt.id, attempt);
    }
    return structuredClone([...attempts.values()]);
  }

  async list(
    options: { includeDrafts?: boolean } = {},
  ): Promise<QuizSession[]> {
    await this.queue;
    const sessions = structuredClone((await this.read()).sessions);
    return options.includeDrafts
      ? [
          ...sessions,
          ...[...this.drafts.values()].map((draft) => draft.session),
        ]
      : sessions;
  }
  async get(id: string): Promise<QuizSession | undefined> {
    await this.queue;
    return (
      this.drafts.get(id)?.session ??
      structuredClone(
        (await this.read()).sessions.find((session) => session.id === id),
      )
    );
  }
  async listSummaries(): Promise<QuizSessionSummary[]> {
    await this.queue;
    return structuredClone(
      (await this.read()).sessions.map(
        ({ id, name, scope, status, createdAt, updatedAt }) => ({
          id,
          name,
          scope,
          status,
          createdAt,
          updatedAt,
        }),
      ),
    );
  }
  async getAgentState(id: string): Promise<QuizSession | undefined> {
    await this.queue;
    const session =
      this.drafts.get(id)?.session ??
      (await this.read()).sessions.find((item) => item.id === id);
    if (!session) return undefined;
    return structuredClone({ ...session, transcript: [], freeChatDraft: '' });
  }

  async createDraft(session: QuizSession): Promise<void> {
    return this.serialize(async () => {
      const db = copyDatabase(await this.read());
      if (
        db.sessions.some((item) => item.id === session.id) ||
        this.drafts.has(session.id)
      )
        throw new Error('Duplicate quiz session');
      this.drafts.set(session.id, { session, events: [], idempotency: {} });
    });
  }
  async promote(id: string): Promise<void> {
    return this.serialize(async () => {
      const draft = this.drafts.get(id);
      if (!draft) return;
      const db = copyDatabase(await this.read());
      if (db.sessions.some((item) => item.id === id))
        throw new Error('Duplicate quiz session');
      db.sessions.push(draft.session);
      db.events[id] = draft.events;
      db.idempotency = { ...db.idempotency, ...draft.idempotency };
      await this.write(db);
      this.drafts.delete(id);
    });
  }
  async events(id: string, after = 0): Promise<QuizEvent[]> {
    await this.queue;
    if (this.drafts.has(id))
      return this.drafts
        .get(id)!
        .events.filter((event) => event.cursor > after)
        .map(sanitizeEvent);
    return (
      (await this.read()).events[id]
        ?.filter((event) => event.cursor > after)
        .map(sanitizeEvent) ?? []
    );
  }
  async idempotent(
    key: string,
    fingerprint: string,
  ): Promise<QuizSession | undefined> {
    await this.queue;
    for (const draft of this.drafts.values()) {
      const receipt = draft.idempotency[key];
      if (receipt) {
        if (receipt.fingerprint !== fingerprint)
          throw new Error('Idempotency key reused');
        return draft.session;
      }
    }
    const prior = (await this.read()).idempotency[key];
    if (!prior) return undefined;
    if (prior.fingerprint !== fingerprint)
      throw new Error('Idempotency key reused');
    // Receipts acknowledge the original action, not a historical session snapshot.
    // Return the latest session so retries remain successful after later updates.
    return (await this.read()).sessions.find(
      (session) => session.id === prior.sessionId,
    );
  }
  async create(session: QuizSession): Promise<void> {
    return this.serialize(async () => {
      const db = copyDatabase(await this.read());
      if (db.sessions.some((item) => item.id === session.id))
        throw new Error('Duplicate quiz session');
      db.sessions.push(session);
      db.events[session.id] = [];
      await this.write(db);
    });
  }
  /**
   * Counts deletions. Evidence read outside serialization is only trusted at
   * commit if no quiz was deleted in between (its transcript would be gone).
   */
  get deletions(): number {
    return this.deletionCount;
  }
  private deletionCount = 0;

  async deleteSession(id: string): Promise<void> {
    return this.serialize(async () => {
      this.deletionCount++;
      if (this.drafts.delete(id)) return;
      const db = copyDatabase(await this.read());
      const removed = db.sessions.find((session) => session.id === id);
      if (removed) {
        const key = learnerScopeKey(removed.scope, removed.id);
        const learning = db.learning ?? { imported: false, scopes: {} };
        db.learning = {
          ...learning,
          scopes: {
            ...learning.scopes,
            [key]: [
              ...(learning.scopes[key] ?? []),
              ...(db.facts?.[id]?.attempts ?? []),
            ],
          },
        };
      }
      delete db.facts?.[id];
      db.sessions = db.sessions.filter((session) => session.id !== id);
      delete db.events[id];
      db.idempotency = Object.fromEntries(
        Object.entries(db.idempotency).filter(
          ([, receipt]) => receipt.sessionId !== id,
        ),
      );
      await this.write(db);
    });
  }

  /** One commit engine for saved sessions and memory-only drafts. */
  private async transact(
    id: string,
    operation: (
      current: QuizSession,
      sessions: QuizSession[],
    ) => { session: QuizSession; others?: QuizSession[] } | string | undefined,
    guard: {
      token?: string;
      revision?: number;
      event?: QuizEvent;
      receipt?: { key: string; fingerprint: string };
    } = {},
  ): Promise<QuizSession | string | undefined> {
    return this.serialize(async () => {
      const db = copyDatabase(await this.read());
      const draft = this.drafts.get(id);
      const current =
        draft?.session ?? db.sessions.find((session) => session.id === id);
      if (
        !current ||
        (guard.token !== undefined && current.agentToken !== guard.token)
      )
        return undefined;
      const receipt = guard.receipt;
      const prior =
        receipt && (draft?.idempotency ?? db.idempotency)[receipt.key];
      if (prior) {
        if (prior.fingerprint !== receipt!.fingerprint)
          throw new Error('Idempotency key reused');
        return current;
      }
      if (guard.revision !== undefined && current.revision !== guard.revision)
        throw new Error('Stale quiz revision');
      const result = operation(current, this.sessionsIn(db));
      if (!result || typeof result === 'string') return result;
      const pendingDrafts = new Map(this.drafts);
      let durableChanged = false;
      for (const session of [result.session, ...(result.others ?? [])]) {
        const memory = pendingDrafts.get(session.id);
        if (memory) pendingDrafts.set(session.id, { ...memory, session });
        else {
          const index = db.sessions.findIndex((item) => item.id === session.id);
          if (index < 0) throw new Error('Quiz session disappeared');
          if (db.sessions[index] !== session) durableChanged = true;
          db.sessions[index] = session;
        }
      }
      if (guard.event || receipt) {
        const memory = pendingDrafts.get(id);
        const events = [
          ...(memory?.events ?? db.events[id] ?? []),
          ...(guard.event ? [sanitizeEvent(guard.event)] : []),
        ];
        const receipts = {
          ...(memory?.idempotency ?? db.idempotency),
          ...(receipt
            ? {
                [receipt.key]: {
                  fingerprint: receipt.fingerprint,
                  sessionId: id,
                  revision: result.session.revision,
                },
              }
            : {}),
        };
        if (memory)
          pendingDrafts.set(id, { ...memory, events, idempotency: receipts });
        else {
          db.events[id] = events;
          db.idempotency = receipts;
          durableChanged = true;
        }
      }
      // Publish disk state before touching any in-memory draft, including pooled updates.
      if (durableChanged) await this.write(db);
      this.drafts = pendingDrafts;
      return result.session;
    });
  }

  async rename(id: string, name: string): Promise<QuizSession | undefined> {
    return (await this.transact(id, (current) => ({
      session: { ...current, name },
    }))) as QuizSession | undefined;
  }

  async setScope(
    id: string,
    scope: QuizScope | undefined,
    at = new Date().toISOString(),
  ): Promise<QuizSession | undefined> {
    return (await this.transact(id, (current, sessions) =>
      changeQuizScope(current, scope, sessions, at),
    )) as QuizSession | undefined;
  }

  async transactMetadata(
    id: string,
    agentToken: string,
    update: (
      current: QuizSession,
      sessions: QuizSession[],
    ) => QuizSession | string,
  ): Promise<QuizSession | string | undefined> {
    return this.transact(
      id,
      (current, sessions) => {
        const next = update(current, sessions);
        return typeof next === 'string' ? next : { session: next };
      },
      { token: agentToken },
    );
  }

  async updateActivity(
    sessionId: string,
    agentToken: string,
    activity: NonNullable<QuizSession['activity']>,
  ): Promise<QuizSession | undefined> {
    return (await this.transact(
      sessionId,
      (current) => ({ session: { ...current, activity } }),
      { token: agentToken },
    )) as QuizSession | undefined;
  }

  async updateDraft(
    id: string,
    expectedRevision: number,
    update: (current: QuizSession) => QuizSession,
  ): Promise<QuizSession> {
    const result = await this.transact(
      id,
      (current) => ({ session: mergeDraftFields(current, update(current)) }),
      { revision: expectedRevision },
    );
    if (!result || typeof result === 'string')
      throw new Error('Quiz session disappeared');
    return result;
  }

  async update(
    operation: QuizRevisionChange,
    expectedRevision: number,
    event: QuizEvent,
    key: string,
    fingerprint: string,
    atCommit: (current: QuizSession, sessions: QuizSession[]) => QuizSession = (
      current,
    ) => current,
    alsoCommit: (
      current: QuizSession,
      sessions: QuizSession[],
    ) => QuizSession[] = () => [],
  ): Promise<QuizSession> {
    const result = await this.transact(
      operation.id,
      (current, sessions) => {
        const session = atCommit(
          applyQuizRevision(current, operation.changes),
          sessions,
        );
        return {
          session,
          others: alsoCommit(
            session,
            sessions.map((item) => (item.id === session.id ? session : item)),
          ),
        };
      },
      { revision: expectedRevision, event, receipt: { key, fingerprint } },
    );
    if (!result || typeof result === 'string')
      throw new Error('Quiz session disappeared');
    return result;
  }
}
