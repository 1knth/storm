# Teaching model for replacing lecture instruction

Design proposal, 2026-10-26. This describes intended behavior, not implemented
capabilities or evidence that Storm can already replace lectures.

Revised through three self-critique rounds. See [review record](TEACHING-MODEL-REVIEW.md)
for objections, design responses, and unresolved validation work. Those rounds
are design analysis, not independent expert review or learner testing.

## Purpose and scope

Storm should deliver a coherent course of instruction, support questions and
practice, and establish whether learners can use the material independently.
Breadth, factual accuracy, authority, and demonstrated learning are distinct
requirements. No single score establishes all four.

The initial assumption is an existing course whose scope comes from its syllabus,
instructor materials, and assigned readings. A textbook-led course can use a
specified edition and chapter set instead. A learner-selected collection without
an authoritative scope remains a provisional study collection. Learner acceptance
of a plan does not constitute subject-expert approval.

The first replacement claim should concern one named unit, at a specified level,
against a named instructional comparator. Labs, performance skills, fieldwork,
discussion, and instructor judgment need their own provision and evaluation.
Replacing lecture instruction does not establish replacement of an entire course.

## Four contracts

Recommended source policy for an existing course: use the syllabus for the
required outcomes, instructor materials for emphasis and assessment conventions,
and the assigned textbook/recognized course readings for fuller explanations and
prerequisites. Consult appropriate primary research or standards for specific
factual disputes or currency-sensitive claims. This is a division of roles, not
an unconditional ranking of truth. The model receives explicit roles and relevant
passages rather than treating every retrieved document as equally authoritative.
If there are no instructor materials, anchor a provisional curriculum to a named
textbook edition and chapter set; do not present it as instructor-approved.

### 1. Breadth: define what must be learned

Create a versioned course map before offering a complete guided course. Each
required outcome states an observable capability, intended depth, prerequisites,
supporting source sections, teaching material, and aligned assessment criteria.
Include connections, assumptions, important exceptions, and representative
applications. A list of terms or a folder's headings is not a sufficient map.

The map has two directions: every required outcome points to supporting materials,
and every required source section is accounted for as mapped, excluded with a
reason, duplicated, or unresolved. Visuals, tables, worked solutions, spoken-only
content, and unreadable pages must be accounted for. If the original instruction
contains material absent from supplied files, record a missing input rather than
claiming complete replacement.

An agent proposes outcomes and prerequisite links; record proposed versus confirmed
links. Guided self-study may use a provisional map without expert confirmation.
A claim of reviewed course coverage requires a qualified subject reviewer to
confirm it. General background needed to explain an outcome may extend beyond assessed scope, but it
must be identified as prerequisite or supplemental material.

Report separate coverage measures with denominators tied to a course-map version:

- Source ingestion: required files/pages/visuals successfully inspected.
- Curriculum support: required outcomes with adequate supporting evidence.
- Instructional readiness: required outcomes with reviewed teaching and checks.
- Learner exposure: instruction actually delivered, or explicitly skipped.
- Independent performance: outcomes demonstrated at their required depth.
- Retention: outcomes checked again after a delay.

Never silently remove unsupported outcomes from a percentage's denominator.
Required missing outcomes stay visible as blocked. Optional expansion and learner
skips do not make required coverage appear complete. Show counts and named gaps
alongside percentages; a weighted total must not hide an essential missing unit.

### 2. Authority: establish who says what and in which context

Use a source registry with document identity, author/publisher, edition/date,
provenance, course role, scope, extraction status, and review status. Source role
and authority are assigned explicitly. Record who assigned them and whether that
assignment has subject review; a learner assignment may remain provisional. Filenames,
uploading, a source hash, or the model's confidence cannot establish authority.

Keep different forms of authority separate:

- Scope and assessment conventions: the syllabus and course owner's directions.
- Disciplinary claims: appropriate textbooks, primary evidence, standards, or
  other recognized sources for that subject and question.
- Learner notes: useful context and hypotheses, potentially incomplete or wrong.
- Tutor-generated examples and synthesis: derived teaching material requiring
  validation; they cannot become an independent authority by being saved.

