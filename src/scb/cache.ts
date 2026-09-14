export class TtlCache<T> {
  private readonly store = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (this.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.store.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}
