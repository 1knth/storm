# Connected-agent repair result

Implemented the [repair plan](connected-agent-fix-plan.md). Existing unrelated worktree edits were preserved.

## Resulting behavior

- Pi writes require a context ID tied to the attached quiz, observed revision, learner-event watermark, and images. Queued old turns and prior quiz contexts cannot silently write into newer state. Identical uncertain retries retain their logical operation ID and original request.
- The waiter awaits notification preparation before advancing its cursor, preserving image/text order. Only a response owning an image releases it. Failed release remains retryable, and unavailable images are explicit in model notifications.
- Temporary listener failures retry locally at 250 ms, 1 s, and 3 s. Health is visible; status can restart an exhausted listener. Session shutdown cancels owned waits and retry timers. No idle model loop is introduced.
- Attach/status recover bounded recent discussion, current submitted answers, pending choices, and unfinished learner work. Durable learner/response watermarks survive disconnect and startup recovery. Historical context does not replay learner events.
- Omitted or older content is available as authenticated JSON-text chunks. Open learner drafts stay in the UI/store. Schema-specific projections preserve matching IDs such as `author` and `token` while excluding capabilities.
- The service requires explicit learner Continue before replacing a feedback question. Structured Continue effects are exposed in the Pi tool.
- Compact polling omits accumulated transcript and pages events. Unchanged persisted stores use metadata-validated read caching; explicit full snapshots remain available. Polling still checks at approximately one-second intervals.
- UTF-8 is decoded across socket and CLI stdin boundaries. Tool constraints, local action validation, safe errors, and the response-writing guidance are explicit. Root object properties remain usable by provider adapters that omit schema composition keywords; the installed Pi/Typebox validator enforces action-specific fields and limits locally.
- Packaged testing also exposed and repaired missing broker validation for quiz detach/activity and a missing CLI `--state` flag allowance.

## Evidence

- Full repository test run: **636 passed, 0 failed**, across 92 files. After the final provider-compatible schema adjustment, the 35 affected extension/runtime/integration tests passed again.
- `pnpm typecheck`: passed. Targeted Oxlint and formatting checks passed for the changed implementation and regression files. `git diff --check`: passed.
- `pnpm package`: passed for macOS arm64. Strict deep code-signature verification passed.
- [Packaged smoke result](packaged-agent-smoke.json): launched the packaged app with a disposable profile, exercised its bundled CLI/runtime, recovered exact Unicode text and pending work, read context chunks, checked compact idle responses and Continue rejection, detached both owned sessions, and removed the profile.
- [Installed Pi loader result](pi-extension-load-smoke.json): the actual loader loaded the extension with its real Typebox. Missing contexts and overlong questions were rejected; valid responses and explicit Continue choices passed. This was offline and made no model calls.
- [Post-fix benchmark](quiz-snapshot-benchmark.after.json): at 1,000 synthetic messages, compact idle response size is **374 bytes**, compared with **1,192,215 bytes** for the full snapshot. At 5,000 messages it remains 374 bytes. These are local service/serialization measurements, not model latency or accuracy results.

## Remaining verification limits

Repository-wide `pnpm lint` still fails on pre-existing formatting in nine unrelated files, with unrelated warnings in `fileExplorer.tsx` and `QuizPane.tsx`. Those files were not reformatted as part of this repair. Their paths are recorded in the lint output for the session.

No live Pi/model tutoring or vision run was performed, so semantic response quality and real-world incidence rates remain unmeasured. The rebuilt app is under `out/`; the installed application was not replaced. Reload the source extension and use the rebuilt app/CLI together to adopt the context contract. Historical data already removed by older sanitization cannot be reconstructed from missing event fields alone.
