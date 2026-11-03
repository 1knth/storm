# Architecture and contributor map

Storm is an Electron application. This maintained map describes the shipped implementation and current ownership boundaries. For conventions on where new code belongs and how changes should be tested, see [Contributing](CONTRIBUTING.md).

## Entry points and runtime layers

- `src/main.ts` is the Electron main-process entry point and owns window/app lifecycle. Focused IPC registration modules live in `src/main/`; vault filesystem services remain in `src/vault/`.
- `src/preload.ts` exposes the narrow `window.vault` bridge to the renderer. `src/shared/` holds types and code shared across processes.
- `src/renderer.ts` starts the React renderer. `src/main.tsx` owns application-level UI state, including open tabs, tab groups, active focus, and vault selection; it coordinates persistence through the preload API.
- `src/components/Editor/Editor.tsx` owns an individual editor's editing, save binding, and preview behavior. Pure tab layout/group decisions live in `src/components/Editor/tabGroups.ts` and `savedTabLayout.ts`; close-tab fallback decisions live in `tabTransitions.ts`, with focused tests alongside them.
- `src/vault/` owns vault operations and persistence services invoked by main-process IPC. UI components request operations through the preload bridge rather than directly owning vault filesystem writes.
- `forge.config.mts` and the Vite config files configure packaging and process-specific builds.

## Ownership and flows

- **Document/editor:** the renderer owns which document is currently shown; an Editor instance owns its editing and view state. `AgentDocumentController` in `src/documents/` owns the shared CodeMirror state for agent-managed documents, coordinated with the visible editor through `agentEditorAdapter.ts`. The main process does not own editor content state.
- **Tabs:** `src/main.tsx` coordinates application tab state. Pure ordering, grouping, layout normalization, and close-tab fallback decisions are kept in the editor tab helper modules so they can be tested without mounting the UI. `main.tsx` retains orchestration such as flushing the editor before closing and activating the selected fallback.
- **Saving:** Editor coordinates ordinary save requests and dirty/binding state; agent-managed documents are flushed through their document controller. The preload bridge carries requests to main-process IPC, where vault services perform validated filesystem operations. The CLI uses this coordinated path rather than writing note files directly.
- **Trust and write ordering:** `rendererSecurity.ts` binds privileged IPC to the live application window, its main frame, and the expected app URL. New vault roots come from native directory selection. A shared `VaultWriteBarrier` orders application mutations and excludes unloading; canonical note queues also coordinate saves across service instances. Navigation, permissions, renderer sandboxing, and the production content security policy enforce the browser boundary.
- **Agent CLI:** the packaged launcher, bundled client, and runtime are built from `scripts/`. `agentEndpoint.ts` authenticates local requests, `agentBroker.ts` orders session operations, and `agentDocumentHost.ts` coordinates renderer document operations. Shared protocol types live in `src/shared/agentProtocol.ts`. See the [CLI contract](docs/CLI-DESIGN.md) for commands and lifecycle guarantees.
- **Preview:** the renderer derives Markdown from accepted editor state. Reveal metadata identifies new text; the preview owns scheduling and completion receipts. `Editor.tsx` uses the matching final receipt to display Revealing → Finished without delaying backend session completion or persistence.
- **PDFs:** vault services validate and read PDF bytes through a narrow preload API. `PdfViewer.tsx` uses a locally bundled PDF.js worker, windowed page rendering, text layers, search, and page metrics. PDF tabs participate in the same tab grouping and saved-layout flow as notes and images.
- **Vault:** main-process vault services own filesystem access and persistence; preload defines the renderer-facing API. React UI owns presentation and user intent, not filesystem access. The sidebar interaction lives in `src/components/VaultSidebar.tsx`; `src/shared/vaultSidebarLayout.ts` derives the pinned lane and the persisted mixed order of root vaults and groups, while `src/shared/vaultSidebarDrag.ts` validates drag payloads, consumes drop events at their target boundary, and computes placements. `VaultRegistry` persists and normalizes that root order, exposed through the preload bridge. Vault placement and root-order moves organize the sidebar only; they do not move files.

