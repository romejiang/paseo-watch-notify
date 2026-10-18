import { describe, expect, test } from "vitest";
import { QuietDebouncer, type TimerHandle } from "./debouncer";

interface FakeTimers {
  schedule: (fn: () => void, ms: number) => TimerHandle;
  cancel: (handle: TimerHandle) => void;
  fireAll: () => void;
  size: () => number;
  delays: () => number[];
}

function createFakeTimers(): FakeTimers {
  let seq = 0;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  return {
    schedule: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { fn, ms });
      return id;
    },
    cancel: (handle) => {
      timers.delete(handle as number);
    },
    fireAll: () => {
      const pending = [...timers.values()];
      timers.clear();
      for (const timer of pending) timer.fn();
    },
    size: () => timers.size,
    delays: () => [...timers.values()].map((timer) => timer.ms),
  };
}

function makeDebouncer(
  timers: FakeTimers,
  windowMs: () => number,
  onQuiet: (key: string) => void,
): QuietDebouncer<string> {
  return new QuietDebouncer<string>({
    windowMs,
    schedule: timers.schedule,
    cancel: timers.cancel,
    onQuiet,
  });
}

describe("QuietDebouncer", () => {
  test("fires onQuiet once after the window expires", () => {
    const timers = createFakeTimers();
    const fired: string[] = [];
    const debouncer = makeDebouncer(timers, () => 1000, (key) => fired.push(key));

    debouncer.arm("a1");
    expect(timers.size()).toBe(1);
    expect(fired).toEqual([]);

    timers.fireAll();
    expect(fired).toEqual(["a1"]);
    expect(timers.size()).toBe(0);
  });

  test("cancel drops the pending window", () => {
    const timers = createFakeTimers();
    const fired: string[] = [];
    const debouncer = makeDebouncer(timers, () => 1000, (key) => fired.push(key));

    debouncer.arm("a1");
    debouncer.cancel("a1");
    expect(debouncer.has("a1")).toBe(false);
    timers.fireAll();
    expect(fired).toEqual([]);
  });

  test("re-arming resets the window and reads the current delay", () => {
    const timers = createFakeTimers();
    const fired: string[] = [];
    let windowMs = 1000;
    const debouncer = makeDebouncer(timers, () => windowMs, (key) => fired.push(key));

    debouncer.arm("a1");
    windowMs = 2500;
    debouncer.arm("a1");

    expect(timers.size()).toBe(1);
    expect(timers.delays()).toEqual([2500]);

    timers.fireAll();
    expect(fired).toEqual(["a1"]);
  });

  test("isolates keys", () => {
    const timers = createFakeTimers();
    const fired: string[] = [];
    const debouncer = makeDebouncer(timers, () => 1000, (key) => fired.push(key));

    debouncer.arm("a1");
    debouncer.arm("a2");
    expect(timers.size()).toBe(2);

    debouncer.cancel("a1");
    timers.fireAll();
    expect(fired).toEqual(["a2"]);
  });

  test("dispose clears every pending window", () => {
    const timers = createFakeTimers();
    const fired: string[] = [];
    const debouncer = makeDebouncer(timers, () => 1000, (key) => fired.push(key));

    debouncer.arm("a1");
    debouncer.arm("a2");
    debouncer.dispose();
    expect(timers.size()).toBe(0);
    timers.fireAll();
    expect(fired).toEqual([]);
  });
});
