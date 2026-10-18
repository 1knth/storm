import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';

const IGNORED_SEGMENTS = new Set(['.obsidian', '.git', 'node_modules']);

export class VaultWatcher {
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private revision = 0;
  private generation = 0;

  constructor(
    private readonly notify: (vaultId: string, revision: number) => void,
    private readonly debounceMs = 200,
  ) {}

  start(rootPath: string, vaultId: string): void {
    this.stop();
    const generation = ++this.generation;
    try {
      this.watcher = watch(
        rootPath,
        { recursive: true },
        (_event, filename) => {
          if (generation !== this.generation || !filename) return;
          const relative = filename.toString();
          const segments = relative.split(/[\\/]/);
          if (
            path.isAbsolute(relative) ||
            segments.some((part) => part === '..') ||
            segments.some((part) => IGNORED_SEGMENTS.has(part))
          )
            return;
          this.schedule(vaultId, generation);
        },
      );
      this.watcher.on('error', (error) => {
        if (generation !== this.generation) return;
        console.warn('Vault watcher stopped:', error.message);
        this.watcher?.close();
        this.watcher = null;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
      });
    } catch (error) {
      this.watcher?.close();
      this.watcher = null;
      console.warn(
        'Could not watch vault:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  invalidate(vaultId: string): void {
    if (this.watcher) this.schedule(vaultId, this.generation);
  }

  stop(): void {
    this.generation++;
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(vaultId: string, generation: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (generation !== this.generation) return;
      this.notify(vaultId, ++this.revision);
    }, this.debounceMs);
  }
}
