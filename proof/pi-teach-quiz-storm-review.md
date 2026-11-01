# Pi teaching, quizzes, and Storm: review and proposed integration

Reviewed 2026-10-25. This is a configuration and source-code review, not a measured comparison of learning outcomes. No Pi configuration, installed application, dependencies, or learner records were changed. Upstream repositories were cloned into a temporary directory and inspected without running their code. Private session transcripts and credentials were not inspected.

## Recommendation

Keep one persistent **Tutor** as the learning orchestrator and owner of the live Storm connection. Make `/teach` the teaching policy, make quiz preparation a source/scope/practice policy, and select the interaction adapter from the session's actual capabilities. Use bounded source-reading workers when needed. Apply a writing skill in the Tutor for ordinary explanations; use a separate writer only for substantial synthesis. Storm should own durable interaction state and coordinated note changes.

Your existing configuration already contains much of the teaching method from `learn`. The largest immediate gains come from reconciling conflicting instructions, making the tools match the roles, and deploying the continuity fixes together. A larger agent hierarchy would currently reproduce those conflicts across more contexts.

## What is actually installed

- Local skills resolve through `~/.pi/agent/skills` to `~/.pi/pi-config/skills`. This local configuration's remote is `https://github.com/1knth/pi.git`; it is a customized setup, not the supplied Amos repository verbatim.
- The relevant local pieces are `teach/SKILL.md`, `quiz-prep/SKILL.md`, the `quiz` **tool** in `extensions/quiz.ts`, Tutor's launcher/system prompt, the `researcher` role, visual-maker roles, and the Storm wrapper. There is no separate `quiz` skill or `quiz` prompt file in the inspected directories.
- Normal Pi discovers the quiz, question, subagent, visual, and Storm extensions. The dedicated Tutor launcher uses `--no-extensions` and explicitly loads only the Storm extension.
- The wrapper imports a copied integration under `~/.pi/agent/storm-integration` and selects `/Applications/Storm.app/Contents/Resources/cli/storm`. These differ from the checkout we just fixed. The installed CLI help lacks the new compact/context recovery interface.
- A custom Tutor system prompt does not remove Pi's discovered skills/context files. Inspection of the installed prompt builder shows that it does replace the standard preamble/tool-guideline sections. Critical routing rules must therefore be explicit in Tutor's prompt.

## Findings that affect reliability and model performance

