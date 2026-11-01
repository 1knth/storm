# Shared study context for Storm and Tutor

Status: design record, 2026-10-25. The first Markdown implementation is now in the checkout. See [supported behavior](../docs/SHARED-STUDY-CONTEXT.md) and [implementation results](shared-study-context-result.md). This document also contains proposed later work; its illustrative command syntax is not the supported CLI contract. The implemented CLI uses `study --stdin` JSON requests. Richer readers, background watcher subscriptions, rename-stable identities, and the learning ledger remain future work. Storm continues to use external teaching agents.

## Outcome and first deliverable

Selecting notes or a folder in Storm should give Tutor a small, accurate map of the study materials and a way to retrieve relevant content. A research or drafting worker should receive the same source versions and citations as Tutor. After an edit, reconnect, or session switch, the system should identify which context is current without replaying learner actions or silently replacing a question's basis.

The first deliverable is a working Markdown flow, not just another prompt: **selected scope → shared tree/outline → versioned source retrieval → Tutor response → worker handoff validation → change/reconnect recovery**. Add attachment readers and richer learning evidence after this works.

## Baseline after the verified architecture refactor

The architecture refactor has been verified, as recorded in [the architecture review](../docs/architecture-review-2026-10-25.md). Finishing that refactor is no longer a prerequisite. The first shared-context implementation extends its existing boundaries as a separate feature; earlier agent-reliability fixes also remain in this worktree. See the implementation result for the new feature's own checks and limits.

Reuse metadata-only `listNotes({ previews: false })`, shared bridge validation/renderer authorization, and the existing mutation/lifecycle coordinators. Metadata enumeration is not yet a shared index: source revisions, heading/link indexes, caching, and snapshot identity are still required. Preserve capability negotiation for the installed app, bundled CLI, and Pi extension; verification of this worktree does not establish that those installed components are synchronized.

## Existing seams to reuse

| Existing code                                                                      | Reuse                                                                                  | Gap to address                                                                            |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `src/main/vaultDiscovery.ts`                                                       | Bounded search, link traversal, unresolved-link reporting                              | Uses saved files; repeats enumeration/content reads; has no shared revisioned index       |
| `src/vault/vaultNoteResolver.ts`                                                   | The same relative/root/unique-basename resolution as note navigation                   | Do not introduce a competing resolver with different ambiguity rules                      |
| `src/vault/vaultService.ts:listNotes({ previews: false })`                         | Metadata-only enumeration with existing filesystem/type conventions                    | Add revisions, indexing, and caching; reuse enumeration rules without another crawler     |
| `src/main/agentBroker.ts:inspect` and `src/documents/agentDocumentHost.ts:inspect` | Read the live open document, or disk when unopened, without creating a writing session | Factor a reusable read-only source port; return exact content fingerprints and origin     |
| `src/vault/vaultWatcher.ts` and `src/main.ts:watchSelectedVault`                   | Debounced invalidation                                                                 | Only the selected vault is watched; no per-file change batch or live-buffer notifications |
| `src/shared/quizAgentContext.ts`                                                   | Bounded conversation recovery and submitted learner evidence                           | Study sources are a separate context domain, currently represented only by scope paths    |
| `extensions/storm-quiz.ts`                                                         | Private attachment ownership, ordered delivery, response contexts                      | Add a separate read-only study tool and bounded study bootstrap                           |

Keep the current saved-note writer and explicit Continue gate. Source reads must not call `connect`, create notes, trigger a save, select a different vault, or change editor focus.

## Ownership and terminology

Introduce an app-owned `StudyContextService`. It composes three responsibilities with separate storage boundaries:

1. A rebuildable **source index**, owned by vault services: scoped files, headings, explicit links, source versions, and extraction availability.
2. Immutable **study snapshots**, owned by the context service/store: the exact source versions supplied to a Tutor turn or worker.
3. A small **session binding**, owned by the context service: selected scope and the current snapshot reference for a particular quiz/study session.

CodeMirror remains the owner of live note text. The index and snapshots are read models, not a second editable document. QuizService remains the owner of learner interaction. An optional learning ledger later owns observations about attempts; it must not be inferred from the source index.

The note tree describes containment, headings, and explicit links. A link is not automatically a prerequisite, causal relation, or teaching order. A note being indexed, explained, or visited is not evidence that the learner understands it. Any later model-proposed concept relationship needs a separate type, provenance, and review state.