There is no universal rule that a primary paper overrides a textbook, or that an
instructor's slide overrides disciplinary evidence. Authority depends on the
claim. In contested subjects, attribute competing interpretations and distinguish
consensus, a named framework, and open questions. In settled procedures, verify
assumptions, units, definitions, and edition-sensitive conventions.

When sources conflict, show the disagreement, its relevance to the course, and
whether it has been resolved. Present the course's expected convention as such.
Do not silently harmonize incompatible claims or teach a suspected factual error
as settled truth solely because it appears in instructor material. Block affected
assessment when the conflict makes an answer criterion unreliable.

### 3. Accuracy: validate both content and assessment

Prepare lesson foundations before guided delivery: definitions, central claims,
assumptions, reasoning, examples, counterexamples, and source references. Subject
review is required for a reviewed-unit claim, not for access to provisional
self-study. Important
claims link to retained source versions and exact passages or visual regions.
Support can be direct, derived with an explicit justification, supplemental,
disputed, or missing. These are provenance states, not calibrated probabilities.

Citation validation checks whether a reference resolves and contains the quoted
material. Semantic validation checks whether it actually supports the claim in
context. Subject review checks whether the source/claim is appropriate and
correct. None substitutes for the others.

Validate generated examples as carefully as source summaries. Check computations
with appropriate tools; test code when relevant; examine limiting cases, units,
counterexamples, and alternative interpretations. For assessments, prepare the
task, expected reasoning, acceptable alternatives, common misconceptions, partial
credit criteria, and evidence before showing the question. Keep assessment keys
separate from learner-facing material.

Free responses require rubric-based evaluation that can accept an unanticipated
valid answer. Record assessor/method and rubric version; permit learner challenge
and correction. Missing evidence, ambiguous wording, or unresolved source conflict
must support an ungraded/needs-review outcome. Do not force every response into
correct/partial/incorrect, and do not convert tool failures into learner errors.

Reviewing content with another model may catch problems, but agreement between
models is not independent evidence of correctness or expert approval. Use real
subject review and independent evaluation for the initial replacement pilot.

Correction has a lifecycle: identify affected lesson/question versions, correct
the explanation, notify affected learners where material, repair invalid grades,
and schedule appropriate reteaching. A source update marks dependent content for
revalidation; it must not silently rewrite historical attempts or their criteria.

### 4. Learning: establish independent capability

Track outcome-level observations rather than a single self-reported mastery
number: introduced, practiced with assistance, demonstrated independently,
demonstrated after a delay, or needs reassessment. Store the task, conditions,
hints, attempts, rubric, and assessment evidence behind each observation.

A correct choice can supply relevant evidence for a well-designed task, but a
single choice does not establish broad competence. Confident self-report, long
conversation, or delivered instruction do not themselves demonstrate independent
performance. Use task formats that match
the outcome: explanation, interpretation, derivation, application, argument, or
performance. Transfer tasks should vary relevant context and require choosing an
approach, not merely recalling the previous wording. Retention and transfer are
separate dimensions. Thresholds must fit the discipline and be evaluated before
displaying calibrated mastery estimates.

## Instruction and adaptation

### Distinguish the content model, learner model, and teaching policy

The content model specifies the target understanding: concepts and relationships,
procedures and their conditions of use, representative cases, and likely competing
explanations. Outcomes must include integration where the domain requires it.
Correctly identifying each part is not sufficient evidence of understanding how
the parts interact. Relevant prerequisites are hypotheses to check, not automatic
reasons to force a learner through an entire dependency tree.

The learner model stores observations and tentative interpretations separately.
An observation might be an incorrect prediction with a valid force diagram. A
tentative interpretation might be a sign error, an incorrect relationship between
force and velocity, unfamiliar wording, or missing assumptions. Attach supporting
attempt IDs and competing explanations. A mistake is not a diagnosis. Do not
retain speculative personal traits or a fixed learning-style label.

The teaching policy chooses an action using the outcome, available support,
observations, learner request, and practical constraints. A minimal policy is:

- New material with no useful prior evidence: explain and model it.
- A direct conceptual question: answer, connect it to the current lesson, and
  make additional practice available without making it compulsory.
- A specific error with interpretable reasoning: address the relevant step.
- Several plausible causes: use one discriminating question if its answer will
  change the teaching action. Otherwise explain the shared prerequisite directly.