| Priority | Observed issue and evidence                                                                                                                                                                                                                | Consequence                                                                                                                                                                                     | Proposed fix                                                                                                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | `~/.pi/agent/extensions/storm-quiz.ts:1` imports the old copied integration and selects the installed application CLI.                                                                                                                     | The source fixes for bounded recovery, response ownership, and context revisions are not the behavior this launcher currently runs.                                                             | Ship app, CLI, extension, runtime, shared module, and skill as one versioned integration; add a protocol/capability handshake.                                                                              |
| P0       | `~/.pi/agent/tutor/start:15` disables all extensions except Storm; `teach/SKILL.md:62` requires `quiz` and `:71` requires a researcher.                                                                                                    | Tutor is instructed to use unavailable tools. The optional researcher and visual workflow cannot be executed through this launcher's toolset.                                                   | Define an explicit Tutor extension allowlist and check required tools at startup. In Storm mode route questions/preferences through Storm. Add only the worker/reader capabilities the workflow needs.      |
| P0       | `quiz-prep/SKILL.md:21` mandates `Quiz Prep/.../Quiz.md`, `Overview.md`, and direct generator scripts; global Pi policy and `teach/SKILL.md:90` specify Storm, assessment `Review.md`, and designated practice locations.                  | Competing sources of truth, duplicate saves, unintended folder structure, and possible edits outside Storm's coordination.                                                                      | Remove storage/UI assumptions from quiz-prep. Use Storm's note interface and existing user-designated locations. Preserve existing work; do not migrate automatically.                                      |
| P1       | `teach/SKILL.md:62` converts gradable Socratic questions to the Pi quiz widget; `:147` mandates a quiz for every node.                                                                                                                     | Storm and terminal can both become the interaction surface. Forced recognition questions also discard the evidence provided by a learner's independent explanation.                             | While attached, one Storm interaction owner. Select MCQ, matching, short answer, or long answer for the evidence needed. Use Pi's widget only in standalone Pi mode.                                        |
| P1       | `teach/SKILL.md:102–111` requires a success and an actual failure/unknown on every strand and forbids progressing while all answers are correct.                                                                                           | Diagnosis can grow without a bound and delay the requested explanation. A failure outside the goal is not useful evidence about readiness for that goal.                                        | Use existing evidence first; make diagnosis optional and bounded by the task. Stop when the next teaching decision is adequately informed. Record uncertainty instead of forcing a failure.                 |
| P1       | `teach/SKILL.md:28–39` requires caveat-free foundational truths and asserts that they commit instantly to memory.                                                                                                                          | Encourages oversimplification and unwarranted certainty, especially for context-sensitive course material. These prompt claims are not evidence of learning effectiveness.                      | Start from scoped definitions, assumptions, prior knowledge, and verified principles. State conditions where they matter; distinguish an illustrative model from an established claim.                      |
| P1       | `agents/researcher.md:5–6` selects a small model and only `web_search, web_fetch`. No general PDF reader, CSV reader, or PPTX reader skill was found; `test-pdf` generates tests and `docx-edit` edits documents.                          | The proposed course researcher cannot inspect local assigned materials. Web summaries can silently substitute for instructor terminology and scope.                                             | Add a separate read-only course-source role with format-specific readers and provenance. Retain the web researcher for supplemental questions. Choose models by verified task quality, not role name alone. |
| P1       | `extensions/subagent/agents.ts` parses only name, description, tools, and model. `index.ts:300–338` always appends the role prompt, and only inherits thinking for roles without an explicit model.                                        | `thinking`, `system-prompt`, and `auto-exit` metadata in local role files are ignored. Importing upstream agent files does not import their runtime semantics.                                  | Validate supported role fields; reject or report unsupported metadata. Explicitly resolve model/thinking, tool availability, prompt mode, and worker termination.                                           |
| P1       | The same child launcher starts ordinary Pi without an extension allowlist or an explicit environment filter.                                                                                                                               | A separate process and a tool list do not establish the intended worker isolation. Loaded extensions and inherited environment need their own review before handling live-session capabilities. | Launch workers with a narrow extension set and sanitized environment; never pass Storm attachment capabilities or enable another listener. Enforce boundaries in the launcher, not solely in prose.         |
| P1       | `tutor/start` starts a fresh Pi session each invocation; `/agent tutor` changes the active role but does not execute this launcher.                                                                                                        | Two entry paths have different tools and continuity. A restarted Tutor may repeat diagnosis or misunderstand the pending action.                                                                | Make entry modes explicit; support deliberate resume selection and bounded Storm recovery keyed to the selected Storm session. Do not automatically resume an unrelated session.                            |
| P2       | `teach/SKILL.md:86` names a missing `.pi/skills/storm` path and describes the CLI as append-only. `quiz-prep` forbids `Review.md` while two helper scripts still require it.                                                               | Extra tool calls, failed workflows, and incorrect refusal of supported guarded edits.                                                                                                           | Generate or verify integration paths/capabilities; remove obsolete helpers or adapt them to a single contract. Distinguish an append-only reference workflow from the CLI's full capabilities.              |
| P2       | `teach/SKILL.md:155` expects math in option labels; Storm's authoring guide documents native option labels as plain text. Pi's quiz offers multi-select and a distinct don't-know signal that Storm's current protocol does not represent. | Rendering errors and incorrect assumptions about grading/response equivalence.                                                                                                                  | Add a capability matrix. Put rendered math in supported prompt content. Explicitly add missing response kinds before relying on them; never silently reinterpret them.                                      |
| P2       | `md-log.ts:32` observes `quiz` and `ask_user_question`, not `storm_quiz`, and writes/backfills files directly.                                                                                                                             | Incomplete Storm transcripts and a competing writer if pointed at a live note.                                                                                                                  | Keep Storm's transcript canonical. Make any export an explicit, coordinated operation rather than a second live logger.                                                                                     |

