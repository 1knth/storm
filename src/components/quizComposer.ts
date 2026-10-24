const QUIZ_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

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
  for (const file of Array.from(data.files ?? [])) add(file);
  return images;
}

export function getQuizComposerIntent(
  draft: string,
  canSubmitAnswer: boolean,
  attachmentCount = 0,
  canRespondPrompt = false,
): 'message' | 'answer' | 'prompt' | null {
  if (draft.trim() || attachmentCount > 0) return 'message';
  if (canRespondPrompt) return 'prompt';
  return canSubmitAnswer ? 'answer' : null;
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
  return (
    leftItems.length > 0 &&
    leftItems.every((id) => !!matches[id]) &&
    new Set(leftItems.map((id) => matches[id])).size === leftItems.length
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
