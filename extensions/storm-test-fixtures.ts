/** Shared Pi registration and bounded asynchronous assertions for extension tests. */
export function piRegistry() {
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const listeners = new Map<string, Function[]>();
  return {
    commands,
    tools,
    listeners,
    host: {
      registerCommand: (name: string, options: any) =>
        commands.set(name, options),
      registerTool: (tool: any) => tools.set(tool.name, tool),
      on: (event: string, fn: Function) =>
        listeners.set(event, [...(listeners.get(event) ?? []), fn]),
    },
  };
}

export const pause = (ms = 10) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
export async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 15000;
  while (!(await check())) {
    if (Date.now() >= deadline)
      throw new Error('Extension condition timed out');
    await pause();
  }
}
