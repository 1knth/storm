export async function confirmQuitAndFlush(
  confirm: () => Promise<boolean>,
  flush: () => Promise<boolean>,
): Promise<boolean> {
  if (!(await confirm())) return false;
  return flush();
}