- Repeated difficulty after intervention: change representation, revisit a
  prerequisite, reduce task complexity, or offer a pause; avoid repeated guessing.
- Demonstrated independent application: offer a suitable integration/transfer
  task or continue required new material. Arrange later retrieval separately.
- Unreliable source or task: withhold the affected grade, explain the issue,
  and continue unaffected instruction where possible.

Track the intervention and the subsequent observation so the policy can be
evaluated. More interaction is not automatically better; record learner time,
frustration, voluntary stopping, and whether interventions help. Do not infer
causal effectiveness from a before/after improvement in one conversation.

This design follows the National Research Council's distinction between a model
of competence, observations that can reveal it, and interpretation of those
observations. It is a proposed operationalization, not a validated cognitive
model for every discipline. [Assessment foundations](https://www.nationalacademies.org/read/10019/chapter/2)

### Keep course progress and repair work in balance

Maintain an explicit next required outcome and a separate list of optional
questions, prerequisite repairs, and due reviews. Agree on the learner's available
time and allow the lesson to end coherently. When an interesting detour consumes
the session, record deferred required material instead of silently dropping it.
When a repair does not help, change the approach rather than extending the same
loop indefinitely. These are planning records, not a rigid visible state machine.

Use a prepared instructional spine with adaptive delivery. A typical sequence is:
orient to the outcome and its purpose; explain the central idea and assumptions;
model its use; invite guided application; check independent use; connect it to
other outcomes; revisit after a delay. This is a repertoire, not a compulsory
template for every message or a fixed lesson length.

Give substantive explanation before practice when the learner is new. Use bounded
diagnosis when it will change instruction; do not require a pretest or make the
learner guess material they have never been taught. A direct clarification gets a
direct explanation. In practice, offer progressively stronger help and record
assistance; if a solution is shown, use a different task later to check learning.

Adapt examples, representations, pace, and prerequisite repair. Do not infer that
unasked-about topics are unnecessary, or silently drop required outcomes when
conversation follows an interesting tangent. Preserve the learner's ability to
ask questions, skip, revisit, or stop, and make remaining coverage visible.
Retain Storm's explicit Continue gate for advancing assessed questions.

A lesson ends with a coherent synthesis and an honest outcome record. Review is
one part of the course: it should revisit fragile learning while the instructional
plan continues to introduce required new material. Optimizing solely for missed
questions risks leaving untouched outcomes untaught.

## Example: one conceptual unit

Illustrative mechanics unit, not reviewed course content:

- Outcome: use a force model to predict motion and justify its assumptions.
- Breadth: identify the system and forces, distinguish net force from velocity,
  apply the relationship in a specified frame, and recognize its limitations.
- Instruction: explain the relationship; model a force diagram and calculation;
  contrast zero net force with zero velocity; guide a changed scenario.
- Assessment: ask for an independent prediction and justification in a new
  configuration, using a pre-reviewed rubric that accepts equivalent reasoning.
- Feedback: address the submitted reasoning and point to the relevant retained
  explanation. Unresolved assumptions trigger clarification, not an invented grade.
- Later check: a different context tests retention and application without hints.

For a history or literature unit, the equivalent evidence may be an attributed
interpretation, comparison of sources, and a reasoned argument. A correct-choice
quiz is not a universal proxy for the intended outcome.

## What changes in Storm

Current code provides scope-bounded Markdown retrieval, versioned snapshots,
conversational tutoring, multiple question formats, and optional verdicts. Source
roles remain unclassified; there is no persisted course map or lesson/rubric
contract. Reference verification establishes provenance, not semantic accuracy.
Current source and quiz retention limits are documented in `quiz-review-limits.md`.

Introduce durable entities for CourseVersion, SourceVersion, Outcome,
OutcomeSourceMapping, LessonVersion, AssessmentItemVersion, RubricVersion,
Attempt, LearnerOutcomeEvidence, ReviewSchedule, and ContentIssue. Record who
reviewed what and when. Keep review approval separate from model generation and
learner completion. Durable evidence must not depend on the current-question pin.

Separate responsibilities: course preparation establishes scope, source coverage,
and reviewed foundations; live tutoring retrieves those foundations and adapts
delivery; assessment uses versioned criteria and records evidence; audit/correction
tracks omissions and errors. These are logical application responsibilities,
not a requirement to run multiple agents. An agent cannot approve its own content
as subject-expert reviewed.

Application enforcement should reject missing references and inconsistent IDs,
preserve review states, and keep ungraded outcomes ungraded. Prompts should govern
explanation and conversational judgment. Source or curriculum text cannot grant
tool permissions. Runtime validation cannot certify semantic correctness.

Course preparation needs complete ingestion/accounting across the selected
corpus, even though each tutoring turn receives bounded context. Current query
retrieval of 64 notes and four captured matching sources is not a course audit.
PDF/slides/visuals/transcripts need reliable readers and explicit missing-content
states before making a replacement claim for courses using those formats.

Store authoritative versions, mappings, assessments, attempts, and schedules in
transactional persistence. Deduplicate retained source content and separate drafts
and activity from learning records. SQLite supports this architecture but does
not itself establish teaching quality or authority.

### Separate levels of assurance from access to learning

Support three explicit descriptions, without locking basic learning behind a
review process:

1. Source-based self-study: useful instruction from identified materials; the
   map, content, and assessment remain provisional where not reviewed.
2. Reviewed unit: a named reviewer and expertise, reviewed versions, scope, and
   limitations are recorded. The review applies only to those artifacts.
3. Evaluated instruction: the named delivery configuration has been evaluated
   for a stated population, comparator, and outcomes, with uncertainty reported.

These descriptions are independent of a learner's progress. A student can perform
well on provisional material; a reviewed unit can teach a particular student
poorly. Do not collapse content assurance, course coverage, and learner evidence
into one green badge. No autonomous process can manufacture institutional authority.

### Bound improvisation without preventing useful teaching

Prepared foundations cover core definitions, claims, examples, assumptions,
assessment criteria, and known issues. Live paraphrases, analogies, new examples,
and extensions do not automatically inherit their review status. An analogy must
identify its useful correspondence and limits when those limits affect the
explanation. Validate new calculations/examples; otherwise identify uncertainty
or fall back to a supported example. Sampling ordinary tutor responses remains
necessary even when prepared material was reviewed.

For a course-coverage explanation, retrieve the mapped source material and relevant
qualifiers, rather than using a top search hit as the entire foundation. Classify
a follow-up as supported explanation, new derivation, new example, or external
extension. Only substantive unsupported/conflicted claims need interruption; do
not burden every sentence with a warning or treat grammar changes as new claims.
Source evidence establishes a basis, not a semantic guarantee.

### Minimum viable learning records

The full entity list above is a target architecture, not a prerequisite for a
first teaching pilot. Begin with five logical record groups, backed by versioned
storage and references:

- Unit: scope, target audience, source inventory, proposed/confirmed outcomes,
  required relationships, and unresolved content gaps.
- Lesson: versioned foundations, mapped source passages/visuals, reviewed examples,
  review status, and an instructional plan.
- Assessment: task/version, target outcome, rubric/version, accepted alternatives,
  help conditions, exposure group, and review status.
- Learning evidence: submitted work, observed help, assessment result/method,
  tentative interpretations, and subsequent checks.
- Session: current plan, instruction delivered, deferred outcomes, interventions,
  and learner choices. Link corrections across these records.

Start manually with a small unit, using reusable structured templates. Automate
what proves repetitive. Measure authoring, subject review, grading challenges,
correction, and ongoing support time alongside model costs. A teacher's lecture
reaches many students; an automated live tutor incurs work per learner and may
create follow-up review obligations. There is no established break-even point
until these costs and reuse are observed.

## Evidence needed before claiming lecture replacement

Start with one representative unit and a qualified subject reviewer. Produce its
source register, map, reviewed lesson foundations, rubrics, and unresolved-gap list.
Define the population, comparator, outcomes, evaluation conditions, and acceptable
margin before looking at results. Use a pilot to find failures, not to certify
effectiveness from a tiny convenience sample.

Audit content on accuracy, substantive omissions, scope/depth alignment,
representation of uncertainty, citation support, and assessment validity. Sample
ordinary explanations as well as prepared lesson text. Test wrong learner premises,
valid unexpected answers, ambiguous tasks, missing diagrams, outdated sources,
contradictory documents, and attempts to induce unsupported claims.

Evaluate learning with independently authored or held-out tasks and blind scoring
where feasible. Compare immediate independent performance, delayed retention,
transfer, time burden, completion, and accessibility across learners with different
starting knowledge. Satisfaction and assisted success are secondary measures.
Any noninferiority claim needs an appropriate design, sample size, margin, and
uncertainty interval; failing to find a difference is not proof of equivalence.

Separate formative checks, learner progress judgments, and evaluation of Storm
itself. The live tutor must not access held-out evaluation tasks, rubrics, or
answers before testing; adaptively teaching to those tasks would contaminate the
result. Record task-family exposure, not just item IDs: changing names/numbers
does not establish transfer. In an ordinary desktop session, no recorded hint
means no hint observed by Storm, not proof that no outside help was used.

Report grader disagreement and review a sample of accepted answers as well as
rejections; false positives can inflate progress. Keep tool/parser failures,
source/task defects, accessibility barriers, and learner errors separate. Review
the representation and language demands of a task before attributing poor
performance to the target concept. Optional learner self-assessment remains
distinct from independently assessed performance.

Use staged evaluations: first test usability and content failures; then test
whether target outcomes can be demonstrated; then perform a sufficiently designed
comparison. Include dropout and missing delayed follow-up in reporting instead
of analyzing only successful completers. A favorable immediate pilot does not
establish long-term replacement.

Content review and outcome evaluation are separate release gates. No known
unresolved critical content error should ship as reviewed, but an audit finding no
errors does not prove error-free content. Establish quantitative tolerances and
escalation policy with the subject reviewer rather than inventing a universal
accuracy percentage. Report the validated unit and population, not a blanket
guarantee about all courses or future model versions.

## Research basis and boundaries

These findings inform the proposal; they do not validate Storm's implementation.

- The [IES practice guide](https://ies.ed.gov/ncee/wwc/PracticeGuide/1) recommends
  spacing, alternating worked examples and problems, connecting representations,
  retrieval, and explanatory questions. It rates the evidence for individual
  recommendations differently. These practices inform the instructional repertoire
  above, not a universal mandatory sequence.
- [Bastani et al., PNAS (2025)](https://pmc.ncbi.nlm.nih.gov/articles/PMC12232635/)
  studied high-school mathematics practice following teacher instruction. The
  general chat condition improved assisted practice but reduced subsequent
  unassisted performance; teacher-designed hints and solution-informed tutoring
  mitigated the harm without establishing an independent exam advantage. This is
  evidence to distinguish assisted performance from learning, not proof that
  safeguarded tutoring replaces initial instruction.
- [Kestin et al., Scientific Reports (2025)](https://doi.org/10.1038/s41598-025-97652-6)
  reported greater learning from a structured AI tutor than in-class active learning
  in its undergraduate physics experiment. The reported success does not establish
  whole-course replacement, long-term retention, or generalization to every subject.
  The reported system combined expert-authored problem-specific solutions,
  structured activities, and instructional video. Its result cannot be attributed
  to a general-purpose model alone. The authors discuss using such instruction
  alongside in-person higher-order learning. [Full text](https://pmc.ncbi.nlm.nih.gov/articles/PMC12179260)
- [Liu et al., IZA discussion paper (October 2026)](https://docs.iza.org/dp18989.pdf)
  reports adverse course-grade and participation outcomes from access to a
  course-integrated assistant. This is preliminary work. Uptake was low and most
  instructors used direct-answer mode, so it does not settle the effectiveness of
  the scaffolded instruction proposed here. It does reinforce the need to evaluate
  actual implementation and independent learning rather than assume grounded chat
  is sufficient.

## Suggested first increment

Build one reviewed unit end to end: an explicit outcome/source map, complete
source-accounting report, prepared lesson foundations, rubric-backed checks, and
an independent delayed assessment. Let the tutor adapt explanation while keeping
required coverage visible. Use that unit to establish the course-authoring and
evaluation workflow before adding automated course-wide generation or a detailed
mastery dashboard. Review scheduling follows reliable outcome/attempt evidence.
