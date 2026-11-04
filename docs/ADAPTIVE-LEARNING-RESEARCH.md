# Adaptive learning: evidence and a fit for Storm

Research note, 2026-11-01. Design investigation only; no runtime behavior changed.
It complements [the teaching model](TEACHING-MODEL.md), which covers authority,
accuracy, and evaluation. This note covers efficiency: what to practice next,
when, and at what difficulty.

## Implementation status (2026-11-01)

Phases 0 to 3 below are implemented; phase 4's cross-session due queue is
computed (due reviews appear in learner recommendations) but has no dedicated
"Review due" entry in the UI. Phase 5 evaluation has not been run.

- Protocol: `pose-question` accepts `concepts` (1-3 slugs), `level`, and
  `support`; learner answers carry `confidence` (0-100, set with a slider that
  starts unrated). Validation is shared (`quizLearningFromRequest`).
- Model: `src/shared/learnerModel.ts` replays attempts into per-concept Elo
  ability (independent and assisted), FSRS-style stability with fixed default
  weights, zones, recommendations, and calibration.
- Storage: `LearnerStore` persists attempts only, per vault, idempotent by
  question ID. Unscoped sessions are isolated by session ID; rated untagged
  grades are calibration-only evidence with unknown support.
- Agent surface: `storm quiz learner SESSION_ID --token TOKEN` and the Pi
  `storm_quiz` `learner` action; Tutor prompts carry the session policy below.

All numeric parameters (band, level difficulties, K-factor, stability weights,
confident-error threshold) are unfitted starting values.

### Reliability and confidence changes

Questions retain the strongest assistance supplied before submission, including
help given after posing. Failed assisted attempts do not justify removing help.
Confident partial answers are diagnosis candidates rather than automatic full
misconceptions. Assisted misconceptions stay visible without changing independent
memory evidence. Confidence rechecks count practice since the original error, including assisted
remediation, or a review gap. Assisted remediation does not restart the wait;
practice recommendations retain the support the learner still needs.

Calibration exposes absolute confidence error as well as signed bias, and counts
independent, assisted, and unknown support. Pattern commentary requires at least
20 rated attempts and an absolute bias of at least 15 percentage points; these
are tunable defaults, not validated diagnostic thresholds. Tutor discusses these
patterns supportively at most once per session unless asked. Durable grades are
reconciled on startup and before learner reads so a failed derived-record write
can be retried without duplicating an attempt or changing its grading time.

## Recommendation

The largest, best-established gains come from retrieval practice, spacing, and
interleaving across sessions. ZPD-style difficulty targeting is worth building,
but as a small deterministic learner model in the main process that the Tutor
reads. The LLM should not be the learner model. Classical IRT adaptive testing
does not fit Storm's single-learner, generated-item setting, except as a short
placement probe.

All of this depends on one missing piece: durable, structured attempt records
that persist across sessions. Without them, spacing and difficulty targeting can
only work within one conversation.

## What Storm does today

- Tutor chooses each question from conversation context alone
  (`skills/storm/TUTOR.md`, `extensions/storm-quiz.ts`).
- A question has a kind, prompt, choices, optional `studyBasis`, and an optional
  agent `verdict` (`src/shared/quizProtocol.ts`). It has no concept/outcome tag,
  difficulty level, help condition, learner confidence, or latency.
- Attempts are not durable entities and there is no review queue or due date
  (`docs/quiz-review-limits.md`). A new session knows nothing about earlier
  performance.

## Evidence, by strength and fit

