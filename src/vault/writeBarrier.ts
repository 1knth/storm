export class VaultWriteBarrier {
  private closing = false;
  private readonly pending = new Set<Promise<unknown>>();

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing)
      throw new Error('Vaults are unloading; try again shortly');
    const pending = Promise.resolve().then(operation);
    this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending)).catch(() => {});
    return pending;
  }

  async close<T>(reset: () => Promise<T>): Promise<T> {
    this.closing = true;
    try {
      await Promise.all(Array.from(this.pending));
      return await reset();
    } finally {
      this.closing = false;
    }
  }
}
