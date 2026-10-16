type SaveBinding = {
  currentView: object | null;
  bindingView: object;
  currentGeneration: number;
  bindingGeneration: number;
  currentNote: object | null;
  boundNote: object | null;
  blocked: boolean;
};

export function isCurrentSaveCompletion(binding: SaveBinding): boolean {
  return (
    binding.currentNote !== null &&
    binding.currentNote === binding.boundNote &&
    binding.currentView === binding.bindingView &&
    binding.currentGeneration === binding.bindingGeneration
  );
}

export function isSaveCompletionContentUnchanged(
  currentContent: string,
  savedContent: string,
): boolean {
  return currentContent === savedContent;
}

export function shouldSaveBoundDocument(binding: SaveBinding): boolean {
  return isCurrentSaveCompletion(binding) && !binding.blocked;
}
