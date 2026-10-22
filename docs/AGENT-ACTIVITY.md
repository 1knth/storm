# Agent activity reporting

## Required agent workflow

When using Storm's live-note workflow as an agent, reporting real operational phase changes is **required**, not optional. After `connect`, report `thinking` before the first actual inspection or planning work; report each transition to drafting or back to thinking as it happens. Report `drafting` before composing note content that will be sent to Storm. A direct write with no separate inspection/planning or pre-composition phase does not require inventing one. Connection alone is only Connected, not activity.

This is an agent-workflow requirement, not a protocol guarantee: the activity field and command remain optional for backward compatibility and non-agent clients, and Storm cannot ensure an agent complies. The phases are self-reported operational states, not inferred lifecycle states:

- `thinking`: the agent is inspecting sources or planning its next action.
- `drafting`: the agent is composing content before sending it to Storm.
- `idle`: clear the reported phase when no activity is underway.
- `Writing`: Storm sets this automatically while accepting an append. Appends clear any reported phase.

Example:

```sh
storm activity SESSION_ID thinking
storm activity SESSION_ID drafting
storm activity SESSION_ID idle
```

Use `bun scripts/storm.ts` instead of `storm` when working from the source checkout. The session must still be writable. Activity calls are ordered with session writes, reject stale/closed sessions, and cannot reopen a terminal session. Do not use elapsed-time guesses, transport events, or fabricated text to generate phases. Report only work the agent actually performed. A terminal finish, cancellation, disconnect, or failure clears activity; do not send a fictional `idle` event after termination.

Activity describes an operational phase, not private chain-of-thought. It does not request or expose hidden reasoning. If no separate planning or composition phase occurs, do not invent one; writes automatically clear reported activity and show Writing. Use `idle` only to clear a phase while the session remains connected and no activity is underway. Once the session ends, Storm clears it. If the agent is writing, the truthful Writing state takes precedence over an earlier report.

The status bar uses one mapping: Connected has no spinner; Thinking, Drafting, and Writing show a spinner. When a finished session's active preview is still updating, the bar continues to say Writing until that preview catches up, then shows Finished. This is presentation progress only and does not delay CLI completion or imply a persistence state beyond the existing save acknowledgements.