| Technique                                   | Evidence                                                                                                                                                                                                                                                                  | Implication for Storm                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Retrieval practice                          | Roediger & Karpicke (2006); Adesope et al. (2017) meta-analysis; Dunlosky et al. (2013) rate it high utility                                                                                                                                                              | Storm already quizzes. Keep retrieval central rather than re-explaining before every check      |
| Spacing                                     | Cepeda et al. (2006) meta-analysis; Cepeda et al. (2008): the optimal gap grows with the retention interval but shrinks as a fraction of it                                                                                                                               | Needs cross-session scheduling. Fixed intervals are a weak substitute                           |
| Personalized spacing                        | Lindsey et al. (2014): over a semester, personalized review beat massed study by 16.5% and generic spacing by 10.0% on a cumulative exam. Mettler et al. (2016): accuracy + response-time adaptive spacing beat fixed schedules, with gains persisting and transferring   | Per-item/per-concept memory state is worth modelling, not just a global schedule                |
| Successive relearning                       | Rawson & Dunlosky: retrieve to criterion, then relearn in later spaced sessions                                                                                                                                                                                           | "Mastered once" is not done. Bring it back later                                                |
| Interleaving                                | Rohrer et al. (2020): preregistered RCT, 54 classes, d = 0.83 on a delayed test; interleaved work took longer                                                                                                                                                             | Mix earlier concepts in once two or more are introduced, especially look-alike problem types    |
| Worked examples, fading, expertise reversal | Kalyuga (2007): guidance that helps novices can hurt advanced learners. Salden et al. (2010): adaptive fading beat fixed fading, which beat plain problem solving                                                                                                         | Support level must adapt per learner and concept, and be recorded                               |
| Confidence and feedback                     | Butterfield & Metcalfe (2001): high-confidence errors are _more_ likely to be corrected after feedback (hypercorrection). Shute (2008) reviews formative feedback                                                                                                         | Collect confidence; give confident errors explicit elaborated correction and earlier review     |
| Difficulty targeting / ZPD                  | Vygotsky; Wood, Bruner & Ross (1976) on scaffolding. Metcalfe & Kornell (2005): learners do best studying the easiest items not yet learned. Clement et al. (2015, ZPDES): bandit sequencing by learning progress matched or beat an expert's sequence with ~400 children | Choose the next item from concepts that are not yet independent but are achievable with support |
| "85% rule"                                  | Wilson et al. (2019): for gradient-descent learners, ~85% training accuracy is optimal. Shown in models and simple binary tasks; the author cautions against applying it to school grading                                                                                | A starting band to tune, not a validated human target                                           |
| Step-based tutoring                         | VanLehn (2011): step-based ITS d ≈ 0.76 vs no tutoring; human tutoring ≈ 0.79. Kulik & Fletcher (2016): median 0.66                                                                                                                                                       | Feedback on reasoning steps matters more than a final-answer verdict                            |
| LLM tutors                                  | Bastani et al. (2025): unguarded chat helped assisted practice but hurt later unassisted performance. De Simone et al. (2025): 0.23 SD gain in English in a structured 6-week program                                                                                     | Structure and guardrails decide whether an LLM tutor helps (see TEACHING-MODEL.md)              |
| LLMs as difficulty/knowledge estimators     | Zotos et al. (2025): weak correlations. Li et al. (2025): LLMs systematically overestimate human ability. LLM knowledge tracing roughly matches BKT at best (arXiv 2403.14661)                                                                                            | Do not trust the Tutor's sense of "this is the right difficulty". Calibrate from attempts       |
| Learning styles                             | Pashler et al. (2008): no adequate evidence for matching instruction to style                                                                                                                                                                                             | Do not model or store learning styles                                                           |

A nuance on pretesting: Richland, Kornell & Kao (2009) found that a failed attempt
before instruction can improve later learning. That is compatible with
TEACHING-MODEL.md's rule against making learners guess untaught material only if
the pretest is brief, ungraded, and immediately followed by instruction.

## What ZPD means operationally

Vygotsky defined the ZPD as the gap between what a learner can do alone and what
they can do with help. Accuracy alone cannot locate it; it needs **two signals per
concept: independent success and assisted success.** That is why the help
condition must be part of every attempt record.

| Zone         | Evidence                                                   | Policy                                                                   |
| ------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| Independent  | Independent success stays high, including after a delay    | Spaced review only; offer transfer or integration tasks                  |
| ZPD          | Succeeds with support; independent success low or unstable | Practice here, fading support from worked example to hint to independent |
| Beyond reach | Fails even with support                                    | Teach directly, use a worked example, check the prerequisite             |

During practice, aim for predicted independent success in a band of about
0.70–0.85, then tune it from delayed outcomes. Following Metcalfe & Kornell,
choose the easiest ZPD concept first. Following ZPDES, move toward concepts where
recent success is _rising_, and away from concepts that have plateaued at either
extreme.

## Why not classical adaptive testing

IRT-based CAT needs an item bank calibrated on many respondents. Storm generates
items live for one learner and rarely reuses them, so per-item difficulty cannot
be estimated. CAT also selects items near 50% success because that maximizes
_measurement_ information. That level is too hard for learning and discouraging.

Keep two ideas from CAT:

- **Placement probe** for a new scope: a few items at increasing levels per
  concept, stopping once uncertainty is low. Kalyuga & Sweller's (2005) rapid
  first-step assessment is the closest validated analogue.
- **Difficulty attached to levels, not items:** estimate difficulty per cognitive
  level (recall / explain / apply / transfer), which recurs, instead of per
  generated item, which does not.

## Proposed learner model

**Concept registry, per scope.** Stable IDs with Tutor-proposed names and source
sections, so evidence accumulates on stable concepts. It later becomes the
Outcome entity in TEACHING-MODEL.md. Tutor must reuse existing IDs and propose new
ones explicitly, otherwise tags drift and evidence fragments.

