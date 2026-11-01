# Additional connected-agent performance findings

Historical findings. See the [implemented repair and verification](connected-agent-fix-result.md). Original negative assertions are archived as `.diagnostic.ts` files; maintained regression tests now live with the implementation.

Investigated 2026-10-25 against the current working tree. This is investigation evidence and proposed work, not shipped behavior. Existing production edits were left untouched. Performance here includes response correctness, conversational reliability, avoidable model retries, and local latency. No model was called, so these results do not measure model accuracy, token counts, or production incidence rates.

## Highest-priority live-path failures

### 1. Responses are not bound to the learner turn or quiz they address

**Impact:** an older model turn can publish a response after a newer learner request arrives, without a stale-revision rejection. A queued notification can also outlive a change of attached quiz and supply context for a response sent to the newly attached quiz.

`extensions/storm-quiz.ts:234` updates the adapter's shared revision as soon as the waiter receives an event. If Pi is busy, delivery uses a queued follow-up. The old model turn can still call `storm_quiz`; the adapter supplies the latest revision at `:578`, even though that turn has not processed the new follow-up. Revision compare-and-swap protects the state observed by the adapter, not the context observed by the model.

Reproduction: attach exposes revision 8, then learner activity at revision 9 is queued as `followUp`. A response from the old turn is submitted with `expectedRevision:9`. The production adapter makes that substitution silently. This test establishes the submitted payload; it does not claim the backend would accept every action regardless of its state rules.

Additionally, `learnerNotification()` includes events and usually the current question, but no session identity or attachment generation. `stop()` prevents future delivery from stale owners, but cannot retract an already queued Pi user message. `storm_quiz` always targets the currently attached session. A controlled session-switch test shows an old quiz notification stays queued while a later tool call targets the new quiz.

**Repair:** include session identity and event provenance in notifications; bind submissions to a model-observed session/interaction/event cursor or turn context. Reject mismatches rather than stamping the current revision onto old content. Invalidate outstanding delivery contexts on reattach, and make fresh attachment reconcile queued old-session messages. Keep existing revision guards as an additional check.

### 2. A temporary listener error stops learner-event delivery indefinitely

**Impact:** the learner keeps talking, but Pi receives no new turns. This can look like a model that is stuck or ignoring the learner.

`createWaitRuntime()` stops on subprocess/parse errors (`extensions/storm-quiz-runtime.ts:227`). The extension's `onError()` only sets a local string (`storm-quiz.ts:215`). It does not automatically notify the user/model or schedule a bounded restart. The command and tool status paths do not restart the waiter, despite the error string saying “use status or reconnect.” The model status response does not include listener health either.

Reproduction: fail the first wait once, restore the synthetic transport, then invoke both status paths. Exactly one wait was started, and the pending learner event is never delivered. The failure becomes visible in the slash status UI only when the user explicitly asks for status.

**Repair:** expose listener health, issue a single actionable failure notification, and retry confirmed transient transport failures with bounded backoff and cancellation. Restart only from the last safely delivered cursor; do not create duplicate waiters. Keep revocation/deletion handling distinct from transport retry. A status-driven recovery should actually rearm, or its instructions should stop promising that effect.

### 3. Image events can arrive out of order, and unrelated replies release images

**Impact:** a model can see a learner's second message before the first image message, or receive a queued image path after the corresponding image has been released. This directly weakens multimodal reasoning and follow-up interpretation.

The waiter invokes `void deliverLearnerEvents(...)` at `storm-quiz.ts:248` and immediately rearms. Image delivery awaits one or more CLI lookups before `sendUserMessage()` at `:330`. A later text-only event can therefore reach Pi first. Cursor order and enqueue order differ.

Image cleanup also uses every entry in `active.deliveredImages`, captured when any non-status action executes (`:541`). A successful action releases those images (`:589`) without proving the responding model turn read them. An old turn's unrelated chat reply can release an image attached to a queued follow-up.

Reproductions: delaying the first image lookup delivers event 5 before event 4; separately, a busy Pi turn replies to an earlier topic and releases an image in its pending follow-up.