These are static findings. For example, a disabled tool proves a capability mismatch; it does not prove how frequently a model has attempted that unavailable tool in actual sessions.

## How the pieces should work together

### One Tutor, optional workers

The Tutor directly maintains the goal, scope, current explanation, learner evidence, next action, and attachment. The existing Danny orchestrator requires delegating every substantive action and has only delegation/question tools; it is a poor owner for a persistent Storm waiter. Keep the learning orchestrator as a direct Tutor session.

Give workers bounded requests containing the question, source scope, relevant context, output schema, and stopping budget. Return verified results to the Tutor. Workers do not attach, wait for the learner, advance a question, publish a final explanation, or edit a live note.

- **Course-source reader:** inspect assigned PDFs, slides, DOCX, CSV, and images. Return claims with exact locations, source versions, scope coverage, missing content, and conflicts. For PDFs distinguish search hits, extracted text, and visually inspected pages; for PPTX distinguish slide text, diagrams, and speaker notes; for CSV preserve headers, units, filters, and calculations; for DOCX preserve heading/table context.
- **Web researcher:** answer supplemental or unresolved questions, preferring primary sources. Do not conduct a new web search for every claim already verified against the assigned material.
- **Writer skill:** turn the selected evidence into a coherent explanation using the contract below. Ordinary writing stays with the Tutor. A long reference synthesis can use a separate writer with a self-contained brief and source packet.
- **Reviewer when warranted:** independently check a consequential ambiguity, difficult answer key, or substantial synthesis. Agreement between models is not source verification.

### Teaching and practice serve different purposes

`/teach` should select an appropriate mode from the user's request: direct explanation, guided reasoning, bounded diagnosis, independent practice, assessment simulation, or reference preparation. A quick clarification should not trigger a mandatory probe, plan approval, and node-by-node quiz sequence.

Keep the strongest existing ideas: motivate the need for a concept, derive rather than list when appropriate, explain connections, construct plausible distractors symmetrically, and preserve the learner's own reasoning. Add fresh application questions that require choosing and combining ideas. A question immediately after an explanation can demonstrate recognition with support; it does not establish later independent transfer.

Refactor `quiz-prep` around scope, source coverage, authentic question formats, independent attempts, feedback, and resumption. In a live Storm session, Storm owns the exact prompt/answer transcript and Continue interaction. Reference notes and practice artifacts use the existing designated locations. There is no reason to duplicate every native quiz event into a second `Quiz.md`.

### A response contract that connects ideas

Use this as a writing skill and review rubric, adapted to the task rather than as mandatory visible headings:

1. Answer the current question early and establish the context needed to interpret it.
2. Identify the specific gap or problem the next idea resolves.
3. Introduce the necessary definition or assumption with its conditions.
4. Explain the causal or logical steps, explicitly connecting them to the preceding idea.
5. Use an example that shows why the distinction matters; distinguish examples from evidence.
6. When useful, request an application or explanation that reveals understanding; otherwise finish the requested answer.

Give the writer a compact packet: current goal, known context, relevant evidence and source locations, prerequisite concepts, supported interaction tools, and the desired depth. Require it to flag unsupported claims or missing context. Do not ask it to invent a bridge merely to make the prose flow.

Prompts can guide coherence, but cannot guarantee it. Enforce tool routing, ownership, provenance fields, handoff validation, and state transitions in code. Evaluate whether an explanation actually connects ideas using representative examples and human review; a checker for required headings would only enforce presentation.

### Durable context without conflating records

Keep four distinct records with explicit ownership:

| Record             | Purpose                                                                              | What it does not establish                     |
| ------------------ | ------------------------------------------------------------------------------------ | ---------------------------------------------- |
| Source/concept map | Verified concepts, conditions, relationships, and provenance                         | That the learner understands a concept         |
| Session plan       | Goal, scope, mode, current concept, next action                                      | That a visited node is mastered                |
| Learner evidence   | Exact attempt reference, question, outcome, reasoning, assistance, date, uncertainty | A permanent ability inferred from one response |
| Study reference    | Complete, readable course material saved through Storm                               | Practice completion or assessment readiness    |