**Attempt record.** Question ID, 1–3 concept IDs, `level`, `support`
(`independent | hinted | worked`), verdict (correct = 1, partial = 0.5,
incorrect = 0; ungraded excluded), optional learner confidence (0–100, in steps
of 5), latency, and timestamp. Store it in the durable store recommended in
`quiz-review-limits.md`.

**Ability: Elo per concept** (Pelánek 2016). Expected success is
`logistic(θ_concept − b_level)`, with a K-factor that shrinks as evidence grows.
It is cheap, explainable, robust with sparse data, and needs no training set.
Independent attempts update θ; assisted attempts update a separate assisted
estimate. Together they locate the zone. BKT is an alternative once the concept
structure is reliable. Deep knowledge tracing needs far more data than one
learner produces.

**Memory: retrievability per concept.** A difficulty/stability/retrievability
model, as in FSRS (Ye et al., KDD 2022; open source, benchmarked on large Anki
review datasets), gives each concept a due date. Ability and retention stay
separate dimensions, as TEACHING-MODEL.md requires. Response time can refine
multiple-choice scheduling, as in ARTS; free-text latency is too noisy to use.

**Tool surface.** A read-only `learner` action on `storm_quiz` returns compact
state for the attached scope: each concept's zone, evidence counts, predicted
success per level, due reviews, and up to three candidate next items with a
one-line reason. Tutor still chooses and teaches; the application owns the
numbers, so they stay deterministic and auditable. This follows TEACHING-MODEL.md:
prompts govern pedagogy and the application enforces records.

## Session policy

When the learner presses Continue:

1. **Due reviews:** interleave due items with current work, capped at roughly a
   third of items, so review does not crowd out required new material.
2. **Otherwise:** pick the current or next ZPD concept, at the level whose
   predicted success is in the band.
3. **After two misses at one level:** step down a level or add support, such as
   a worked example or contrasting case. Do not pose another item of the same
   kind.
4. **Above the band independently:** raise the level, offer a transfer task, or
   move to the next concept.
5. **High-confidence error:** give an explicit, elaborated correction and
   schedule an earlier re-check.
6. **Learner choice wins:** Kornell & Metcalfe (2006) found that learners learned
   more when their study choices were honored. Recommendations stay
   recommendations, and Continue and Skip semantics stay as they are.

## Implementation order

0. **Prompt only** (`TUTOR.md`): favor retrieval over re-explaining, interleave
   earlier topics within a session, fade from worked example to independent
   attempt, ask for confidence on substantive answers, and treat confident errors
   explicitly. No infrastructure is needed, but the benefit is limited to a single
   session.
1. **Protocol:** add optional `concepts`, `level`, and `support` to
   `pose-question`, and optional `confidence` to learner `answer`. These are
   backward compatible, like `studyBasis`. Use the explicit 0–100 confidence slider
   (steps of 5) in
   `QuizPane`.
2. **Durable attempts and concept registry**, in the SQLite store already
   recommended for review.
3. **Elo learner model** and the `learner` action; include it in compact recovery
   context.
4. **Cross-session due queue** with FSRS-style scheduling, plus a "Review due"
   entry when a session opens.
5. **Evaluation:** predeclared delayed checks on held-out tasks; randomize
   recommended versus Tutor-only sequencing at the concept level within a learner;
   report retention, time, and voluntary stopping, not just in-session accuracy.

## Risks

- **Grader noise:** LLM verdicts feed the model. Weight partial verdicts, allow
  learner challenge, never turn tool failures or ungraded items into incorrect
  answers, and audit accepted answers as well as rejected ones.
- **Goodhart:** optimizing predicted success favors easy recall. Levels must climb
  toward transfer, and in-session accuracy is not the target metric.
- **Concept drift and granularity:** concepts that are too coarse hide gaps;
  concepts that are too fine starve each estimate of evidence.
- **Over-adaptation:** constant difficulty adjustment can feel opaque. Show
  evidence counts and reasons instead of one mastery percentage.
- **Unvalidated parameters:** the success band, review cap, Elo K, and FSRS
  defaults are starting points to evaluate, not established optima for Storm's
  learners.

## Sources

