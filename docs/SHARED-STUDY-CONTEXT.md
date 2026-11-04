# Shared study context

Storm provides read-only context for selected Markdown notes. Main owns persisted source snapshots; CodeMirror owns live text, and Pi owns tutoring and the quiz attachment. This is separate from conversation-history recovery.

## Tutor workflow

Build with `pnpm package`, launch that app, then run `pnpm tutor:doctor` and `pnpm tutor`. The launcher prefers the local built app's CLI, falls back to `/Applications/Storm.app`, and checks explicit quiz integration version/features (including learning, support updates, and answer confidence) plus study support. It loads this checkout's extension and Tutor prompt together. It does not replace the installed app or modify global Pi configuration. CLI/argument and endpoint overrides are preserved. Use `pnpm tutor:install` for a backed-up global extension wrapper that imports the maintained checkout. Restart Pi after updating the extension or prompt. See [Tutor deployment](TUTOR-DEPLOYMENT.md) for installation, diagnostics, overrides, and rollback. Pass Pi options to resume a chosen Pi session when needed.

Create/select a scoped quiz in Storm and use `/storm attach SESSION_ID` once. Attach supplies a bounded file tree and activates `storm_study`. While attached, Pi's `quiz` and `ask_user_question` tools are masked; detach restores them. Missing study capability produces a warning without losing conversation recovery.

The learner can attach, replace, or remove scope on an existing session with the quiz header's folder button (current note's folder, current note, entire vault as `folderPath:"."`, or any folder). The change is metadata-only: it does not bump the session revision, and concurrent agent writes preserve it. The Pi extension re-opens study context on the next delivered learner update or `status`, toggles `storm_study`, and reports `studyContextChanged` to the agent. A scope change alone does not wake the agent.

`storm_study` actions:

- `tree`: page files with `offset`; echo `indexRevision` to detect changed metadata between pages.
- `retrieve`: provide a specific `query`, such as relevant terms or a note name. Results contain source hashes, heading/line/character locators, explicit links, chunks, and immutable `snapshotId`. Follow `nextScanOffset` with the same query to search further notes.
- `read`: provide `snapshotId`, optionally `chunkId`. Without a chunk ID, page captured sources in source order using `offset`/`nextOffset`. After ranked retrieval, start at offset zero for complete source context; ranked hits are not full-source order.
- `validate`: compare captured sources with current text, distinguishing current, changed, and unavailable.
- `verify`: provide `snapshotId` and 1–20 `references` containing `snapshotId`, `sourceId`, `contentHash`, `chunkId`, and optionally an exact `quote`. This checks worker evidence against chunks delivered in this attachment. It does not establish semantic correctness. Re-read a snapshot if the local reference cache has expired.

When posing a scoped question, supply its retrieved `snapshotId` as `storm`'s `studyBasis`. The service checks scope/freshness, then stores the question and basis in one quiz transaction. Identical retries return the original result. Feedback uses the original basis even after notes change. A stale basis rejects a new question; refresh sources instead of changing an existing question's criterion.

Ordinary explanations remain direct Tutor work. Optional workers receive only a bounded packet and relevant task context, never the quiz token or listener. Verify citations/quotes, then review reasoning. Coverage, a correct choice, or a note existing does not establish mastery.

## Manual CLI

`storm study capabilities` reports schema version/features. Other operations use JSON stdin and return their value under `result.value`:

```sh
storm study --stdin <<'JSON'
{"action":"open","scope":{"vaultId":"VAULT_ID","notePath":null,"folderPath":"Course","selectedNotePaths":[]}}
JSON
storm study --stdin <<'JSON'
{"action":"retrieve","studyId":"STUDY_ID","query":"distance time speed"}
JSON
storm study --stdin <<'JSON'
{"action":"read","studyId":"STUDY_ID","snapshotId":"SNAPSHOT_ID","offset":0}
JSON
```

`open` accepts one note, selected notes, or a folder; `folderPath:"."` explicitly selects the vault root. No selection means no implicit scan. Queries stay within scope; outside links are reported without reading their contents. Links do not imply prerequisite order. Source roles initially remain unclassified. `verify` is a Pi-local operation over delivered packets, not a CLI action.

## Limits and lifecycle

- Metadata pages: up to 100 entries and approximately 12 KB. Enumeration reuses `listNotes({ previews:false })`, capped at 10,000 entries plus a truncation sentinel.
- Search: 64 notes / 8 MB per scan, four matching captured sources per snapshot, 2 MB per Markdown source. Partial coverage and missing readers are explicit.
- Chunks: at most 6,000 UTF-8 bytes; split sections are labeled continuations. Responses stay within 24 KB. Link metadata may be shortened and marked incomplete.
- The index cache has byte/entry bounds. The private store retains at most 64 snapshots / 32 MB, evicting unpinned snapshots first. Pending/current question evidence is protected; exhaustion fails explicitly. Startup reconciles pins against persisted questions. Older unpinned snapshots can become unavailable.
- Open notes use labeled live text without saving it; unsent quiz drafts stay excluded. Capture acquires the existing lifecycle coordinator followed by the actual shared write barrier. Renderer calls, parsing, and model work happen outside capture's critical section.
- Refresh is on demand. Retrieval/validation reread sources even when their vault is no longer selected. No background model work or atomic filesystem snapshot against external applications is implied.
- IDs identify retained versions, not authorization/current freshness. Source blobs are private app-local data and do not create vault/practice files. Removing a source does not rewrite its captured question basis.

This release reads Markdown. PDF/image entries show reader-unavailable status. It does not add PDF/OCR, DOCX, PPTX, CSV workers, an inferred concept graph, or a mastery model. Renames currently produce new path-derived source identities; historical snapshots retain their original path/text.
