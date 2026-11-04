import { isQuizConfidence } from '../shared/quizProtocol';
import type { QuizLearnerRequest, QuizQuestion } from '../shared/quizProtocol';

export const QUIZ_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

export function getClipboardImages(data: {
  items?: ArrayLike<{
    kind: string;
    type: string;
    getAsFile(): File | null;
  }> | null;
  files?: ArrayLike<File> | null;
}): File[] {
  const images: File[] = [];
  const seen = new Set<File>();
  const add = (file: File | null | undefined) => {
    if (file && QUIZ_IMAGE_TYPES.has(file.type) && !seen.has(file)) {
      seen.add(file);
      images.push(file);
    }
  };
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === 'file' && QUIZ_IMAGE_TYPES.has(item.type))
      add(item.getAsFile());
  }
  // Chromium exposes the same pasted image through both `items` and `files`
  // as distinct File objects, so only fall back to `files` when `items` is empty.
  if (!images.length)
    for (const file of Array.from(data.files ?? [])) add(file);
  return images;
}

export function shouldClearSubmittedDraft(
  currentDraft: string,
  submittedDraft: string,
) {
  return currentDraft === submittedDraft;
}

export function getQuizComposerIntent(
  draft: string,
  attachmentCount = 0,
  canRespondPrompt = false,
): 'message' | 'prompt' | null {
  if (draft.trim() || attachmentCount > 0) return 'message';
  if (canRespondPrompt) return 'prompt';
  return null;
}

export function getQuizConfidenceLabel(confidence: number): string {
  if (confidence <= 20) return 'Guessing';
  if (confidence <= 45) return 'Unsure';
  if (confidence < 70) return 'Fairly sure';
  if (confidence <= 90) return 'Confident';
  return 'Certain';
}

type QuizAnswerFields = Pick<
  Extract<QuizLearnerRequest, { type: 'answer' }>,
  'choiceId' | 'reasoning' | 'matches' | 'answer' | 'confidence'
>;

export function getQuizAnswerFields(
  question: QuizQuestion,
  confidence: number | null,
): QuizAnswerFields | null {
  const kind = question.kind ?? 'multiple-choice';
  if (
    question.status !== 'open' ||
    !isQuizConfidence(confidence) ||
    !isCompleteQuestionAnswer(kind, {
      choiceId: question.selectedChoiceId,
      leftItems: question.leftItems?.map((item) => item.id),
      matches: question.matchesDraft,
      text: question.textDraft,
    })
  )
    return null;
  if (kind === 'multiple-choice')
    return {
      choiceId: question.selectedChoiceId!,
      reasoning: question.reasoningDraft,
      confidence,
    };
  if (kind === 'matching')
    return {
      matches: question.matchesDraft,
      reasoning: question.reasoningDraft,
      confidence,
    };
  return { answer: question.textDraft, confidence };
}

export function isCompleteQuestionAnswer(
  kind: 'multiple-choice' | 'matching' | 'short-answer' | 'long-answer',
  value: {
    choiceId?: string | null;
    leftItems?: string[];
    matches?: Record<string, string>;
    text?: string;
  },
): boolean {
  if (kind === 'multiple-choice') return !!value.choiceId;
  if (kind === 'short-answer' || kind === 'long-answer')
    return !!value.text?.trim();

  const leftItems = value.leftItems ?? [];
  const matches = value.matches ?? {};
  const matchValues = leftItems.map((id) => matches[id]);
  return (
    leftItems.length > 0 &&
    matchValues.every((id) => !!id) &&
    new Set(matchValues).size === leftItems.length
  );
}

export function handleQuizComposerEnter(
  event: {
    key: string;
    shiftKey: boolean;
    isComposing: boolean;
    preventDefault(): void;
  },
  canSend: boolean,
  send: () => void,
): void {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  if (canSend) send();
}

/** The Pi route needs only the command: the extension's attach prompt carries
 * the tutoring, waiter-ownership, and Continue rules once attached. */
export function quizPiAttachCommand(sessionId: string): string {
  return `/storm-quiz attach ${sessionId}`;
}

/** Agents without the extension get bootstrap facts plus a pointer to CLI help,
 * which documents the wait/request workflow, cursors, and token privacy. */
export function quizCliInstructions(
  sessionId: string,
  scoped: boolean,
): string {
  const sourceGuidance = scoped
    ? 'Inspect scope, current question, transcript, and relevant source material.'
    : 'Sources not selected. Ask the learner for notes or a directory to use as source material.';
  return `Storm quiz session ${sessionId}. Run \`storm quiz attach ${sessionId}\` (in a Storm source checkout: \`bun scripts/storm.ts quiz attach ${sessionId}\`). Read \`storm quiz --help\` first for the wait and request workflow. Keep \`result.value.agentToken\` private: never print, log, or save it. Stay running between learner responses; \`wait\` blocks a process and does not keep your host alive. Never assign a verdict to a chat command submitted as an answer. ${sourceGuidance}`;
}