## Scope and navigation rules

- Translate the existing `QuizScope` into an explicit read selector: one note, selected notes, or a folder subtree. Do not substitute the active tab when a session already has a scope.
- An unscoped session has no implicit vault scan. Use already supplied material or obtain a study selection through the existing learner interaction when needed.
- Return a collapsed tree rooted at that selection. Discover scoped ancestors/children and explicit outgoing links; backlinks are reported only to the extent the permitted index has been built. Mark partial indexes honestly.
- Resolve links with the existing vault rules. Resolution may need a vault-wide filename index internally to detect basename ambiguity; model-visible results remain scoped. A target outside the study selection is an out-of-scope reference, not permission to retrieve its contents. Widen scope only through an explicit learner instruction/selection.
- Keep source roles separate from location: instructor material, learner notes, supplemental, or unclassified. A filename such as `Lecture.md` does not establish authority. Record course/assessment scope as confirmed, excluded, or unknown where supplied; do not infer an exam syllabus from partial notes.
- All reads revalidate registered-vault membership, canonical containment, file type, and scope. Reuse existing symlink/path protections and lifecycle coordination. A snapshot ID is a public reference, not an authorization capability. This API boundary does not sandbox an arbitrary local shell.

## Proposed contracts

Add browser-safe types in `src/shared/studyContext.ts`. The following is a contract sketch; the implementation should use validated discriminated request schemas and versioned stored records.

```ts
type StudyScope = {
  vaultId: string;
  selector:
    | { kind: 'note'; path: string }
    | { kind: 'notes'; paths: string[] }
    | { kind: 'folder'; path: string };
};

type StudySource = {
  sourceId: string;
  path: string; // normalized vault-relative path
  title: string;
  format: 'markdown' | 'pdf' | 'image' | 'docx' | 'pptx' | 'csv' | 'other';
  role:
    | 'instructor'
    | 'learner-notes'
    | 'study-reference'
    | 'supplemental'
    | 'unclassified';
  roleBasis: 'learner-confirmed' | 'source-evidence' | 'unknown';
  assessmentScope: 'confirmed' | 'excluded' | 'unknown' | 'not-specified';
};

type StudyTreeNode = {
  nodeId: string;
  parentId: string | null;
  kind: 'folder' | 'source' | 'heading';
  label: string;
  sourceId?: string;
  locator?: SourceLocator;
};

type StudyLink = {
  fromSourceId: string;
  at: SourceLocator;
  target: string;
  targetSourceId?: string;
  resolution: 'resolved' | 'missing' | 'ambiguous' | 'outside-scope';
};

type SourceVersion = {
  sourceId: string;
  contentHash: string; // exact captured bytes; never just mtime
  origin: 'disk' | 'editor';
  diskRevision?: string;
  editorEpoch?: string;
  documentVersion?: number;
};

type SourceLocator =
  | {
      kind: 'markdown';
      headingPath: string[];
      occurrence: number;
      startLine: number;
      endLine: number;
    }
  | { kind: 'pdf'; page: number; region?: string }
  | { kind: 'slides'; slide: number; part: 'body' | 'notes' | 'visual' }
  | { kind: 'table'; sheet?: string; rows: [number, number]; columns: string[] }
  | { kind: 'document'; section: string[]; paragraph?: number; table?: number };

type StudyChunk = {
  chunkId: string; // source version + locator + chunk bytes
  sourceId: string;
  contentHash: string;
  locator: SourceLocator;
  text: string;
  completeness: 'section' | 'excerpt' | 'continuation';
};

type StudySnapshot = {
  schemaVersion: 1;
  snapshotId: string;
  studyId: string;
  scopeHash: string;
  indexRevision: string; // process epoch + monotonic index generation
  capturedAt: string;
  sources: SourceVersion[];
  chunkingVersion: string;
  coverage: StudyCoverage; // source-capture/extraction coverage at creation
  issues: StudyIssue[]; // unresolved, unreadable, partial, unsupported, etc.
};

type StudyPacket = {
  deliveryId: string;
  snapshot: StudySnapshot;
  sources: StudySource[];
  chunks: StudyChunk[];
  incomplete: boolean;
  nextCursor: string | null;
};

type EvidenceRef = {
  snapshotId: string;
  sourceId: string;
  contentHash: string;
  chunkId: string;
};
```

