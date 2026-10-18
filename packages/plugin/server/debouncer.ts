/** Opaque timer handle; the real runtime returns a Node Timeout, tests return a number. */
export type TimerHandle = unknown;

export interface QuietDebouncerOptions<Key> {
  /** Window length, read on every arm so live setting changes take effect. */
  windowMs: () => number;
  schedule: (fn: () => void, delayMs: number) => TimerHandle;
  cancel: (handle: TimerHandle) => void;
  /** Called exactly once per armed window that expires without being canceled. */
  onQuiet: (key: Key) => void;
}

/**
 * Per-key quiet-window debouncer.
 *
 * Each key owns at most one pending timer. Arming again resets the window; canceling drops the
 * pending notification for that key. Keys are isolated, so parallel agents never interfere.
 */
export class QuietDebouncer<Key> {
  private readonly pending = new Map<Key, TimerHandle>();

  constructor(private readonly options: QuietDebouncerOptions<Key>) {}

  arm(key: Key): void {
    this.cancel(key);
    const handle = this.options.schedule(() => {
      this.pending.delete(key);
      this.options.onQuiet(key);
    }, this.options.windowMs());
    this.pending.set(key, handle);
  }

  cancel(key: Key): void {
    const handle = this.pending.get(key);
    if (handle === undefined) {
      return;
    }
    this.options.cancel(handle);
    this.pending.delete(key);
  }

  has(key: Key): boolean {
    return this.pending.has(key);
  }

  dispose(): void {
    for (const handle of this.pending.values()) {
      this.options.cancel(handle);
    }
    this.pending.clear();
  }
}
