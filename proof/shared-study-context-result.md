# Shared study context: implemented Markdown slice

Implemented and verified on 2026-10-25 in this checkout. The supported interface and operational limits are documented in [Shared study context](../docs/SHARED-STUDY-CONTEXT.md). The earlier [implementation proposal](shared-study-context-implementation.md) remains the broader design record.

## What now works

An attached Pi Tutor can browse the selected note tree, retrieve relevant Markdown, read retained source versions, and check whether those versions are still current. This shares underlying study material in addition to the existing conversation recovery.

Vault services enumerate sources and read validated Markdown. Main coordinates capture through the existing lifecycle lock and shared write barrier, indexes text, and persists immutable snapshots. The renderer supplies live editor text without saving it. Pi owns tutoring, attachment state, and the local evidence check. Source access stays within the selected note/folder scope; outside links do not expand it.

Scoped questions carry a `studyBasis` snapshot ID. The service checks its scope and freshness before committing the question and basis together. Active question evidence is pinned through edits and reattachment; identical retries retain their original result. New questions cannot silently reuse stale evidence. Capacity failures, partial search coverage, unavailable readers, and expired snapshots are explicit.

The new `pnpm tutor` launcher preflights study capability and loads the extension and Tutor prompt from the same checkout. The prompt calls for connected explanations with relevant context, bounded diagnosis, and source grounding. Pi's competing quiz/question tools are masked during attachment and restored on detach. Optional worker evidence can be checked against delivered source chunks; this check verifies provenance and exact quotations, not reasoning or semantic correctness.

## Verification

- All **673 tests across 99 files passed**, including scope isolation, live unsaved text, Unicode chunk reconstruction, capture/mutation ordering, persistence, stale-basis rejection, and authenticated CLI/Pi integration.
- Strict application/tools typechecking, lint/format checks, and `git diff --check` passed.
- `pnpm package` passed; the resulting arm64 app passed `codesign --verify --deep --strict`.
- The [packaged smoke result](shared-study-context-packaged-smoke.json) came from a real packaged app and its bundled CLI in an isolated temporary profile. It covers retrieval, source change detection, immutable reads, question-basis persistence, reattachment, and Tutor-launcher wiring. No model calls were made.
- The [installed Pi loader check](shared-study-context-pi-loader.json) loaded both integration tools and checked their schemas using the installed Pi runtime. No model calls were made.

The packaged smoke also exposed a reconnect problem: the renderer could return an older editor revision after reconciling current disk text. Reconnect now uses the fresh disk revision only while the live text still matches it; a late edit is rejected. Focused regressions and the packaged flow passed after the fix.

## Adoption and remaining work

Launch `out/Storm-darwin-arm64/Storm.app`, run `pnpm tutor`, then attach to a scoped Storm quiz with `/storm-quiz attach SESSION_ID`. This work did not replace `/Applications/Storm.app` or change global Pi configuration.

This is the first Markdown release. Refresh is on demand; renames produce new path-derived source identities. PDF/OCR, DOCX, PPTX and CSV readers, automatic researcher dispatch, a learning ledger, and concept/mastery inference remain future work. The prompt and evidence plumbing are implemented, but explanation quality and learning outcomes still need evaluation in real teaching sessions.
