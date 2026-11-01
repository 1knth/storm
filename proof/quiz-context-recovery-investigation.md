# Pi quiz continuity investigation

Historical findings. See the [implemented repair and verification](connected-agent-fix-result.md). Original negative assertions are archived as `.diagnostic.ts` files; maintained regression tests now live with the implementation.

Investigated 2026-10-25 against the current working tree. This document records findings and a proposed repair. It does not describe shipped recovery behavior.

## Finding

Storm preserves conversation text and structured events, and its CLI exposes them. The optional Pi adapter intentionally projects that response down to six session fields. History is therefore present in the adapter process but unavailable through its model-facing attach/status surfaces. This is a recovery gap, not proof that an ongoing Pi conversation forgets its history.

Two further gaps affect action continuity: pending structured prompts are excluded, and old learner events are skipped on attach. Disconnect also clears the existing `awaitingAgent` flag, so merely exposing that flag would not recover unfinished learner requests reliably.

## Exact data path

1. `QuizService.getSnapshot()` returns the session and events after a cursor (`src/main/quizService.ts:186`). `attachSessionExclusive()` returns the saved session and all stored events (`:209`). The session includes its transcript, current question, current prompt, and awaiting state.
2. `publicSession()` removes the capability, retaining the other session fields. `publicSnapshot()` retains events (`src/main/quizAgentHandler.ts:9`). The CLI uses these responses. The omission is not imposed by the public transport.
3. The Pi command retains the full session in `state.snapshot` but calls `attachPrompt(snapshot.session)` (`extensions/storm-quiz.ts:670`). That function serializes `modelSession(session)`.
4. `modelSession()` allows only `id`, `revision`, `eventCursor`, `status`, `scope`, and `currentQuestion` (`extensions/storm-quiz-runtime.ts:7`). It excludes transcript, current prompt, and awaiting state. Attach response events are not included in the model prompt.
5. The model-callable `storm_quiz({action:"status"})` fetches a fresh CLI snapshot but returns the same projection (`extensions/storm-quiz.ts:500`). Returned events are discarded from that tool response.
6. The slash command `/storm-quiz status` is different: it only displays cached revision/cursor/listener information as a UI notice (`:609`). It neither fetches recovery context nor supplies history to the model.
7. Attach initializes the listener cursor to the snapshot's latest event cursor and starts waiting there (`:660`, `:676`). Earlier events are not replayed. This avoids duplicate event delivery but leaves recovery dependent on the attach snapshot.

## Reproduced cases

`proof/quiz-context-recovery.diagnostic.ts` exercises the production service, store, public handler, and projection functions using synthetic temporary sessions. Its five tests intentionally assert the current gaps; they are investigation evidence, not desired-behavior regression tests.

### Unanswered tutoring message

The learner sends “Why does this formula apply?” and the agent disconnects before replying. The message remains in transcript and events. On detach, `awaitingAgent` becomes false (`quizService.ts:891`). Reattach returns that history to the adapter, but the model-facing projection contains no question and no message. A wait beginning at the new attach cursor returns no events. The model cannot recover what it was supposed to explain from these surfaces.

### Pending clarification or next-step choice

The agent poses “Which part should we revisit?” with a structured “Explain the units” choice. Storm keeps the full prompt and choice IDs in `currentPrompt`, but Pi hides that field. The transcript entry stores the prompt text without its choices; transcript alone would not reconstruct the interaction. The model could attempt another prompt and receive a state error, or misunderstand what the learner later selected.

### Submitted answer and feedback

Recovery is better here than my initial summary suggested. The current question survives projection, including its choices, submitted selection/reasoning or text/matches, status, feedback, and verdict when present. A fresh agent can usually identify that the current answer needs feedback. Earlier discussion, examples, and learner constraints still disappear from the model-facing snapshot.

Question fields also hold unsent UI drafts while the question is open. A recovery projection must use question status and submitted events to distinguish drafts from submitted answers, rather than treating every nonempty draft field as learner activity.

### Explicit Continue before interruption

Continue clears `currentQuestion` and emits an event, but does not add a transcript message (`quizService.ts:612`). After a restart, the transcript survives; the Continue event survives; the awaiting flag has been cleared by startup disconnection. Pi exposes neither transcript nor event and starts waiting after both. `currentQuestion:null` cannot distinguish this state from a new session with no question yet. Adding only recent transcript messages would still miss this authorization.

### Restart persistence

The diagnostic recreates `QuizService` and `QuizStore` from their temporary JSON file. History/events survive and connected state becomes disconnected before reattach. This establishes backend persistence for a session with transcript content. Empty sessions are initially memory-only drafts until promotion, so this does not establish persistence for an unused new session.

## Where the impact applies

