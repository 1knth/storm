# Teaching model: three critique and revision rounds

2026-10-26. Self-review of the proposal in `TEACHING-MODEL.md`, with repository
inspection and primary-source research. No subagents, external subject reviewer,
learner experiment, or implemented teaching behavior were involved. Scenario
results below are design dispositions, not passing software tests.

## Round 1: does the proposed authority establish enough?

**Objection:** syllabus + slides + textbook is a useful source policy, but not
proof of a complete course. A syllabus may list broad themes, slides may omit
spoken rationale, and selected chapters may omit prerequisite material.

**Revision:** coverage is conditional on an explicit, reviewed scope. Source
accounting and outcome coverage are separate. Unknown instruction remains a gap.
Content assurance, learner evidence, and course coverage are separate statuses.

**Objection:** the proposal assumes an available expert reviewer and risks making
ordinary self-study unusable until an entire course has been certified.

**Revision:** source-based self-study remains available with honest provisional
status. Reviewed units require accountable review of identified artifacts.
Evaluated instruction requires a specified learner-outcome evaluation. No mode
is described as institutionally approved merely because a learner accepted it.

**Objection:** review of foundations is being extended to unreviewed tutor output.

**Revision:** new examples, derivations, analogies, and factual extensions are
distinct from paraphrasing prepared content. Validate substantive new work and
audit live responses; review status applies to versions, not everything the tutor
may later say. Exact citations are necessary for traceability but insufficient
to establish accurate explanation.

**Open:** who can credibly review the first target course, and what original
instruction is absent from supplied material? These cannot be resolved without
a selected course and its actual sources.

## Round 2: does the model produce learning or just plausible activity?

**Objection:** an outcome checklist is not a model of understanding. Naming parts
can miss the relationships that make knowledge usable.

**Revision:** include domain-specific relationships, conditions of application,
and integrative outcomes. Separate observations from tentative learner diagnoses.
Use competing explanations for errors, rather than immediately labelling a
misconception. The next teaching action must depend on useful evidence.

**Objection:** guided practice can create easy success that is mistaken for
independent capability. A familiar problem with changed numbers may merely test
the same cue-response pattern.

**Revision:** record help conditions and task-family exposure. Include an
independent task that requires selecting the approach, plus a later check. Keep
retention and transfer separate. Do not infer outside-help absence from missing
in-app hint records.

**Objection:** the same system could author teaching, assess it with similar
questions, grade its own explanations, and declare itself effective.

**Revision:** formative checks, learner judgments, and evaluation of Storm are
separate purposes. Hold evaluation materials outside live tutor access. Use
independent authorship/blind scoring where feasible, inspect accepted as well as
rejected answers, and report disagreement and incomplete follow-up.

**Objection:** relentless diagnosis or Socratic questioning can displace actual
instruction and frustrate novices.

**Revision:** new material receives explanation and modelling. Use a brief probe
only when its result changes the instructional action. Direct questions receive
direct answers. Persisting difficulty changes representation or triggers a pause,
rather than producing an indefinite loop of near-identical questions.

**Open:** neither a universal mastery threshold nor an optimal adaptation policy
is established. Both require domain-specific tasks and empirical evaluation.

## Round 3: can this operate within Storm's constraints?

**Objection:** a large entity model and complete-course ingestion may delay any
useful teaching, while review of every live utterance is economically impossible.

**Revision:** pilot a small unit using five logical record groups: unit, lesson,
assessment, learning evidence, and session. Prepare/review core material once;
validate substantive new content and sample live output. Track preparation,
review, correction, and per-learner support effort. No claim of lower cost yet.

**Objection:** a review queue can consume the available learning time and leave
new material untaught. Personalized detours can erase breadth.

**Revision:** retain a next required outcome and explicit deferred work separately
from optional detours and reviews. Time constraints and learner choices are
recorded. A session may end with unfinished outcomes rather than a false complete
status. No arbitrary fixed review/new-content ratio is proposed as optimal.

**Objection:** source disagreements, grader uncertainty, and outages could block
all teaching or be incorrectly turned into learner failure.

**Revision:** quarantine the affected task/claim, leave it ungraded if needed, and
continue supported material. Preserve open issues and correct affected records
without rewriting historical submissions. Regrade criteria require explicit
versioning and explanation.

**Open:** source readers, retention changes, assessment records, and UI support
are not implemented. A document revision does not make existing quiz output
reviewed, grounded, or rubric-backed.

## Scenario audit

Each case is a hypothetical design exercise. The current runtime does not enforce
these proposed responses.