`StudyCoverage` should record separate states for metadata discovered and text extracted. Record chunks delivered to a model, visual artifacts supplied, and worker-reported review as separate delivery/job observations against the snapshot; further reads do not mutate the original snapshot's coverage. Those are different observations. Rendered pixels do not prove that a model inspected them, and text extraction does not prove coverage of diagrams. Unknown and partial must be representable; a single `reviewed: true` is insufficient.

Use app-local source IDs. Preserve identity for app-coordinated renames using the existing rename flow. For ambiguous external moves, report removal/new source rather than guessing identity from equal content; two different files can contain identical bytes. A line/heading locator is valid for its source version only. Do not emit unsupported `[[note#heading]]` navigation links; display the path and locator until a supported citation viewer exists.

### Live handles versus immutable snapshots

- `studyId` identifies the session's evolving read context.
- `indexRevision` identifies a complete or explicitly partial metadata/index generation. Tree pages require the same generation; a changed generation returns `STUDY_INDEX_CHANGED` rather than mixing pages.
- `snapshotId` identifies immutable captured source versions. Its record includes the selected scope and extraction/chunking versions. Individual packets identify which chunks were delivered from those sources. Validation returns freshness separately; it does not mutate old snapshots.
- Existing quiz `contextId` still identifies the learner state the model is answering. It is not replaced by `snapshotId`.

`retrieve` may create a new snapshot when it selects additional or newer sources. `read(snapshotId, chunkId)` returns the pinned bytes, never today's replacement. Reading another section of an already captured source uses its pinned content blob and chunking version, returning a new delivery packet against the same snapshot. Adding a source creates a new snapshot. Missing/evicted content returns an explicit error; never serve current bytes under an old ID. Keep full snapshot manifests internal when necessary; public packet projections must respect the response budget.

## Source capture, index, and retrieval

### Build and read consistently

1. Validate the selection and enumerate metadata only. Include recognized PDFs/images and, later, DOCX/PPTX/CSV even when their reader is unavailable. Do not quietly omit unsupported study files or broaden `VaultEntry` UI behavior just to index them.
2. Parse Markdown lazily, caching by exact content hash and parser version. Store headings, section ranges, explicit links, and searchable text. Respect fences, tables, and math; do not treat wiki-looking text inside code as a relationship.
3. For candidate open notes, capture the renderer's live text through a read-only port. Label unsaved/failed-save state. Hash the exact text; an editor version is meaningful only within its renderer epoch. Do not force a save to build context. Unsent quiz answer drafts remain excluded.
4. Capture unopened notes with the existing validated disk reader. Check file identity/metadata around reads and retry boundedly when unstable. Coordinate with both the actual shared write barrier used by saves/rename/removal and the existing lifecycle locks used by connect/unload, as specified below. Lifecycle locking alone does not serialize rename/removal.
5. Publish only complete snapshot records after their blobs/chunks exist. Check generation and captured source versions again; retry once or report `STUDY_SOURCE_BUSY`. Individual captured sources are exact, but external filesystem edits do not provide a vault-wide transaction. Return a version vector rather than claiming atomic capture of the whole vault.

Use `VaultService.listNotes({ previews: false })` for supported metadata enumeration rather than its preview-producing default. Reuse its ignored-folder, file-type, and path rules if adding scoped traversal or additional study formats. Avoid a second raw filesystem crawler. Parsing/index work should yield or use a worker thread when necessary; keep synchronous CPU work off the main UI path.

### Coordinate capture with mutations and unload

The current application owns one `vaultWriteBarrier` in `src/main.ts`. Saves, entry rename/link updates, and entry deletion run through that instance. `runVaultLifecycleExclusive` in `src/main/vaultLifecycle.ts` owns a separate keyed coordinator for connect/unload; unload acquires lifecycle locks before calling `writeBarrier.close`. Canonical per-note write queues protect concurrent saves but are not a replacement for the shared mutation barrier.

Inject a narrow capture coordinator from main-process wiring into `StudyContextService`. It must use the **same barrier instance and lifecycle coordinator** as those operations. Constructing another `VaultWriteBarrier` or `KeyedQueue` does not share their exclusion. Conceptually, the bounded disk-capture phase is:

```ts
// Proposed wiring sketch: dependencies below are the existing app-owned instances.
withCaptureAccess: (canonicalRoot, readBoundedBatch) =>
  runVaultLifecycleExclusive(canonicalRoot, () =>
    vaultWriteBarrier.run(async () => {
      await assertRootStillRegistered(canonicalRoot);
      return readBoundedBatch(); // validated direct reads, no nested IPC or saves
    }),
  );
```

Apply these rules when implementing that port:

- Acquire lifecycle locks first, then the shared write barrier, matching unload. For multiple roots, use the existing sorted-root lifecycle helper. New barrier callbacks must not acquire lifecycle locks in reverse order or reenter `barrier.run`.
- Recheck registration, canonical root identity, and requested paths inside the coordinated phase; a lookup before waiting for access may be stale. If the barrier is closing or the vault has unloaded, return an explicit unavailable/retryable result and release access.
- Keep capture batches bounded. Do not hold the global barrier for a full-course scan, parsing, hashing already captured bytes, snapshot-store writes, or model work. Optimistic metadata enumeration can run outside it with generation validation and explicit retry/partial results.
- Capture live renderer buffers before acquiring disk-capture access. Study capture must not await renderer IPC while holding either coordinator: a renderer operation may be waiting for a save through the same barrier. Recheck editor epoch/generation and study scope after release; retry or report instability if relevant state changed.
- Do not call `connect`, save handlers, or another barrier-backed operation from the capture callback. Use the validated read port directly. These application coordinators do not lock external editors or the filesystem across processes, so retain exact hashes, read checks, and bounded retries.

Test the wiring with the real shared instances and deferred operations. Tests of an isolated queue class cannot establish that capture and mutations actually serialize together.

### Retrieve a useful amount

Start with deterministic lexical retrieval over titles, paths, headings, and section text, with explicit bonuses for the selected note and direct links. Deduplicate by source/version/locator, break ties stably, and return a short retrieval reason. A heading outline and lexical index are sufficient for the first release; embeddings are optional later if evaluated queries justify them.

Preserve the adjacent definition or condition needed to interpret a hit. Include a complete table/fence/math block when it fits. Otherwise return a labeled excerpt and continuation cursor. Retrieval ranking is a relevance hint, not source authority or an inferred lesson sequence. Return `not found in indexed scope` when indexing is incomplete, not `not in the course`.

Starting engineering limits, configurable and subject to measurement:

| Output                 | Default limit               | Overflow behavior                                                                        |
| ---------------------- | --------------------------- | ---------------------------------------------------------------------------------------- |
| Attach bootstrap       | 12 KiB total                | Scope, small tree/outline, issues, capability list, retrieval handle; no full-vault text |
| Tree page              | 100 nodes / 12 KiB          | Stable cursor, total/unknown count, index revision                                       |
| Retrieval response     | 24 KiB; hard maximum 64 KiB | Ranked chunks, omitted counts, continuation                                              |
| Worker handoff         | 32 KiB of selected context  | Page or narrow the task; report missing coverage                                         |
| Initial source capture | 2 MiB per Markdown source   | Explicit large-source handling, not silent truncation                                    |

Measure serialized UTF-8 bytes. If Pi exposes reliable remaining context capacity, also leave a model budget for reasoning and the answer. Byte limits are not claims about token counts. Put finite scan, index, source, and cache limits in one configuration module; every exhausted limit produces a typed partial result. Initial indexing must not block the learner-event listener or cause idle model calls.

## Refresh and persistence

Add a ref-counted change registry for vaults used by active study contexts, independent of which vault is selected in the sidebar. It may reuse the existing watcher implementation underneath; make the sidebar another subscriber so one vault does not acquire competing watcher owners. Consume path-level save/rename/remove notifications and live-buffer changes; emit cheap document-generation notifications, capturing/hashing text on demand rather than serializing every keystroke. A watcher event without a reliable filename invalidates the relevant index broadly. Debounce bursts and rebuild only affected sections/links where possible.

Watchers are an optimization, not proof of freshness. On reconnect or watcher failure, rescan scoped metadata. Before creating a fresh source-grounded question, revalidate the selected source versions even if no watcher fired; the first implementation should reread/hash the cited Markdown sources for this check. Report unavailable/unknown freshness instead of asserting `current` from cached metadata alone. A validation records what was observed at that time, not a lock against subsequent external edits.