**Repair:** serialize notification preparation/enqueueing within each session generation, while allowing source reads to run concurrently when their final enqueue order is preserved. Track image ownership per delivered event/turn and release only images acknowledged by the response handling that event. Carry explicit missing-image status into the model notification if retrieval fails, rather than reporting that only in the UI.

## Additional confirmed quality and efficiency defects

### 4. Learner-controlled progression is a prompt rule rather than a runtime gate

**Impact:** the agent can replace the current question immediately after feedback, skipping the learner's chance to ask about the explanation or press Continue. The loss occurs even if the writing prompt asks for careful pacing.

`QuizService` permits `pose-question` whenever the existing question has status `feedback` (`src/main/quizService.ts:366`). It does not require an intervening Continue. A service diagnostic performs question, answer, feedback, then another question; all actions succeed, and the event history contains no Continue.

**Repair:** after feedback, block a new question until a validated learner Continue clears the pending interaction, including structured choices whose explicit effect is Continue. Distinguish an initial question from advancing an existing question. Preserve clarification/chat access while waiting.

### 5. Valid learner data can be corrupted before the model sees it

Two independent mechanisms were reproduced:

- **Unicode socket decoding:** `sendAgentRequest()` decodes each incoming chunk independently with `chunk.toString()` (`src/main/agentEndpoint.ts:188`). UTF-8 code points may span socket chunks. Splitting the bytes of `é` across two writes returns `caf�� 🧠` instead of `café 🧠`, with valid JSON and no reported error. Use a streaming decoder or parse complete buffered bytes, and test arbitrary byte boundaries. This affects all CLI responses using this transport; the observed rate in normal operation is unknown.
- **Matching-map redaction:** the store recursively removes object keys matching secret-related words (`src/main/quizStore.ts:21`), including user-defined map IDs. An accepted matching answer `{author:writer, token:symbol}` loses `token` from its stored event. The adapter's broader `/auth/` rule additionally strips `author` from both the event and `matchesDraft` (`storm-quiz-runtime.ts:24`). The model receives empty mappings even though the full submission was valid. Use schema-specific capability removal, and treat learner-defined map keys as data. Do not remove genuine authentication controls when making this correction.

### 6. Open answer drafts leak into model context before submission

**Impact:** an agent may respond to an unfinished answer, infer a misconception the learner was still revising, or use an unsubmitted selection as evidence. The protocol labels the question `open`, so this is an input-contract risk rather than proof the model will always misinterpret it.

`saveDraft()` puts unsent text, reasoning, selections, and matching mappings on the current question. `modelSession()` and `learnerNotification()` forward that question without separating drafts from submitted fields. A learner who types an unfinished long answer and sends a separate clarification exposes that draft with the clarification event. A production-service diagnostic confirms there was no submitted answer event.

**Repair:** project questions according to submission status. Expose exact submitted content from submitted events; omit unsent draft fields from agent-facing context. Keep drafts available to the learner UI and persistence workflow.

### 7. The model-facing tool contract omits important constraints and recovery information

**Impact:** otherwise reasonable model output can fail with an opaque exit code, causing retries, unnecessary shortening, or abandoned responses. Some supported interactions are not expressible through the declared tool schema.

The `storm_quiz` schema accepts arbitrary-length optional `text`, all kinds, and optional action-specific fields (`storm-quiz.ts:446`). Backend limits include 4,000-character question/prompt text and 10,000-character feedback/chat. The choices schema only exposes `id` and `text`, omitting the supported `effect:"continue"` field.

The extension parses JSON stderr when a child exits nonzero but drops ordinary CLI usage errors. A diagnostic runs a 4,001-character clarification through the actual CLI parser: the model receives only `Storm CLI exited with 2.` It is not told the constraint or how to repair the request. Question length is checked later in the broker, so error behavior also differs by action.

**Repair:** define discriminated action schemas with required fields and actual limits; expose supported choice effects and validate them consistently. Return concise typed errors with safe field-specific details and current state where useful. Keep raw stderr and capabilities private.