## Development and checks

Use the repository's pinned package manager (`pnpm`, see `package.json`) to install dependencies. Pure source tests use Bun's built-in test runner; an installed Bun runtime is required for them (`bun test`, or `pnpm test`). No additional test dependency is needed. The repository checks are:

- `pnpm test` — the source test suite (Bun required).
- `pnpm typecheck` — strict TypeScript checks for the app, CLI/build scripts, and portable quiz extension runtime.
- `pnpm lint` — Oxlint and formatting check.
- `pnpm audit` — the complete dependency graph, including the shipped Electron runtime. Advisories in transitive build tooling are resolved with pinned `overrides` in `pnpm-workspace.yaml` rather than by relaxing the audit level. An advisory is added to `auditConfig.ignoreGhsas` only when no override can patch it without breaking a supported packaging path, and each entry records that reason beside it.
- `pnpm test:packaged` — isolated macOS app/bundled CLI smoke check after `pnpm package`.

The checks workflow runs these checks and packaging on macOS. The host-specific Pi extension entry point is covered by runtime integration tests; its host API is supplied by Pi rather than the app's TypeScript environment.

When changing a pure decision or transition, add/update a focused test next to its module. Keep this map aligned with the code as responsibilities evolve, and separate independent lifecycle or IPC changes into reviewable PRs. Follow the [release verification checklist](CONTRIBUTING.md#release-verification-and-documentation) for packaged behavior.

Quiz agents use `quizAgentHandler.ts` and shared `quizAgentContext.ts` projections for draft-free, capability-free recovery and bounded event pages. `QuizStore` owns persisted quiz truth and invalidates its read cache on writes or changed filesystem metadata. The optional Pi extension owns model-observed response contexts, ordered notification delivery, image acknowledgments, and bounded listener retries; these are distinct from service revisions and the learner's explicit Continue gate.

`QuizService` assigns the learner-facing option order once, when a question is posed, using the pure `src/shared/quizChoiceOrder.ts` decisions (multiple-choice options shuffled, pure quantities ascending, summary options last; the matching option column moved off the authored pair order). The order is persisted with the question, so scoring by choice ID, saved drafts, stored history, rerenders, and reattachment all agree. Learner-facing Markdown is rendered by `QuizPane`'s `QuizMarkdown` with the quiz-specific remark modules beside it: `quizMarkdownMath.ts` (LaTeX bracket delimiters), `quizMarkdownCurrency.ts` (prices that are not equations), and `quizMarkdownCallouts.ts` (callout and collapsed-hint blockquotes). Raw HTML stays inert and answer choices render as plain labels.

Shared study context uses vault-owned Markdown readers/indexing and main-process `StudyContextService`/`StudyContextStore`. Capture coordinates with the existing lifecycle locks and shared write barrier; live text remains owned by CodeMirror. Source snapshots are distinct from quiz response contexts. Broker/CLI operations are bounded and read-only; Pi binds `storm_study` to its attached scope. A question's source basis persists in its quiz transaction. See [Shared study context](docs/SHARED-STUDY-CONTEXT.md) for limits and lifecycle.

The learner model is main-process `LearnerStore` (`learner-model.json`) with pure replay in `src/shared/learnerModel.ts`. A question becomes an attempt only when the agent tagged it (concepts/level/support) and its feedback carries a verdict; the learner's optional confidence comes from the answer. Recording runs after the feedback commit and cannot fail it. Attempts are the persisted facts, keyed per vault; ability (per-concept Elo, independent vs assisted), memory (FSRS-style stability), zones, and recommendations are recomputed on read. Agents read it through the authenticated, read-only `quiz learner` broker operation. See [Adaptive learning](docs/ADAPTIVE-LEARNING-RESEARCH.md).

The quiz picker fetches metadata summaries; only the active session fetches a full snapshot while visible, with non-overlapping polling. Vault enumeration supports metadata-only scans. Sidebar previews read at most 16 KiB per note and display at most 300 characters; content search still checks complete notes.