Change notifications update local context health only. They do not consume a learner cursor, clear pending learner work, count as Continue, or start a model turn. On the next actual turn/tool read, return the relevant change summary and current snapshot reference. Scope changes invalidate pending workers; generation checks discard late old-session builds.

Persist bindings and immutable chunks in a versioned app-local `StudyContextStore`, using the existing queued/atomic-write conventions. The rebuildable index may be discarded. Active jobs and outstanding questions pin their basis; archive/removal releases pins. Set a finite storage budget, evict only unpinned blobs, and report capacity pressure rather than dropping pinned evidence. An explicit user deletion can remove retained source snapshots; subsequent historical access must report that absence. A current unsaved editor snapshot is usable context, but cannot be represented as a saved note after restart.

## Proposed APIs and transport

Add a `study` request family to the existing local broker, with a separate schema version/capability list. Do not overload conversation-history `quiz context` or rename today's `storm context` command.

| Operation  | Responsibility                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------- |
| `open`     | Bind a validated selection, or derive it from the privately authenticated attached quiz; return a bounded bootstrap |
| `status`   | Index readiness, current generation, changed source IDs, reader availability, snapshot availability                 |
| `tree`     | Page scoped folders, sources, headings, and explicit relations at one index generation                              |
| `retrieve` | Search the permitted context and capture matching source versions; return snapshot and chunks                       |
| `read`     | Read/paginate a pinned source section or chunk from an existing snapshot                                            |
| `validate` | Compare referenced source versions to current state; return current/changed/unknown per source                      |
| `close`    | Release the live binding/watch reference; retain separately pinned question/job evidence                            |

Proposed manual CLI examples:

```sh
storm study open --vault VAULT_ID --folder 'Course/Weeks'
storm study tree STUDY_ID --index-revision REV --limit 100
storm study retrieve STUDY_ID --query 'why does this relationship hold' --max-bytes 24576
storm study read STUDY_ID --snapshot SNAPSHOT_ID --chunk CHUNK_ID
storm study validate STUDY_ID --snapshot SNAPSHOT_ID
```

Pi exposes a **read-only `storm_study` tool** with these bounded actions. Tutor does not need to recover paths by shell, inspect the whole vault, or create another attachment. The extension privately binds it to the active quiz scope; standalone study uses an explicit selection. Keep the existing `storm_quiz` token inside the extension. A study lookup failure should not prevent conversation recovery or erase a learner submission.

## How this helps Tutor on each turn

At attach, provide conversation recovery plus a small study bootstrap. Tutor receives the goal already established in the conversation, the selected scope, a collapsed tree/outline, relevant source-role/coverage warnings, and available reader capabilities. It retrieves additional material only when the current task needs it. Do not repeat the tree or full skill text in every event.

For a normal explanation, Tutor should:

1. Interpret the actual question and existing learner reasoning. Answer directly when the context is sufficient; do not require a diagnostic quiz.
2. Retrieve the definition, conditions, and connected sections needed for the explanation. Preserve source wording when quoting; label supplemental reasoning and conflicts.
3. Apply the writing skill: answer early, establish necessary context, explain the relationship between steps, and use a useful example. Avoid inventing a connective claim merely to make the prose smooth.
4. Check source references and the current conversation context before publishing. Cite when it helps the learner trace a claim; source grounding should not turn every sentence into citation clutter.
5. Ask for an attempt or application when it informs the lesson. Preserve explicit learner pacing and Continue.

For substantial source review, use a bounded reader worker. For ordinary writing, apply the writer skill in Tutor. A separate writer is appropriate for a long synthesis with a complete evidence packet; a routine explanation should not require a multi-model pipeline.

### Worker handoff contract

```ts
type StudyWorkerBrief = {
  jobId: string;
  task: string;
  scopeHash: string;
  snapshotId: string;
  goal: string;
  relevantLearnerContext: string;
  sources: StudySource[];
  chunks: StudyChunk[];
  unresolved: string[];
  outputKind: 'source-brief' | 'question-draft' | 'reference-draft';
};

type StudyWorkerResult = {
  jobId: string;
  snapshotId: string;
  claims: Array<{ text: string; evidence: EvidenceRef[] }>;
  uncertainties: string[];
  requestedMoreContext: SourceLocator[];
};
```

