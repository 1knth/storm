# Architecture and contributor map

Storm is an Electron application. This document describes the current ownership boundaries; it is not a proposed complete rewrite.

## Entry points and runtime layers

- `src/main.ts` is the Electron main-process entry point. It owns window/app lifecycle and registers IPC handlers.
- `src/preload.ts` exposes the narrow `window.vault` bridge to the renderer. `src/shared/` holds types and code shared across processes.
- `src/renderer.ts` starts the React renderer. `src/main.tsx` owns application-level UI state, including open tabs, tab groups, active focus, and vault selection; it coordinates persistence through the preload API.
- `src/components/Editor/Editor.tsx` owns an individual editor's editing, save binding, and preview behavior. Pure tab layout/group decisions live in `src/components/Editor/tabGroups.ts` and `savedTabLayout.ts` with focused tests alongside them.
- `src/vault/` owns vault operations and persistence services invoked by main-process IPC. UI components request operations through the preload bridge rather than directly owning vault filesystem writes.
- `forge.config.mts` and the Vite config files configure packaging and process-specific builds.

## Ownership and flows

- **Document/editor:** the renderer owns which document is currently shown; an Editor instance owns its editing and view state. The main process does not own editor content state.
- **Tabs:** `src/main.tsx` coordinates application tab state. Pure ordering, grouping, and layout normalization decisions are kept in the editor tab helper modules so they can be tested without mounting the UI.
- **Saving:** Editor coordinates save requests and dirty/binding state; the preload bridge carries requests to main-process IPC, where vault services perform validated filesystem operations. Keep this as one write path; a future CLI should integrate through shared vault services rather than introduce a competing direct-write path.
- **Vault:** main-process vault services own filesystem access and persistence; preload defines the renderer-facing API. React UI owns presentation and user intent, not filesystem access.

## Development and checks

Use the repository's pinned package manager (`pnpm`, see `package.json`) to install dependencies. Pure source tests use Bun's built-in test runner; an installed Bun runtime is required for them (`bun test`, or `pnpm test`). No additional test dependency is needed. The repository checks are:

- `pnpm test` — the source test suite (Bun required).
- `pnpm typecheck` — TypeScript check.
- `pnpm lint` — Oxlint and formatting check.

When changing a pure decision or transition, add/update a focused test next to its module. Larger lifecycle and IPC extractions can follow in separate, behavior-preserving changes with their own tests; this map does not imply those extractions or a CLI already exist.
