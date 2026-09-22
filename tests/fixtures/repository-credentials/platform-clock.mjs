// Unlike the fully controlled protocol fixture clock, this clock tracks real
// time while the actual worker produces admission timestamps. Explicit jumps
// are reserved for token renewal after the admission/recovery assertions.
export function createPlatformClock() {
  let offset = 0;
  const scheduled = new Set();
  const monotonicNow = () => performance.now() + offset;
  const arm = (timer) => {
    clearTimeout(timer.handle);
    timer.handle = setTimeout(
      () => {
        if (!scheduled.delete(timer)) {
          return;
        }
        timer.callback();
      },
      Math.max(0, timer.at - monotonicNow()),
    );
  };
  return {
    wallNow: () => Date.now() + offset,
    monotonicNow,
    schedule(delayMs, callback) {
      if (!Number.isFinite(delayMs) || delayMs < 0) {
        throw new Error("invalid fixture timer");
      }
      const timer = { at: monotonicNow() + delayMs, callback, handle: undefined };
      scheduled.add(timer);
      arm(timer);
      return () => {
        scheduled.delete(timer);
        clearTimeout(timer.handle);
      };
    },
    async advance(milliseconds) {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) {
        throw new Error("invalid fixture clock advance");
      }
      offset += milliseconds;
      for (const timer of scheduled) {
        arm(timer);
      }
      for (let round = 0; round < 1000; round++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (![...scheduled].some((timer) => timer.at <= monotonicNow())) {
          return;
        }
      }
      throw new Error("fixture timer callbacks did not settle");
    },
  };
}
