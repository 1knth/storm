/** Serialize related operations while allowing unrelated keys to progress. */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(operation);
    this.tails.set(key, result);
    void result
      .finally(() => {
        if (this.tails.get(key) === result) this.tails.delete(key);
      })
      .catch(() => undefined);
    return result;
  }
}
