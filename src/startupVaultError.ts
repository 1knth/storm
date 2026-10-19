export const STARTUP_VAULT_ERROR =
  'Storm couldn’t load notes from this vault. Check that the vault folder is available, then try again.';

export function shouldNotifyVaultError(
  previous: string | null,
  next: string | null,
): boolean {
  return next !== null && next !== previous;
}