- Adesope, Trevisan & Sundararajan (2017), [Rethinking the use of tests](https://doi.org/10.3102/0034654316689306), _Review of Educational Research_.
- Bastani et al. (2025), [Generative AI without guardrails can harm learning](https://pmc.ncbi.nlm.nih.gov/articles/PMC12232635/), _PNAS_.
- Butterfield & Metcalfe (2001), hypercorrection of high-confidence errors; review in [Metcalfe & Finn](https://pmc.ncbi.nlm.nih.gov/articles/PMC3079415).
- Cepeda, Vul, Rohrer, Wixted & Pashler (2008), [Spacing effects in learning: a temporal ridgeline](https://www.evullab.org/pdf/CepedaVulRohrerWixtedPashler-PS-2008.pdf), _Psychological Science_.
- Clement, Roy, Oudeyer & Lopes (2015), [Multi-armed bandits for intelligent tutoring systems](https://arxiv.org/abs/1310.3174), _JEDM_.
- De Simone et al. (2025), [From chalkboards to chatbots](https://openknowledge.worldbank.org/entities/publication/15e1ff08-15ae-4f7a-b2a8-d146e6c113ee), World Bank PRWP 11125.
- Dunlosky et al. (2013), Improving students' learning with effective learning techniques, _Psychological Science in the Public Interest_.
- Kalyuga (2007), [Expertise reversal effect and its implications for learner-tailored instruction](https://doi.org/10.1007/s10648-007-9054-3), _Educational Psychology Review_; Kalyuga & Sweller (2005), rapid dynamic assessment, _ETR&D_ 53.
- Lindsey, Shroyer, Pashler & Mozer (2014), [Improving students' long-term knowledge retention through personalized review](https://journals.sagepub.com/doi/abs/10.1177/0956797613504302), _Psychological Science_.
- Metcalfe & Kornell (2005), [A region of proximal learning model of study time allocation](https://psychology.columbia.edu/sites/default/files/2016-11/Metcalfe.Kornell.2005_0.pdf), _JML_.
- Mettler, Massey & Kellman (2016), [A comparison of adaptive and fixed schedules of practice](https://pmc.ncbi.nlm.nih.gov/articles/PMC6028005), _JEP: General_.
- Pashler, McDaniel, Rohrer & Bjork (2008), Learning styles: concepts and evidence, _PSPI_.
- Pelánek (2016), [Applications of the Elo rating system in adaptive educational systems](https://www.fi.muni.cz/~xpelanek/publications/CAE-elo.pdf), _Computers & Education_.
- Rawson & Dunlosky (2022), [Successive relearning](https://journals.sagepub.com/doi/full/10.1177/09637214221100484), _Current Directions in Psychological Science_.
- Richland, Kornell & Kao (2009), The pretesting effect, _JEP: Applied_.
- Roediger & Karpicke (2006), Test-enhanced learning, _Psychological Science_.
- Rohrer, Dedrick, Hartwig & Cheung (2020), [A randomized controlled trial of interleaved mathematics practice](https://ies.ed.gov/ncee/wwc/Study/88770), _Journal of Educational Psychology_.
- Salden, Aleven, Schwonke & Renkl (2010), The expertise reversal effect and worked examples in tutored problem solving, _Instructional Science_ 38(3).
- Shute (2008), Focus on formative feedback, _Review of Educational Research_.
- VanLehn (2011), The relative effectiveness of human tutoring, intelligent tutoring systems, and other tutoring systems, _Educational Psychologist_; Kulik & Fletcher (2016), _Review of Educational Research_.
- Wilson, Shenhav, Straccia & Cohen (2019), [The eighty five percent rule for optimal learning](https://pmc.ncbi.nlm.nih.gov/articles/PMC6831579), _Nature Communications_.
- Wood, Bruner & Ross (1976), The role of tutoring in problem solving, _Journal of Child Psychology and Psychiatry_.
- Ye, Su & Cao (2022), A stochastic shortest path algorithm for optimizing spaced repetition scheduling, _KDD_; [open-spaced-repetition](https://github.com/open-spaced-repetition).
- LLM difficulty estimation: [Zotos et al., EDM 2025](https://educationaldatamining.org/edm2025/proceedings/2025.EDM.long-papers.104/2025.EDM.long-papers.104.pdf); [Li et al. 2025](https://arxiv.org/abs/2512.18880). LLM knowledge tracing: [arXiv 2403.14661](https://arxiv.org/abs/2403.14661); [Cho et al. review](https://arxiv.org/abs/2412.09248).

### Confidence interaction diagnostics

Storm keeps bounded, local aggregate counters under
`storm.quizConfidenceMetrics.v1` in renderer local storage. They count answer-form
observations, forms rated, forms submitted, exits without a rating, time to first
rating, and time to submission. Reopening a form is another observation. An exit
is not proof of abandonment caused by the slider. Counters contain no answer text,
confidence values, session IDs, or network telemetry; clearing local storage
resets them. Compare these observations with usability feedback before changing
the required-rating interaction or adopting a smaller set of confidence options.

Grade replay merges all missing/changed grades by learning pool in a single
load/compare/write per pool. Successful grade fingerprints are remembered for
the process lifetime, while failures remain retryable; unchanged learner reads
avoid re-recording the full history. The durable transcript remains the source
for recovery after a restart. `recording.failures` counts failures still associated
with unresolved work and clears after successful recovery; `pending` determines
whether evidence is incomplete.