The parent validates job/session/scope identity, schema, cited source versions, and membership of chunks actually supplied. Exact quotes must match the pinned source. Claim validity still requires source review; schema validity is not semantic correctness. Unsupported citations or an old-scope result produce an actionable rejection within a bounded retry budget. Do not quietly substitute today's source for a worker's old reference. Register job-to-snapshot pins before dispatch and release on completion/cancellation. On restart, mark jobs whose runtime was lost as interrupted; do not invent a resumed worker or rerun it without reconciling the task. This is context bookkeeping, not a new Storm agent executor.

For the first version, give workers an immutable packet only. If more context is needed, they return a request to Tutor; the parent retrieves it and makes an explicit new handoff. No worker gets a quiz capability, listener, note writer, or general study-service credential. Fix the local launcher/extension allowlist before using workers: the current separate Pi process inherits ordinary extension discovery and ignores several role metadata fields. A prompt saying `read only` is not an enforced tool boundary.

### Questions must retain their original basis

When posing a source-grounded question, store its evidence references and source snapshot as its `studyBasis`, atomically with the accepted question. Pin those blobs. On feedback, use that basis and the exact submitted answer, even if the underlying note has changed. If the basis contained an error, explain the correction and reconsider the question fairly; do not silently change the criterion after the learner attempts it. Access to a historical question basis is validated against the owning quiz and its stored original scope; an arbitrary snapshot/source ID cannot bypass the current selection for new retrieval.

For newly authored questions/explanations, a changed cited source requires refresh or explicit historical framing. Unrelated note edits must not invalidate an ordinary chat response. Add an optional source-basis check alongside existing `contextId`/revision checks, keyed to the sources actually used. Study changes do not replace conversation concurrency guards. The service must validate and commit question/basis together; a separate metadata save after question acceptance leaves an avoidable crash gap. Write/pin source blobs first, persist the question and references in the same QuizStore mutation, and reconcile orphan pins after a failed commit or startup. This avoids requiring an atomic transaction across two stores.

Storm currently has no hidden answer-key/rubric contract. Do not imply that a source packet supplies automatic grading. A future question-drafting worker can prepare an answer/rubric for Tutor's review through a private job result; learner-facing snapshots must exclude it.

## Additional Tutor changes, in priority order

1. **Make the runtime match the skills.** Synchronize app/CLI/extension/skill deployment and add a capabilities handshake. Give Tutor a deliberate extension allowlist. While attached, route all learner interaction through Storm; restore standalone Pi tools on detach. Validate unsupported agent metadata instead of ignoring it.
2. **Unify teaching and quiz policies.** Update stale paths and the append-only claim; remove legacy direct-write storage rules. Make diagnosis bounded, allow open responses, and preserve conditions instead of demanding caveat-free foundational assertions. Keep reference preparation distinct from live diagnosis.
3. **Add format-specific readers after Markdown works.** PDF text plus targeted rendered-page evidence first, using existing PDF support where appropriate. Then DOCX headings/tables, PPTX slides/notes/visuals, and CSV headers/units/rows/calculations. Cache by source hash and reader version. Missing readers remain visible in the manifest; installation is not automatic. Reader/model work stays in external agents, with Storm storing validated references/results.
4. **Add a small learning ledger later.** Record goal, exact attempt/event reference, assistance, outcome, uncertainty, and next review point separately from sources. Use introduced / completed with help / independently demonstrated as evidence descriptions. Do not auto-claim mastery from one correct choice or silently treat a summary as raw evidence.
5. **Evaluate quality before adding more roles.** Use representative explanation and transfer tasks to decide whether separate writers, reviewers, embeddings, or observational memory improve results enough to justify latency and complexity.

## Proposed change sets and file map

