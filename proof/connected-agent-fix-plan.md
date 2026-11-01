# Connected-agent repair plan

## Delivery and response ownership

The Pi tool requires a public context ID on writes. Each ID names an attachment generation, observed semantic revision, event cursor, and image set. Notifications and status/recovery responses provide it. A queued event cannot silently update the revision on an older model turn's write. Session changes discard old IDs. Successful writes return a fresh context ID. Logical operation IDs retain the exact authenticated request for safe reconciliation/retry after an uncertain response.

The waiter serializes asynchronous delivery before advancing its delivered cursor or reading another batch. Image lifetime follows the context handling it, rather than any unrelated successful action. Temporary failures retry with bounded backoff, expose listener health, and can be explicitly resumed through status. Stop cancels waits, delivery, and retry timers.

## Context and data

Shared allowlist projections remove capabilities and unsent drafts while preserving learner-defined matching IDs. Attach/status include bounded recent transcript and pending actions. A private context-reading tool supports older history and oversized sections with explicit pagination/truncation metadata. Historical recovery is labeled and does not replay learner events. Pending learner work survives disconnect independently of the UI activity flag.

The CLI gains opt-in compact attach/status/wait responses. Compact polling excludes transcript and old events; full snapshots remain available to existing clients. Read caching and lightweight state access avoid reparsing every saved history while idle. Every operation retains authentication and revision checks.

## Service and tool rules

Only learner Continue (including a structured Continue choice) clears a feedback question for advancement. A fresh session may receive its initial question. The Pi schema exposes action-specific required fields, text limits, supported choice effects, and actionable safe errors. Socket decoding uses a streaming UTF-8 decoder. Agent writing guidance explains how to connect an answer, prerequisite context, conceptual relationship, and useful example without forcing a fixed layout.

## Verification

Replace investigation assertions with positive regression tests in maintained test locations. Cover recovery, stale/switching contexts, retry identity, listener failure/recovery, ordered image delivery/release, Continue enforcement, unsent drafts, matching IDs, UTF-8 chunk boundaries, and bounded transport. Run the repository suite, typecheck, lint, package build, and an isolated packaged CLI smoke test. Preserve unrelated edits and report limits of Pi/UI verification accurately.
