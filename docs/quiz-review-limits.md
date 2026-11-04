# Quiz review: feasibility and limits

Exploration of the local working tree, 2026-10-26. No production behavior changed.

## Recommendation

Start with an explicit **Review later** collection of durable questions and attempts.
Add a local due queue after defining grading, source retention, and item identity.
Use SQLite for long-lived review data; retain the existing agent session contract
while migrating its persistence separately. A database does not resolve missing
learning semantics or source provenance by itself.

## What exists and what is missing

- Questions have unique IDs, multiple question formats, submitted answers,
  optional agent verdicts, timestamps, and an optional source snapshot ID.
- Transcript and event history can support a best-effort missed-question list.
  Historical answers and feedback need joining by their surrounding question:
  answer/feedback events do not themselves carry a question ID.
- Verdict is optional. Missing verdict must mean ungraded, not incorrect.
  An agent verdict is an assessment, not a reliable measure of mastery.
- There is no durable review-item identity, versioned answer key/rubric, attempt
  entity, due date, scheduler version, or stable concept taxonomy.
- Replaying a question does not provide deterministic grading. The current API
  deliberately has no hidden answer-key contract; free responses require an
  available agent or learner self-assessment. Offline review can still show
  retained feedback after the learner attempts a question.
- Current question source basis is a snapshot ID, not a persisted set of exact
  chunk citations. The Pi extension's evidence verification is separate from
  the question/feedback write contract. Durable clickable evidence needs source,
  chunk, content hash, quote, and location persisted with the review item.

Relevant owners: `src/shared/quizProtocol.ts`, `src/main/quizService.ts`,
`src/shared/quizAgentContext.ts`, `extensions/storm.ts`.

## Reproduced retention limits

The retention probe uses the real StudyContextStore with temporary files and
minimal snapshots. It exercises store policy, not source-reading correctness.

1. Replacing a session's current question moves its pin to the new snapshot.
   After cache churn, the historical snapshot disappeared and the current one
   remained. A transcript retaining studyBasis does not retain its source text.
2. With 64 distinct pinned snapshots, saving a 65th failed with
   `STUDY_STORAGE_FULL`. Count is snapshots, not questions: questions may share
   a snapshot. Raising retention alone would collide with the byte limit.
3. After binding 100 distinct study scopes, binding the 101st failed with
   `STUDY_SCOPE_LIMIT`. Identical normalized scopes reuse a hashed ID. No scope
   cleanup operation currently exists in this store.
4. The independent byte ceiling is 32,000,000 bytes for the whole study store.
   Sources contain full text and chunk text, so captured text can be duplicated.
   A byte-capacity saturation experiment was not run.

Startup reconciliation rebuilds pins from current questions only. Durable review
references must become retention owners as well, including after restart.
The quiz and study stores are separate JSON files, so reference creation and
retention cannot currently commit as one cross-store transaction.

Other boundaries in `src/shared/studyContext.ts`: 2,000,000 bytes/source,
8,000,000 scan bytes, 64 notes/scan page, 10,000 indexed entries, and a
24,000-byte response budget. Retrieval retains at most four matching sources
per snapshot. These are coverage bounds, not a basis for topic mastery.
The study reader currently handles Markdown; PDF viewing does not supply a PDF
study reader. Quiz images are transient (one-hour registry TTL and no recovery
of the in-memory registry after restart), so image-based review needs durable
asset storage.

Relevant owners: `src/main/studyContextStore.ts`,
`src/main/studyContextService.ts`, `src/main/quizImageRegistry.ts`, `src/main.ts`.

## Storage experiment

Measured using the actual QuizStore in Electron 44.9.1 / Node 24.22.0,
macOS arm64. Each synthetic session contains 50 questions, each with a prompt,
two choices, learner answer, feedback, four events, and idempotency receipts.
Five draft updates and five activity updates per fixture, in alternating order.
All fixture data is synthetic and lives in a temporary directory removed at exit.

| Questions | Sessions | File MiB | Mean draft write ms | Mean activity write ms | Cold summary ms |
| --------: | -------: | -------: | ------------------: | ---------------------: | --------------: |
|       500 |       10 |     2.85 |                19.1 |                   18.4 |            16.4 |
|     5,000 |      100 |    28.56 |               212.4 |                  206.0 |            64.2 |
|    25,000 |      500 |   143.04 |             1,263.3 |                1,275.7 |           312.6 |

