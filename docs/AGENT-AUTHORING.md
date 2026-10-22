# Authoring useful Storm notes as an agent

Storm notes are Markdown documents for people to understand and revisit. Write clear, source-grounded explanations—not merely compact output—and use the formatting that makes the particular material easier to learn. This is a formatting and teaching-quality expectation, not a checklist to satisfy with decorative diagrams or tables. Do not fabricate source claims, learner answers, task completion, or mastery. Explain the relevant reasoning and rationale in the note when useful; never expose private chain-of-thought.

## Choose a teaching approach

Choose the explanation's depth, structure, examples, diagrams, and mathematical notation to fit the learner's goal and the material. Define unfamiliar terms, build connections to relevant foundations, explain why procedures work, and use worked examples or comparisons when they clarify an idea. A diagram, table, or equation is useful when it communicates something prose alone does less clearly—not as a format checklist. Ground claims in sources and distinguish confirmed scope, supplemental explanation, and unknowns. Never invent learner answers, completion, or mastery; do not disclose private chain-of-thought.

## Choose a safe write

For an existing note, inspect its current content and live `documentVersion`. Use guarded `patch` for focused corrections; use guarded `replace` when a coherent full rewrite or reorganization best serves the requested explanation. Review the existing note and preserve content outside the requested scope. Both operations are atomic and version-guarded; atomicity protects the write but does not prescribe its scope. Preview with `--dry-run` when useful.

Use append/`stream` for new material when append is the intended workflow. Each accepted append is a separate delta and is not rolled back by later cancellation. Assessment-reference preparation follows the project workflow: finish source review and assemble the complete reference before one coordinated append-only Storm write. Do not split an unfinished reference into piecemeal writes or correction addenda. Follow more-specific user or project requirements.

Storm saves source edits independently from preview presentation. New prose, including a substantial rewrite, may be presented progressively; a focused correction may update immediately. Presentation does not change source truth or save/version guarantees. Do not pace or fragment prose to manipulate animation, promise timing, or clear/reappend material for appearance. Agent-reported phases are best-effort UI telemetry for concurrent operational work, not a prerequisite that blocks a valid write. A transient activity-delivery failure may warrant a warning, but does not make a valid session/write fail; closed-session or reconnect-required responses must not be blindly ignored. Document write/save failures and protocol errors remain stop-and-reconcile conditions. Follow the [CLI workflow](CLI-DESIGN.md) for live version guards, session ownership, save confirmation, cleanup, and readback.

## Write for understanding

Use plain-language headings to make a note navigable. Explain unfamiliar terms, connect new ideas to foundations and to each other, and distinguish confirmed source scope from supplemental explanation and unknowns. Include a worked example when it clarifies how an idea is used; explain why the steps work, not just the answer. For procedures, use ordered steps; for independent points, use bullets. Bold or italic emphasis should mark genuinely important terms or contrasts, and inline code should identify literal commands, symbols, or code.

Use Storm-supported Markdown selectively:

- A fenced code block with a language label for code or literal input.
- A fenced `mermaid` block for a real process, dependency, or conceptual relationship. Keep its syntax valid and its labels meaningful; omit a diagram when prose is clearer.
- `$...$` inline math or `$$...$$` display math when a mathematical relationship matters. Define variables and units in surrounding prose.
- A compact Markdown table when readers need to compare the same few properties across items. Prefer prose or lists when cells would become long or the table would be wide.
- A blockquote for a real constraint or attributed source wording, clearly identifying its source. Never invent a quotation.

Example of a concise explanation that connects a formula to its meaning:

> **Example — constant speed:** If a cyclist travels 12 km in 0.5 h, then $v = d/t = 12/0.5 = 24\,\mathrm{km/h}$. Here $d$ is distance and $t$ is elapsed time. The units reduce to distance per time, which is why the result is a speed.

A small diagram can clarify a dependency when it adds information beyond the prose:

```mermaid
graph LR
  Distance --> DivideByTime[Divide by elapsed time]
  Time --> DivideByTime
  DivideByTime --> Speed
```

Markdown rendering supports standard Markdown, fenced code, Mermaid, and KaTeX math; raw HTML is not rendered. See the [Markdown rendering notes](../src/components/Editor/README.md) for details and limitations.