Store exact events first; summaries and progress views should be rebuildable. Preserve corrections and superseded interpretations rather than silently rewriting attempt history. Evidence should distinguish introduced, completed with help, and independently demonstrated; later review can supply stronger evidence.

On reattach, recover the selected session's goal/scope, pending learner action, current question, recent exact turns, compact evidence summary, and source references. Retrieve older material only when needed. Bounded transcript recovery is already implemented in this checkout; the richer learning records and modes above are proposed additions, not current protocol fields. Retain revision/context checks and one waiter; a summary must never authorize a stale response.

## What each upstream repository contributes

Sources are pinned to the inspected commits, because these repositories are changing quickly.

### `learn`: preserve and adapt what you already have

Snapshot: [`7cfd894`](https://github.com/amosblomqvist/learn/tree/7cfd8942f82ab9476e63572387e1fe9bcea5082c).

This is the closest ancestor of the existing teaching, quiz, visualization, and helper-role setup. It supplies a useful method for motivated explanations and careful quiz construction. Installing the bundle again would duplicate existing functionality and reintroduce terminal/Obsidian assumptions. Its interactive-subagent recommendation also refers to a different extension from your local subprocess implementation. Treat it as a comparison baseline for targeted local adaptation, not a replacement configuration. [Repository documentation](https://github.com/amosblomqvist/learn).

### `pi-config`: source tools and observability

Snapshot: [`f82da56`](https://github.com/amosblomqvist/pi-config/tree/f82da563ab05d66729492d64c7ed4e96db3663f3).

The most immediately useful addition is its PDF workflow: inspect document structure, extract targeted text, and render pages when visual layout, formulas, tables, or diagrams matter. Adapt the pattern into a course-source reader; installation still requires dependency and tool review. [PDF reader skill](https://github.com/amosblomqvist/pi-config/blob/f82da563ab05d66729492d64c7ed4e96db3663f3/skills/pdf-reader/SKILL.md).

Its session-analysis tools provide a starting point for measuring tool overhead and prompt growth. Add Storm-specific quality measures rather than optimizing token count alone. The repository explicitly recommends selecting components rather than installing the whole configuration. [Session analysis](https://github.com/amosblomqvist/pi-config/blob/f82da563ab05d66729492d64c7ed4e96db3663f3/skills/analyze-sessions/SKILL.md), [configuration guidance](https://github.com/amosblomqvist/pi-config/blob/f82da563ab05d66729492d64c7ed4e96db3663f3/README.md).

The observational-memory and interactive-subagent directories contain pointers to separate repositories, not the implementations. Their README descriptions are insufficient to establish compatibility with Storm ownership, session recovery, or your current loader. Evaluate those separately before adoption. Do not revive the explicitly deprecated orchestrator/memory components. No top-level license file was found in the inspected `learn` or `pi-config` snapshots; verify reuse terms before importing code.

### `learnharness`: architecture patterns, independently implemented

Snapshot: [`b277ee3`](https://github.com/amosblomqvist/learnharness/tree/b277ee3e0fa24249c1b2d0f9b7fd6ed485f484b9).

- Compose small phase-specific prompts and expose only matching tools, retaining one durable conversation through transitions. This offers a stronger boundary than repeatedly appending every skill's rules. [Prompt composition](https://github.com/amosblomqvist/learnharness/blob/b277ee3e0fa24249c1b2d0f9b7fd6ed485f484b9/src/agent/prompts/README.md).
- Separate a map of subject reasoning from learner performance. Current graph contracts explicitly exclude quiz outcomes and understanding assessments. A graph derived from teacher prose records discussed content, not verified learner knowledge. [Graph contracts](https://github.com/amosblomqvist/learnharness/blob/b277ee3e0fa24249c1b2d0f9b7fd6ed485f484b9/src/core/contracts/graph.ts).
- Make source coverage observable. Its PDF worker separately tracks consulted and read pages, avoiding an inflated claim that search-hit snippets equal full reading. Preserve this distinction and add visual-inspection coverage for Storm. [PDF worker](https://github.com/amosblomqvist/learnharness/blob/b277ee3e0fa24249c1b2d0f9b7fd6ed485f484b9/src/agent/subagents/pdf-reader.ts).
- Distinguish comprehension during teaching from independent practice; record assistance and use fresh problems. Adopt this design cautiously without treating its confidence rules or numerical success targets as established diagnoses. [Practice design](https://github.com/amosblomqvist/learnharness/blob/b277ee3e0fa24249c1b2d0f9b7fd6ed485f484b9/src/agent/prompts/practice/10-doctrine.md).
- Use schema-valid worker submissions, bounded retries, a single durable writer, and notification followed by authoritative state fetch on reconnect. These are implementation patterns to assess against Storm's existing contracts. [Worker submission](https://github.com/amosblomqvist/learnharness/blob/b277ee3e0fa24249c1b2d0f9b7fd6ed485f484b9/src/agent/subagents/submit-agent.ts), [architecture](https://github.com/amosblomqvist/learnharness/blob/b277ee3e0fa24249c1b2d0f9b7fd6ed485f484b9/docs/architecture.md).

Historical design documents are not all current behavior. For example, the probe/teach document deferred graph injection, while current code has gated, on-demand graph tools. The current prober's names-only graph view would also be insufficient for checking exact definitions or a prior misconception; retain provenance-backed detail retrieval in our design.

LearnHarness is AGPL-3.0, and the existing Storm skill explicitly prohibits copying its prompts/material. Use it as an architectural reference and write Storm's policies independently. Keep Storm's external-agent approach; adopting useful boundaries does not require embedding a native model or reproducing the whole application. [Repository and license](https://github.com/amosblomqvist/learnharness).

## Implementation order and reviewable acceptance criteria

### 1. Make the existing system agree

Synchronize the installed integration with the tested source bundle, including `src/shared/quizAgentContext.ts` or a bundled equivalent; copying only the extension files is insufficient. Update stale paths, remove contradictory storage rules, make Storm the sole interaction surface while attached, and give the dedicated Tutor an explicit supported toolset. Do not change learner files or force a workspace migration.

Acceptance: the actual Tutor launcher loads successfully; required capabilities are reported; unavailable role metadata produces a clear diagnostic; an attached session creates no Pi popup; detach restores standalone behavior; reattach after a learner response recovers prior context and replies once without advancing prematurely. An incompatible installed CLI is detected before passing unsupported flags.

### 2. Add the source reader and writing contract

Create a source manifest and a schema-validated reader handoff containing source identity/version, location, supported claims, scope coverage, unresolved issues, and extraction/visual status. Add PDF first if it matches actual course materials; cover the other formats deliberately. Apply the response contract in Tutor; delegate long drafting only when useful.

Acceptance: a mixed-material fixture with a diagram, table, and conflicting terminology yields correct citations and honest coverage. Missing capabilities fail clearly. A worker cannot own a Storm listener or write a live note. Human review finds that the explanation answers the question and connects its steps without unsupported bridges.

### 3. Add learning evidence and explicit modes

Introduce backward-compatible, app-owned records for goals, evidence, assistance, and resumption. Tie them to stable source, question, and event identifiers. Add missing question semantics only as explicit protocol/UI capabilities. Avoid a graph canvas project until these records demonstrate value.

Acceptance: guided success is distinguishable from an independent attempt; a correct MCQ does not automatically declare mastery; a content node can exist without any performance evidence; a restarted session resumes the right pending action; older sessions remain readable.

### 4. Measure before expanding the agent hierarchy

Use repeatable scenarios covering direct clarification, reference preparation, misconception repair, independent transfer, reconnect, missing source tools, and source disagreement. Compare time to a useful answer, unnecessary diagnosis, tool failures/repairs, source accuracy, duplicate questions, hint dependence, context growth, and later independent performance. Record actual model/role/tool configurations. Report results as observations with sample sizes; do not equate fewer tokens or a polished answer with better learning.

Only then consider broader observational memory, asynchronous jobs, or a persistent concept graph. Each should solve a measured failure while preserving the Tutor's ownership and the user's control of pacing.
