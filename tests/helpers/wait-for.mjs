import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

// Polls `read` until it returns a value other than undefined and returns that value.
export async function waitFor(description, read, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await delay(20);
  }
  assert.fail(`Timed out waiting for ${description}.`);
}
