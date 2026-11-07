import type { QuizScope, QuizSession } from '../shared/quizProtocol';
import { learnerScopeKey } from './learnerStore';
/**
 * Resets mastered/retained nodes (all, or only `concepts`) to independent so
 * the tutor reclaims them against current evidence. Returns the same object
 * when nothing changes.
 */
function withdrawClaims(
  session: QuizSession,
  concepts: Set<string> | undefined,
  at: string,
): QuizSession {
  const map = session.lessonMap;
  if (!map) return session;
  const claimed = Object.keys(map.statuses).filter(
    (id) =>
      (map.statuses[id] === 'mastered' || map.statuses[id] === 'retained') &&
      (!concepts || concepts.has(id)),
  );
  if (!claimed.length) return session;
  const statuses = { ...map.statuses };
  for (const id of claimed) statuses[id] = 'independent';
  return {
    ...session,
    lessonMap: { ...map, statuses, version: map.version + 1, updatedAt: at },
  };
}

/** Fields owned by semantic revisions. Metadata has its own domain operations. */
type RevisionFields = Pick<
  QuizSession,
  | 'status'
  | 'agentToken'
  | 'revision'
  | 'eventCursor'
  | 'updatedAt'
  | 'awaitingAgent'
  | 'pendingLearnerCursor'
  | 'respondedThroughCursor'
  | 'currentQuestion'
  | 'currentPrompt'
  | 'transcript'
  | 'freeChatDraft'
>;
export type QuizRevisionChange = {
  id: string;
  changes: Partial<RevisionFields>;
};

/** Construct an explicit field change, excluding metadata the request never owned. */
export function quizRevisionChange(
  before: QuizSession,
  after: QuizSession,
): QuizRevisionChange {
  const changes: Partial<RevisionFields> = {};
  const fields: (keyof RevisionFields)[] = [
    'status',
    'agentToken',
    'revision',
    'eventCursor',
    'updatedAt',
    'awaitingAgent',
    'pendingLearnerCursor',
    'respondedThroughCursor',
    'currentQuestion',
    'currentPrompt',
    'transcript',
    'freeChatDraft',
  ];
  for (const field of fields)
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field]))
      Object.assign(changes, { [field]: after[field] });
  return { id: before.id, changes };
}

export function applyQuizRevision(
  current: QuizSession,
  changes: QuizRevisionChange['changes'],
): QuizSession {
  const next = { ...current, ...changes };
  // Agent output ends its reported phase; learner input retains current activity.
  if (
    next.status !== 'connected' ||
    (next.eventCursor > current.eventCursor && !next.awaitingAgent)
  )
    next.activity = undefined;
  return next;
}

/** Moving evidence between pools withdraws claims in the same atomic operation. */
export function changeQuizScope(
  current: QuizSession,
  scope: QuizScope | undefined,
  sessions: QuizSession[],
  at: string,
) {
  const { scope: _previous, ...rest } = current;
  let moved: QuizSession = scope
    ? { ...rest, scope: structuredClone(scope) }
    : rest;
  const from = learnerScopeKey(current.scope, current.id);
  const to = learnerScopeKey(moved.scope, moved.id);
  const others: QuizSession[] = [];
  if (from !== to) {
    moved = withdrawClaims(moved, undefined, at);
    const concepts = new Set(
      current.transcript.flatMap((message) =>
        message.question?.verdict
          ? (message.question.learning?.concepts ?? [])
          : [],
      ),
    );
    if (concepts.size)
      for (const other of sessions) {
        const pool = learnerScopeKey(other.scope, other.id);
        if (other.id === current.id || (pool !== from && pool !== to)) continue;
        const withdrawn = withdrawClaims(other, concepts, at);
        if (withdrawn !== other) others.push(withdrawn);
      }
  }
  return { session: moved, others };
}
