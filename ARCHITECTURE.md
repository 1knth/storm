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
- **Agent CLI:** the packaged launcher, bundled client, and runtime are built from `scripts/`. `agentEndpoint.ts` authenticates local requests, `agentBroker.ts` orders session operations, and `agentDocumentHost.ts` coordinates renderer document operations. Shared protocol types live in `src/shared/agentProtocol.ts`. See the [CLI contract](docs/CLI-DESIGN.md) for commands and lifecycle guarantees.
- **Preview:** the renderer derives Markdown from accepted editor state. Reveal metadata identifies new text; the preview owns scheduling and completion receipts. `Editor.tsx` uses the matching final receipt to display Revealing → Finished without delaying backend session completion or persistence.
- **PDFs:** vault services validate and read PDF bytes through a narrow preload API. `PdfViewer.tsx` uses a locally bundled PDF.js worker, windowed page rendering, text layers, search, and page metrics. PDF tabs participate in the same tab grouping and saved-layout flow as notes and images.
- **Vault:** main-process vault services own filesystem access and persistence; preload defines the renderer-facing API. React UI owns presentation and user intent, not filesystem access. The sidebar interaction lives in `src/components/VaultSidebar.tsx`; `src/shared/vaultSidebarLayout.ts` derives the pinned lane and the persisted mixed order of root vaults and groups, while `src/shared/vaultSidebarDrag.ts` validates drag payloads, consumes drop events at their target boundary, and computes placements. `VaultRegistry` persists and normalizes that root order, exposed through the preload bridge. Vault placement and root-order moves organize the sidebar only; they do not move files.

## Development and checks

Use the repository's pinned package manager (`pnpm`, see `package.json`) to install dependencies. Pure source tests use Bun's built-in test runner; an installed Bun runtime is required for them (`bun test`, or `pnpm test`). No additional test dependency is needed. The repository checks are:

- `pnpm test` — the source test suite (Bun required).
- `pnpm typecheck` — TypeScript check.
- `pnpm lint` — Oxlint and formatting check.

When changing a pure decision or transition, add/update a focused test next to its module. Keep this map aligned with the code as responsibilities evolve, and separate independent lifecycle or IPC changes into reviewable PRs. Follow the [release verification checklist](CONTRIBUTING.md#release-verification-and-documentation) for packaged behavior.
