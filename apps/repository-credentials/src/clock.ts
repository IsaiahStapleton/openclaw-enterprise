import { performance } from "node:perf_hooks";
import type { Clock } from "./driver-contracts.ts";

export function createSystemClock(): Clock {
  return Object.freeze({
    wallNow: () => Date.now(),
    monotonicNow: () => performance.now(),
    schedule(delayMs: number, callback: () => void) {
      if (!Number.isFinite(delayMs) || delayMs < 0) {
        throw new Error("invalid-clock-delay");
      }
      // Long admission deadlines must not overflow Node's signed 32-bit timer delay.
      let active = true;
      const deadline = performance.now() + delayMs;
      let timer: ReturnType<typeof setTimeout>;
      const tick = () => {
        if (!active) {
          return;
        }
        const remaining = deadline - performance.now();
        if (remaining > 0) {
          timer = setTimeout(tick, Math.min(remaining, 2_147_483_647));
          timer.unref();
        } else {
          active = false;
          callback();
        }
      };
      timer = setTimeout(tick, Math.min(delayMs, 2_147_483_647));
      timer.unref();
      return () => {
        active = false;
        clearTimeout(timer);
      };
    },
  });
}
