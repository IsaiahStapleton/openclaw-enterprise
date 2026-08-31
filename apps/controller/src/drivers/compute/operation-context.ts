import { AsyncLocalStorage } from "node:async_hooks";

const operationSignals = new AsyncLocalStorage<AbortSignal>();

export function currentComputeAbortSignal(): AbortSignal | undefined {
  return operationSignals.getStore();
}

export async function withComputeAbortSignal<Result>(
  signal: AbortSignal,
  operation: () => Promise<Result>,
): Promise<Result> {
  signal.throwIfAborted();
  return operationSignals.run(signal, operation);
}
