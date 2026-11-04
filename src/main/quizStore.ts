import { mkdir, readFile, rename, writeFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type {
  QuizEvent,
  QuizScope,
  QuizSession,
  QuizSessionSummary,
} from '../shared/quizProtocol';
import { quizAgentEvent } from '../shared/quizAgentContext';

export type QuizDatabase = {
  version: 1;
  sessions: QuizSession[];
  events: Record<string, QuizEvent[]>;
  idempotency: Record<
    string,
    { fingerprint: string; sessionId: string; revision: number }
  >;
};
function sanitizeEvent(event: QuizEvent): QuizEvent {
  return { ...event, data: quizAgentEvent(event).data ?? {} };
}

function preserveSessionMetadata(
  current: QuizSession,
  incoming: QuizSession,
): QuizSession {
  const { activity: _activity, scope: _scope, ...next } = incoming;
  // A posted agent response ends the phase it reported. Without this, a
  // missed idle report leaves "Drafting" up while the learner has the turn.
  const agentResponded =
    incoming.eventCursor > current.eventCursor && !incoming.awaitingAgent;
  const activity =
    incoming.status === 'connected' && !agentResponded
      ? current.activity
      : undefined;
  return {
    ...next,
    ...(activity ? { activity } : {}),
    ...(current.name !== undefined ? { name: current.name } : {}),
    // Scope is learner-owned metadata; an in-flight agent write must not revert it.
    ...(current.scope ? { scope: current.scope } : {}),
    // Keep whichever lesson map is newer (map updates commit outside revisions).
    ...((current.lessonMap?.version ?? 0) > (incoming.lessonMap?.version ?? 0)
      ? { lessonMap: current.lessonMap }
      : {}),
    ...((current.tutorNotes?.version ?? 0) > (incoming.tutorNotes?.version ?? 0)
      ? { tutorNotes: current.tutorNotes }
      : {}),
  };
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

/** Small versioned JSON store; each replacement is written beside the target then atomically renamed. */
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
  constructor(private readonly filePath: string) {}

  private async read(): Promise<QuizDatabase> {
    try {
      const info = await stat(this.filePath);
      const signature = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      if (this.cache?.signature === signature) return this.cache.database;
      const value: unknown = JSON.parse(await readFile(this.filePath, 'utf8'));
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
      if (legacyReceipts) await this.write(database);
      else this.cache = { signature, database };
      return database;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return emptyDatabase();
      throw error;
    }
  }

  private async write(database: QuizDatabase): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(database), {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporary, this.filePath);
      this.cache = undefined;
    } catch (error) {
      await import('node:fs/promises').then(({ unlink }) =>
        unlink(temporary).catch(() => {}),
      );
      throw error;
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
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
      const db = structuredClone(await this.read());
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
      const db = structuredClone(await this.read());
      if (db.sessions.some((item) => item.id === id))
        throw new Error('Duplicate quiz session');
      db.sessions.push(draft.session);
      db.events[id] = draft.events;
      Object.assign(db.idempotency, draft.idempotency);
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
      const db = structuredClone(await this.read());
      if (db.sessions.some((item) => item.id === session.id))
        throw new Error('Duplicate quiz session');
      db.sessions.push(session);
      db.events[session.id] = [];
      await this.write(db);
    });
  }
  async deleteSession(id: string): Promise<void> {
    return this.serialize(async () => {
      if (this.drafts.delete(id)) return;
      const db = structuredClone(await this.read());
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

  async rename(id: string, name: string): Promise<QuizSession | undefined> {
    return this.serialize(async () => {
      const draft = this.drafts.get(id);
      if (draft) {
        draft.session = { ...draft.session, name };
        return draft.session;
      }
      const db = structuredClone(await this.read());
      const session = db.sessions.find((item) => item.id === id);
      if (!session) return undefined;
      session.name = name;
      await this.write(db);
      return session;
    });
  }

  /** Metadata-only scope change; leaves revisions and events untouched like rename. */
  async setScope(
    id: string,
    scope: QuizScope | undefined,
  ): Promise<QuizSession | undefined> {
    return this.serialize(async () => {
      const apply = (session: QuizSession): QuizSession => {
        const { scope: _previous, ...rest } = session;
        return scope ? { ...rest, scope: structuredClone(scope) } : rest;
      };
      const draft = this.drafts.get(id);
      if (draft) {
        draft.session = apply(draft.session);
        return draft.session;
      }
      const db = structuredClone(await this.read());
      const index = db.sessions.findIndex((item) => item.id === id);
      if (index < 0) return undefined;
      db.sessions[index] = apply(db.sessions[index]!);
      await this.write(db);
      return db.sessions[index];
    });
  }

  /** Metadata-only write (lesson map, tutor notes) by the attached agent. */
  async setLessonMap(
    id: string,
    agentToken: string,
    update: (current: QuizSession) => QuizSession | string,
  ): Promise<QuizSession | string | undefined> {
    return this.serialize(async () => {
      const draft = this.drafts.get(id);
      if (draft) {
        if (draft.session.agentToken !== agentToken) return undefined;
        const next = update(draft.session);
        if (typeof next === 'string') return next;
        draft.session = next;
        return next;
      }
      const db = structuredClone(await this.read());
      const index = db.sessions.findIndex((item) => item.id === id);
      if (index < 0 || db.sessions[index]!.agentToken !== agentToken)
        return undefined;
      const next = update(db.sessions[index]!);
      if (typeof next === 'string') return next;
      db.sessions[index] = next;
      await this.write(db);
      return next;
    });
  }

  async updateActivity(
    sessionId: string,
    agentToken: string,
    activity: NonNullable<QuizSession['activity']>,
  ): Promise<QuizSession | undefined> {
    return this.serialize(async () => {
      const draft = this.drafts.get(sessionId);
      if (draft) {
        if (draft.session.agentToken !== agentToken) return undefined;
        draft.session = { ...draft.session, activity };
        return draft.session;
      }
      const db = structuredClone(await this.read());
      const index = db.sessions.findIndex((item) => item.id === sessionId);
      if (index < 0 || db.sessions[index]!.agentToken !== agentToken)
        return undefined;
      db.sessions[index] = { ...db.sessions[index]!, activity };
      await this.write(db);
      return db.sessions[index];
    });
  }

  async updateDraft(
    session: QuizSession,
    expectedRevision: number,
  ): Promise<QuizSession> {
    return this.serialize(async () => {
      const draft = this.drafts.get(session.id);
      if (draft) {
        if (draft.session.revision !== expectedRevision)
          throw new Error('Stale quiz revision');
        draft.session = mergeDraftFields(draft.session, session);
        return draft.session;
      }
      const db = structuredClone(await this.read());
      const index = db.sessions.findIndex((item) => item.id === session.id);
      if (index < 0) throw new Error('Quiz session disappeared');
      const current = db.sessions[index]!;
      if (current.revision !== expectedRevision)
        throw new Error('Stale quiz revision');
      const updated = mergeDraftFields(current, session);
      db.sessions[index] = updated;
      await this.write(db);
      return updated;
    });
  }

  async update(
    session: QuizSession,
    expectedRevision: number,
    event: QuizEvent,
    key: string,
    fingerprint: string,
  ): Promise<QuizSession> {
    return this.serialize(async () => {
      const draft = this.drafts.get(session.id);
      if (draft) {
        const prior = draft.idempotency[key];
        if (prior) {
          if (prior.fingerprint !== fingerprint)
            throw new Error('Idempotency key reused');
          return draft.session;
        }
        if (draft.session.revision !== expectedRevision)
          throw new Error('Stale quiz revision');
        draft.session = preserveSessionMetadata(draft.session, session);
        draft.events.push(sanitizeEvent(event));
        draft.idempotency[key] = {
          fingerprint,
          sessionId: session.id,
          revision: session.revision,
        };
        return draft.session;
      }
      const db = structuredClone(await this.read());
      const index = db.sessions.findIndex((item) => item.id === session.id);
      if (index < 0) throw new Error('Quiz session disappeared');
      const prior = db.idempotency[key];
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new Error('Idempotency key reused');
        // A matching receipt means the action already committed. Acknowledge it
        // with the latest state rather than reapplying it or retaining old snapshots.
        return (
          db.sessions.find((item) => item.id === prior.sessionId) ?? session
        );
      }
      if (db.sessions[index].revision !== expectedRevision)
        throw new Error('Stale quiz revision');
      // Keep metadata-only edits (such as a session rename) made after the
      // caller read its snapshot when committing a semantic revision update.
      const updatedSession = preserveSessionMetadata(
        db.sessions[index],
        session,
      );
      db.sessions[index] = updatedSession;
      (db.events[session.id] ??= []).push(sanitizeEvent(event));
      db.idempotency[key] = {
        fingerprint,
        sessionId: session.id,
        revision: session.revision,
      };
      await this.write(db);
      return updatedSession;
    });
  }
}
