# Architecture review and remediation — 2026-10-25

The current worktree had useful process boundaries and substantial test coverage, but inconsistent authorization and concurrency enforcement. Its size alone did not indicate quality. This pass investigated the app and fixed the six concrete findings below while preserving existing worktree changes.

## Findings addressed

| Finding                                                                                                                  | Result                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quiz rename could overwrite a concurrent Stop and restore a revoked agent capability.                                    | Rename updates only the current name inside the store transaction. Tests cover both operation orders, draft/saved sessions, activity cleanup, and rejection of old tokens.                                                                                                                                                                                                   |
| Many filesystem IPC handlers accepted foreign renderers; arbitrary directories could be registered through renderer IPC. | A common authorization wrapper checks the exact live window, main frame, and app URL. Arbitrary registration/removal APIs were removed; new roots come from native directory selection. Navigation guards, explicit sandbox settings, a production CSP, and restricted browser permissions strengthen the boundary. No complete Markdown/XSS exploit chain was demonstrated. |
| Canceling Quit dismantled agent IPC and temporary images.                                                                | Final disposal runs at `will-quit`, after confirmation. An isolated test imports the real main module and verifies that Cancel preserves communication. Endpoint shutdown is shared across quit paths.                                                                                                                                                                       |
| Concurrent same-revision saves could both acknowledge success and lose one write.                                        | Application mutations share an ordered write barrier; canonical per-note queues coordinate separate service instances. Race tests require one successful save and one conflict, preserving the winning content and cleaning temporary files. Unloading checks active agent sessions.                                                                                         |
| Socket buffers could exceed limits during broker work; idle clients could block shutdown.                                | Aggregate byte/frame limits, authentication/idle deadlines, sequential processing, write backpressure, connection tracking, and idempotent shutdown bound the transport lifecycle. Tests cover fragmented UTF-8, blocked work, ordering, deadlines, and close.                                                                                                               |
| The shipped Electron version and transitive Undici versions had upstream advisories.                                     | Electron is pinned to 44.9.1. Undici overrides preserve majors at patched 6.29.1 and 7.30.1. The complete dependency audit reports zero advisories. This is an audit result, not a claim that the app has no vulnerabilities.                                                                                                                                                |

## Simplification and performance

- Broker and preload share bridge types and runtime guards; protocol types no longer depend on renderer/controller declarations. Validators reject malformed variants and optional metadata.
- Quiz content draft updates, heading rendering, asset opening, metadata preservation, creation handlers, and endpoint shutdown share their repeated logic.
- The quiz picker requests small metadata summaries. Only the active visible session fetches its full state, without unused event history. Polls wait for prior polls to finish; stale session switches and local drafts remain guarded.
- Vault previews read at most 16 KiB per Markdown file and display at most 300 characters. Metadata-only listing avoids preview reads for discovery and rename planning. Full-text search retains complete-file matching.
- TypeScript strict mode is enabled. A separate tools configuration checks CLI/build scripts and the portable quiz extension runtime. The Pi-specific entry point uses host-provided types and remains covered by runtime integration tests.
- CI runs type checks, lint, tests, the complete audit, packaging, and an isolated bundled CLI smoke check on macOS. Action revisions are pinned; the workflow has read-only repository permissions.

Comparing equally formatted snapshots from before these passes, the production files that shrank lost **379 lines**; strengthened validation, security, and performance paths added **449 lines**, for **70 net additional production lines**. This excludes tests, the packaged smoke script, configuration, and documentation. Moving code into shared modules is included in the total. The result removes duplication but is not a net line-count reduction.

## Verification

- `pnpm test`: **660 passed**, zero failures, across 96 files.
- `pnpm typecheck`: passed for strict app and tools configurations.
- `pnpm lint`: passed, including formatting; `git diff --check` passed.
- `pnpm audit --json`: zero advisories across 606 dependencies.
- `pnpm package`: passed on macOS arm64 with Electron 44.9.1.
- `pnpm test:packaged`: passed against the packaged executable and its bundled CLI in a temporary profile/vault. Context, inspect, connect, complete stdin streaming through EOF, terminal status, and file readback passed. Expected/saved UTF-8 length: **40 bytes**; SHA-256: `3e540b60e8852ff684bc77f09a97bba13301c2eb13dee26a0adeb36ba02e3743`.
- Native packaged UI check: session summaries exclude history/capabilities; opening history, draft persistence across polling and session switches, rename, Stop, navigation blocking, and the local PDF worker passed with no renderer errors. This used a temporary profile, background launch, and a 1440×900 emulated viewport. It does not verify foreground reveal timing or narrow-window layout.

The GitHub workflow is configured but has not run remotely in this session. Local checks do not verify signing/notarization or every supported GUI/platform workflow.

## Remaining architectural limits

The main React component, editor, and main-process entry point still combine substantial orchestration. Future extraction should follow ownership of vault activation, tabs, documents, and shutdown rather than arbitrary file-size targets. The quiz store still rewrites JSON transactions; a transactional database becomes useful as history grows. Vault full-text search still scans complete notes; an incremental index would improve large-vault workloads. Filesystem checks narrow path races but do not establish a cross-process filesystem lock against other applications.

Narrow windows with both sidebars open can crowd the quiz header and controls. The functional UI check above used a wider viewport; responsive pane sizing remains a separate improvement.

These are continuing design tradeoffs and scalability work, not additional reproduced exploits. This review does not certify every line as optimal or vulnerability-free.