| Change set                             | Main files                                                                                                                                                              | Done when                                                                                                                                     |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Scoped Markdown context core        | New `src/shared/studyContext.ts`, `src/vault/studySourceIndex.ts`, `src/vault/studySourceReader.ts`, `src/main/studyContextService.ts`, `src/main/studyContextStore.ts` | Reuse metadata-only listing; tree, pinned retrieval, and live/disk capture use validated ports and the shared mutation/lifecycle coordinators |
| 2. Broker/CLI vertical slice           | New `src/main/studyAgentHandler.ts`; extend `src/shared/agentProtocol.ts`, `src/main/agentBroker.ts`, `src/main.ts`, `scripts/storm.ts`, `scripts/stormHelp.ts`         | Existing discovery/inspection still works; new bounded study operations are usable without writes or a second quiz attachment                 |
| 3. Tutor delivery and worker contracts | `extensions/storm-quiz.ts`, runtime, shared projections; reviewed local Tutor launcher/system/skills/worker loader                                                      | Real Tutor entry point receives bootstrap, retrieves shared sources, validates a worker packet, and recovers after restart                    |
| 4. Changes and question basis          | Ref-counted watcher service; read-only renderer change/epoch bridge; QuizService/protocol/store for atomic basis persistence                                            | Background-vault and unsaved-buffer edits are detected; outstanding questions retain original sources                                         |
| 5. Richer sources and evidence         | Reader adapters/jobs, optional learning ledger and renderer source display                                                                                              | Coverage and provenance remain accurate across mixed materials; learning evidence stays distinct                                              |

Change sets 1–4 together are the initial usable shared-context feature. Tests should accompany each boundary. Keep proposed work here until delivered; update `docs/CLI-DESIGN.md`, `skills/storm/SKILL.md`, authoring guidance, and maintained architecture/help together when implementing the corresponding behavior. Do not describe the draft API as shipped.

## Acceptance and evaluation

Use a disposable fixture vault, not personal learner notes. Include two courses, duplicate basenames, a cyclic link, a missing link, a fenced fake link, a long table, Unicode/math, an unsaved buffer, and an unsupported attachment.

| Scenario                                                 | Required result                                                                                                                        |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| One note/folder selected                                 | Only permitted source content enters the packet; outside links are marked; no implicit full-vault text injection                       |
| Large course                                             | Paged tree and bounded retrieval; explicit partial status; no repeated full preview scan per query                                     |
| Unsaved note differs from disk                           | Tutor gets the labeled live version; no save or focus change; persisted-note claims remain accurate                                    |
| Capture races an app save, rename, or deletion           | Shared barrier orders operations; registration/path checks run after acquisition; no mixed or silently substituted source identity     |
| Capture races unload-one or unload-all                   | Lifecycle-before-barrier ordering completes without deadlock; unloaded roots are rejected; no independent lock instance masks the race |
| Renderer save is pending during capture                  | No renderer IPC is awaited under capture locks; the save and capture complete or return bounded explicit errors                        |
| Worker returns after source/scope change                 | Original evidence is identifiable; stale scope is rejected; useful historical work is not relabeled as current                         |
| Notes change during an answer                            | The question's basis remains available; feedback does not silently use a replacement criterion                                         |
| Sidebar switches to another vault                        | Study invalidation continues for the attached context; no wrong-vault results                                                          |
| Watcher misses a change / renderer restarts              | Source validation detects changes or reports uncertainty; epochs prevent false version equivalence                                     |
| Reconnect with pending learner input                     | Both conversation and study context recover; one response, one listener, explicit Continue preserved                                   |
| Broken/ambiguous links or missing reader                 | Honest issues/coverage, no guessed source or fabricated completeness                                                                   |
| Snapshot eviction / explicit deletion                    | Clear unavailable result; no substitution of current bytes under a historical ID                                                       |
| Malformed worker evidence / quoted instruction in a note | Rejected references where invalid; note text stays source data, never overrides runtime instructions                                   |
| Existing client or mismatched installed CLI              | Feature negotiation selects supported behavior or reports a clear mismatch before unsupported commands                                 |

Run focused contract/race tests, the source suite, typecheck, and relevant lint checks when implementing. Exercise the packaged app/CLI and actual Tutor launcher with an isolated vault; unit tests alone do not verify the deployed path. Preview any source-status/citation UI separately.

For model evaluation, compare repeated clarification, connected explanation, reference preparation, misconception repair, and independent application tasks. Measure source accuracy, missing prerequisite context, repeated questions, invalid citations, assistance, tool repairs, context bytes, and time to a useful answer. Report sample sizes and model configuration. Fewer tokens, passing a formatting check, or worker agreement do not establish improved learning.

The first success criterion is practical: Tutor and a bounded worker can explain the same scoped material from the same identifiable source versions, while the learner can edit, answer, and reconnect without losing either the context or control of the session.
