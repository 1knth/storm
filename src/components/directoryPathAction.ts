export async function runDirectoryPathAction(
  metaKey: boolean,
  path: string,
  actions: {
    openDirectory: () => Promise<void>;
    copyPath: (path: string) => Promise<void>;
    onCopied: () => void;
    onError: (message: string) => void;
  },
): Promise<void> {
  try {
    if (metaKey) {
      await actions.openDirectory();
      return;
    }
    await actions.copyPath(path);
    actions.onCopied();
  } catch (error) {
    actions.onError(
      `Could not ${metaKey ? 'open vault directory' : 'copy vault path'}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