Related retry gap: each execute call generates a new idempotency key (`:579`). After an uncertain response, an identical retry cannot reuse the original operation identity. The diagnostic confirms different keys; it does not establish automatic duplicate writes, because unchanged stale revisions can prevent them. Retain logical-operation identity across recovery and reconcile before retrying.

### 8. Idle polling repeatedly transfers complete histories

**Impact:** long sessions create avoidable local I/O, parsing, serialization, and socket traffic even while the learner is idle. Each poll can add up to roughly one second of detection delay, plus processing. This is separate from model token cost: Pi removes most history before model delivery.

`storm quiz wait` repeatedly requests snapshots and sleeps for up to one second (`scripts/storm.ts:726`). `after` filters events only. The session's complete transcript is still returned on every poll. For persisted sessions, `getSnapshot()` calls `store.get()` and `store.events()`, each of which reads/parses the JSON database. That database contains other saved sessions too; activity updates also rewrite it. Costs therefore depend on total saved history, not just new events.

The synthetic benchmark seeds histories with 1,110 characters per message and requests idle snapshots with zero new events. The 1,000-message snapshot is 1,192,215 bytes; the 5,000-message snapshot is 5,964,215 bytes. At a nominal one poll per second, the former is approximately 4.29 GB of local response data per hour. This is an arithmetic traffic estimate, not measured hourly disk throughput or model usage. Real cadence includes request latency.

Seven warm trials measured service-plus-serialization medians of 0.51 ms, 3.44 ms, and 17.98 ms for 100, 1,000, and 5,000 messages on this machine. These exclude socket, CLI parsing, and model time and will vary between runs. The data establishes avoidable scaling, not an immediate performance crisis in short sessions.

**Repair:** separate event waiting from recovery snapshots. Use a bounded event response with listener health, revision/cursor, and only the current interaction changes. Add server-side long polling or push delivery; retain paginated history for deliberate recovery. Avoid repeated full database parse/rewrite for operational telemetry. Do not put full history into every model turn as a workaround.

## Suggested order of repair

First bind output to the correct session/learner events and preserve delivery/image ownership. Then recover failed listeners and enforce Continue. Correct Unicode decoding and matching-data redaction alongside those changes, since they are independently testable input-integrity bugs. Next tighten the tool schema/errors, remove unsent drafts, and address the previously investigated bounded context recovery. Optimize idle transport before large or many saved sessions become common.

Adding researcher/writer roles would not fix these defects: workers would inherit wrong, missing, stale, or corrupted inputs and could encounter the same submission errors. Stabilize this boundary before evaluating role-based improvements.

## Evidence and verification scope

- `proof/connected-agent-live-path.diagnostic.ts`: eight diagnostic tests exercise the production extension registration, command/tool handlers, waiter, and subprocess integration against a controlled synthetic CLI. Typebox alone is replaced by a recording schema builder. One case invokes the real CLI parser to establish the opaque usage error. No Pi model loop is simulated beyond recording queued follow-ups; tests demonstrate the missing bindings, not model behavior or occurrence rates.
- `proof/connected-agent-data-quality.diagnostic.ts`: four diagnostics use the production service/store/projection and a real temporary socket. They reproduce Continue bypass, unsent drafts, matching-map loss, and split-byte corruption.
- `proof/quiz-snapshot-benchmark.ts` and `.json`: reproducible synthetic service/serialization benchmark and captured results, using temporary files.
- These diagnostics deliberately assert existing failures. Passing means a defect was reproduced; they should become desired-behavior regression tests when implementing repairs.

No production code was changed. Existing unrelated worktree edits were preserved. The investigation does not claim live Pi UI, model quality, vision support, or production workload benchmarks were tested.

Verification: all 75 tests passed across the two new diagnostic files, the prior recovery diagnostics, and the existing runtime, synthetic extension integration, service, store, and handler suites. The three new TypeScript files passed Oxlint; all five new artifacts passed formatting checks.
