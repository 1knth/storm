export function vaultImageErrorMessage(error: unknown): string {
  const message =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : '';
  const normalized = message.replace(/^Error:\s*/, '').trim();

  if (/^Image not found$/i.test(normalized))
    return 'Image not found in this vault.';
  if (/^Ambiguous image path$/i.test(normalized))
    return 'Multiple matching images found in this vault.';
  if (
    /^(?:Unsupported image type|Image content does not match its file type|Image is not a regular file|Symbolic-link images are not supported|Image exceeds the 10 MB size limit|Image lookup exceeded its scan limit|EACCES:|EPERM:|EISDIR:)/i.test(
      normalized,
    )
  )
    return 'Image is unreadable or uses an unsupported format.';
  if (
    /^(?:Image path must be vault-relative|Image path is outside the vault|Note path is outside the vault)$/i.test(
      normalized,
    )
  )
    return 'Image must be stored inside this vault.';
  if (/^(?:Unknown vault|Invalid vault ID)$/i.test(normalized))
    return 'The image’s vault is unavailable. Reopen the note from an available vault.';
  if (
    /^(?:Invalid image request|Invalid note path|Invalid image path|Invalid image kind)$/i.test(
      normalized,
    )
  )
    return 'Image could not be loaded because its note context is unavailable.';
  return 'Image could not be loaded. Check that the file is available in this vault.';
}