| Case                                                             | Required behavior                                                                                      | Remaining dependency                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Slide names a concept but all reasoning was spoken               | Mark missing instruction; use attributed supporting readings without claiming original coverage        | Actual lecture/transcript or reviewer clarification        |
| Source section is unreadable but its title matches an outcome    | Keep extraction gap open; exclude it from successful ingestion                                         | Reader/visual inspection                                   |
| Instructor convention differs from a textbook convention         | State assumptions and course expectation; do not call conventions factual contradictions automatically | Claim-specific judgment                                    |
| Instructor claim appears factually wrong                         | Preserve attribution; flag the issue; withhold ambiguous grading                                       | Subject review of the dispute                              |
| Correct source cited for an unsupported conclusion               | Fail semantic support even if quote/hash validates                                                     | Claim review and representative error evaluation           |
| Tutor invents a numerically incorrect worked example             | Validate computation; correct and trace affected attempts                                              | Computation tools and correction records                   |
| Tutor uses a misleading analogy                                  | Explain its limits or replace it; review any dependent inference                                       | Domain review of live explanation                          |
| Learner gives a valid answer absent from the rubric              | Reconsider the rubric and assess the reasoning; allow ungraded challenge                               | Reliable rubric assessment and review path                 |
| Learner gets a familiar question right after seeing its solution | Record supported practice/exposure, not independent mastery                                            | Attempt/help/task-family records                           |
| A sign mistake is mistaken for a conceptual misconception        | Retain competing hypotheses; inspect reasoning or use a discriminating task                            | Domain-specific learner model                              |
| Task wording or visual format creates an accessibility barrier   | Adapt representation; distinguish that barrier from subject knowledge                                  | Accessible task design and learner testing                 |
| Interesting detour uses the whole session                        | End coherently and show deferred required work                                                         | Persistent lesson plan and learner choice                  |
| Sources change after a question is answered                      | Preserve its original basis; flag dependent current content                                            | Durable versioned evidence                                 |
| Evaluation questions leak into tutoring                          | Treat evaluation as compromised; replace/restrict tasks and document exposure                          | Evaluation storage and access separation                   |
| No expert reviewer is available                                  | Offer provisional self-study; do not imply reviewed course replacement                                 | Honest product status and narrow claims                    |
| A model update changes grading or instruction                    | Recheck the evaluation set and affected content behavior before carrying forward assurance             | Versioned delivery configuration and regression evaluation |

## Concrete pilot and decisions

Select a bounded unit with explicit source permission, intended audience, and a
qualified reviewer if a reviewed claim is desired. The following sizes are
planning examples, not evidence-based optimal values: about 4–8 outcomes and one
normal lecture's intended scope. Bound scope by concepts and task complexity,
not a forced chat length. Do not invent a course pack before actual sources exist.

**Preparation:** inventory all unit materials and known gaps; build the
bidirectional outcome/source map; prepare the explanation, an application example,
a contrasting case, guided practice, and appropriate independent assessment.
Include one integration task if relationships are part of the outcome. A reviewer
checks core claims, coverage, examples, and rubric alternatives. Record real effort.

**Delivery:** use the existing conversation and Continue interactions, but record
which foundations were delivered, help used, learner work, interventions, and
deferred material. Keep optional learner questions available. Add a genuine
ungraded/needs-review path before relying on automated progress decisions.

**Evaluation:** first find content/usability failures. Then collect immediate
independent evidence and delayed follow-up on a predeclared schedule. A 1–2-week
follow-up is an illustrative feasible pilot choice, not a validated optimal
interval. Use held-out task families and inspect assessor disagreements. Determine
comparative-study design and sample size before making replacement claims.

**Decision rules:**

- Missing essential sources or unresolved critical claims: do not label the
  affected unit ready for reviewed replacement; supported self-study remains useful.
- Correct immediate performance but poor delayed/transfer evidence: revise
  instruction and practice, not merely the mastery display or verdict threshold.
- Repeated disagreement on valid answers: revise rubric/tasks or grading method
  before trusting automated progress judgments.
- Unacceptable author/reviewer effort: reduce pilot scope and improve reuse;
  do not silently remove review while retaining the same assurance claim.
- Inconclusive comparison: report uncertainty and continue evaluation; do not
  interpret lack of significance as equivalence.

## Current runtime boundary and implementation order

Source inspection found: `studyBasis` is optional on pose-question; when supplied,
the service checks snapshot scope/freshness. It does not validate each question
claim or bind a reviewed rubric. Reference verification in the Pi extension checks
delivered evidence, not substantive correctness. Feedback stores agent text and an
optional verdict. Current retrieval ranks lexical matches inside bounded scans;
it does not establish a complete instructional corpus or prerequisite structure.

1. Source inventory, explicit roles, and a small outcome/source map; persist gaps
   and provisional/reviewed status. Add the source readers required by the unit.
2. Durable lesson/item/rubric versions and evidence independent of active sessions.
   Reference these from questions and submissions; add ungraded and review outcomes.
3. Learning/session evidence and a simple explicit lesson policy. Make required
   deferred outcomes visible while preserving free questions and Continue.
4. Pilot evaluation and correction workflow; only then tune adaptation and review
   scheduling using observed learner performance and actual operating costs.

The target is evaluated teaching supported by recorded evidence. A stronger prompt,
a database migration, more citations, and more model calls are not substitutes
for that evidence.

## Primary evidence checked

- [National Research Council, Knowing What Students Know (2001)](https://www.nationalacademies.org/read/10019/chapter/2):
  assessment links a competence model, observations, and their interpretation;
  purposes differ. This supports separating task performance from broad claims
  and separating formative use from evaluation of Storm.
- [Kestin et al. (2025)](https://pmc.ncbi.nlm.nih.gov/articles/PMC12179260):
  the favorable physics result involved structured teaching, expert-crafted
  question-specific material, and video. It does not isolate generic model
  capability or establish semester-long replacement. Its discussion explicitly
  preserves a role for in-person higher-order instruction.
- The IES guide, Bastani experiment, and preliminary Liu working paper are
  linked with their boundaries in `TEACHING-MODEL.md`. They inform design choices;
  they do not validate Storm or establish one optimal teaching policy.

## Where this loop stops

Three rounds produced changes to authority claims, learner interpretation,
improvisation, evaluation independence, and implementation scope. The remaining
critical unknowns require actual course materials, qualified review where claimed,
and learner observations. Further self-review can refine the design, but cannot
replace those inputs or certify educational effectiveness.