- Same Pi conversation, no context loss: prior prompts, learner notifications, and the agent's own tool calls may supply the missing context. The omission does not automatically break each turn.
- Fresh Pi conversation or provider/host handoff: these surfaces cannot reconstruct the discussion. Session switch/shutdown handlers detach the adapter; they do not transfer a recovery record into a different conversation.
- Compaction: the extension contains no explicit recovery-context injection hook. Actual forgetting depends on Pi's compaction and retained messages; this investigation did not reproduce a live Pi compaction failure. If context is missing, current status cannot restore it.
- Manual CLI clients: they receive more information than Pi. A client could independently reconstruct history from raw status, but that does not make the supported private Pi tool's recovery complete. Exposing the capability to the model to work around this would undermine the current separation.

## Proposed bounded recovery contract

Keep ordinary learner notifications incremental. Add a dedicated, model-safe recovery projection at attach and on explicit recovery requests. Include the pending structured prompt in normal status too. Use field allowlists rather than serializing the full session, and exclude session capabilities, temporary paths, and unsent learner drafts.

The recovery projection should contain:

- Session identity, semantic revision, and the event cursor through which this context was assembled.
- Current scope and submitted current-question state, including feedback and verdict when applicable.
- Pending prompt ID, kind, prompt text, choice IDs/text, and explicit Continue effects. Omit draft selections/details.
- A bounded recent conversation window, with exact message IDs, roles, text, and source references where recorded. Include structured question/answer context so a bare answer remains interpretable.
- Relevant recent submitted learner events and action state, especially explicit Continue and responses to structured prompts. Preserve exact submitted text/reasoning separately from any generated summary.
- An explicit incomplete-history indicator, included range, omitted counts, and a continuation cursor for older context.

A practical initial budget is up to 12 complete conversational entries within 24,000 UTF-8 bytes, plus a separately bounded current interaction. These are proposed starting values to evaluate, not existing limits. A message-count cap alone is insufficient because text answers can be large. If an interaction exceeds budget, identify the omitted content and permit chunked retrieval; never present truncated material as a complete learner submission. Bound fields outside the conversation window too, including prompts, choices, and scope lists.

Expose older context through a private `storm_quiz` history/recovery action that retains the capability inside the extension. Prefer cursor-based ranges to unstable array offsets. An initial Pi-only implementation could page its cached full snapshot for model output, but the CLI would still transfer unbounded snapshots. True transport bounds require service/CLI pagination or a dedicated recovery operation: the current `after` parameter filters events only, not the session transcript.

## Recover work without replaying it

Do not rewind the live waiter to zero. Historical events should be labeled recovery context, not sent as fresh learner activity, or the agent may repeat feedback and questions.

Track incoming event position separately from response acknowledgment. The adapter currently has a delivery cursor, while the service has no durable explicit association between a learner event and the agent output handling it. `awaitingAgent` is a transient UI indicator, reset on disconnect, and any accepted agent content clears it. It is not a durable processing receipt.

For a first repair, derive a conservative pending-action hint from current interaction state and ordered events: submitted answer awaiting feedback, structured choice awaiting handling, learner chat awaiting reply, explicit Continue awaiting a new question, or waiting on the learner. Include the supporting event IDs/cursors. Label uncertainty when attribution is ambiguous, especially with multiple learner messages or agent messages interleaved with feedback.

For stronger recovery, add a durable response acknowledgment keyed to the handled learner event(s), committed atomically with agent output. Detach can clear UI activity while preserving the unfinished-work record. Tie resumed writes to the current semantic revision; a recovery snapshot must never authorize an action after newer learner activity or a session change. This requires a protocol extension, rather than exposing an extra existing boolean.

Attach should tell the tutor to reconcile recovered state before acting. It should resume supported pending work, preserve the explicit Continue requirement, and wait when the learner is choosing or answering. Reattachment itself does not mean the learner requested a new question.

## Limits and next implementation scope

Text recovery cannot restore document extractions, teaching plans, or source coverage that were never stored in Storm. It also cannot restore expired/released image bytes: history persists attachment metadata only, and the image registry is transient. Recovery should identify unavailable attachments accurately and request them again only when necessary.

The smallest useful implementation spans `storm-quiz-runtime.ts` (projection and recovery prompt), `storm-quiz.ts` (attach/status/history delivery), and focused runtime/integration tests. Pending-work durability and transport pagination are separate service/protocol work. Neither needs a researcher or writer subagent to fix the immediate projection gap.

Acceptance checks should cover fresh attach, same-conversation reattach without duplicate replies, unanswered chat, each answer type, pending prompts, Continue before interruption, model-context recovery, large histories with explicit truncation, older-page retrieval, unsent drafts, capability exclusion, unavailable images, and stale revisions. Convert diagnostic assertions to desired behavior as each fix lands.

## Verification

The five diagnostic cases, 16 existing runtime tests, and 42 existing service, store, public handler, and synthetic extension integration tests passed (63 total). The new diagnostic file passed Oxlint, and both new files passed formatting checks. No production runtime files were changed and no real learner sessions were accessed. Live Pi UI behavior and compaction were not tested.
