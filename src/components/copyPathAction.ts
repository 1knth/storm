export async function copyPathAction(
  path: string,
  options: {
    writeText: (path: string) => Promise<void>;
    onCopied: () => void;
    onError: (message: string) => void;
  },
): Promise<void> {
  try {
    await options.writeText(path);
    options.onCopied();
  } catch (error) {
    options.onError(
      `Could not copy file path: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