The 25,000-question draft-write range was 975.4–1,477.2 ms. Warm summary calls
were below 1 ms in these fixtures. Summary projection is useful but cannot remove
write amplification: updates clone the database, stringify it, write a complete
replacement, and invalidate the read cache. A subsequent read reparses history.
Draft autosave has a 350 ms debounce, not a maximum write frequency. If a learner
pauses often enough to trigger it, these writes compete with semantic operations
through the same store queue. At the largest fixture, each draft change rewrites
about 143 MiB; several successive changes can write hundreds of MiB.

This is one synthetic run, not a capacity certification or a UI freeze benchmark.
It excludes QuizService overhead, renderer IPC/rendering, grading latency, source
storage, cold OS caches, fsync durability, peak memory, and concurrent clients.
Async disk time is not all main-thread blocking, although cloning, parsing, and
stringifying are synchronous. Startup recovery also updates connected sessions
individually; its aggregate startup cost was not benchmarked.

To reproduce from the repository root:

```sh
bun proof/review-limits-2026-10-26/retention-probe.ts
bun build proof/review-limits-2026-10-26/storage-benchmark.ts --target=node --outfile=/tmp/storm-review-limits.mjs
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron /tmp/storm-review-limits.mjs
```

## Proposed product boundaries

**Review item:** a durable, versioned question with an independent ID, optional
originating session/question IDs, explicit concept IDs, prompt/choices, retained
feedback, optional rubric, evidence references, and availability state.

**Attempt:** an immutable submitted answer linked to the exact item version,
assessment method (agent/self), optional verdict and learner correction, and
submitted/graded timestamps. Keep ungraded attempts out of success rates.

**Schedule:** per-item due time and scheduler version, advanced once per accepted
graded attempt. Commit attempt, schedule change, and retry receipt together.
Only the application advances due dates; agents supply proposed content and
assessments. Retrying feedback or reconnecting must not count twice.

**Evidence:** retain deduplicated immutable source versions/chunks referenced by
items, independent of active quiz sessions. Show the saved passage and offer the
current file separately. Changed/deleted sources mark an item for checking;
opening a historical line number in today's file can silently show wrong text.
Renames require explicit reference mapping or stable document IDs. Deleting a
quiz should not silently delete review items; define deletion/export behavior.

**Progress:** begin with observable counts: attempted, correct, partial, ungraded,
and due. For topic summaries, use explicit stable topic IDs and separate coverage
from outcomes. Repeated success on the same wording is not evidence of broad
topic coverage; variants should reference a shared concept while keeping their
own question versions and attempts.

**Local schedule:** compute due items when opening Storm and on foreground/day
changes. The app can review existing items without an agent. Generating variants
or grading free responses needs an agent. Notifications while Storm is closed
require a separate OS integration; scheduling due dates does not require it.

## Delivery order and decision gates

1. Capture durable Review later items with evidence and explicit attempt records.
   Import old history as best effort; unavailable sources/grades stay marked.
   Do not silently regrade history or manufacture missing source citations.
2. Add a bounded daily due queue, learner overrides, suspend/archive, and an
   explicit simple interval policy. Treat intervals as product defaults, not
   validated memory estimates. Keep existing Continue behavior intact.
3. Add topic views and source-linked explanations once attribution is explicit.
4. Consider adaptive scheduling after enough clean, repeated attempt data exists.

For sustained review, SQLite makes indexed due queries and atomic attempt/schedule
updates straightforward. Avoid putting all history in one JSON column, or cloning
every row per write: those would preserve much of today's scaling problem.
Keep drafts and transient activity separate from immutable learning history;
paginate transcripts and send revision-based UI updates instead of repeatedly
shipping a growing active transcript.

Before migration ships, verify retry/restart correctness, source retention after
session deletion, successful recovery from interrupted migration, schema rollback
or backup, and foreign-key behavior. A proposed performance gate is draft saves
below 50 ms p95 and due-queue reads below 100 ms p95 at the intended history size,
measured in the packaged runtime; these targets are not current measurements.
