# Contributing to Storm

Storm is an Electron + React app. Keep changes behavior-focused and follow the existing process boundaries below. See [Architecture](ARCHITECTURE.md) for the current ownership map; these conventions describe how new and refactored code should fit it, not a claim that every existing file already does.

## Where code belongs

- **Electron lifecycle and IPC registration:** `src/main.ts` owns app/window setup; focused main-process IPC registration belongs in `src/main/`. Put vault filesystem operations in `src/vault/` rather than growing the entry point into a catch-all.
- **Renderer startup and app-level coordination:** `src/renderer.ts` starts React; `src/main.tsx` coordinates application state such as vault selection, tabs, and focus. Components render UI and handle local interaction.
- **Vault and persistence:** `src/vault/` owns filesystem-facing operations. Renderer code requests them through `src/preload.ts`'s narrow `window.vault` bridge. Define shared boundary types in `src/shared/types.ts`; validate inputs at the process boundary before filesystem effects.
- **Editor behavior:** `src/components/Editor/Editor.tsx` composes the editor. Put cohesive editor features and pure decisions beside it (for example, `tabGroups.ts` and `tabTransitions.ts`), with focused tests alongside pure modules. Keep unrelated UI out of the editor directory.
- **Reusable UI:** put components in `src/components/`. Extract a component when it has a meaningful UI responsibility or repeated behavior, not just to split a file or create a generic framework for one use.

## State and behavior conventions

- Keep one owner for each piece of state. CodeMirror owns the live document text and editing history; React may hold derived preview and tab metadata, but avoid parallel editable copies of the document.
- Keep document writes on the existing editor → preload/IPC → vault-service path. Do not add a second renderer filesystem writer or a competing save path.
- Make save and navigation behavior explicit. Flush pending edits before closing or switching documents when required; guard asynchronous results against stale navigation, and preserve focus behavior. Avoid hidden save side effects in rendering or effects.
- Prefer a pure function for deterministic decisions that can be tested from inputs and outputs; use a hook for reusable React state/effect behavior; use a component for rendered UI. Keep orchestration in the layer that owns the workflow.
- Group code by feature and responsibility. Avoid catch-all `utils` modules; use descriptive names that reveal the domain, such as the editor's `tabTransitions.ts`.
- Follow existing naming: React components use PascalCase; functions, helpers, and modules use camelCase. Do not mass-rename existing code as part of an unrelated change.

## Tests and review

- Add or update a focused test for bug fixes and extracted pure decisions; keep it beside its module (for example, `tabTransitions.test.ts`). Cover relevant boundary and asynchronous cases when changing persistence or navigation.
- Before submitting, run `pnpm test` (requires Bun), `pnpm typecheck`, and `pnpm lint` when relevant. Do not claim interactive GUI behavior was tested unless it was actually exercised.
- Keep pull requests small and behavior-preserving where possible. Explain user-visible behavior changes and any known gaps; do not combine broad cleanup with an unrelated feature.

## Commands

Dependencies are managed with the pinned pnpm version in `package.json`. With dependencies installed and Bun available:

```sh
pnpm test
pnpm typecheck
pnpm lint
```
