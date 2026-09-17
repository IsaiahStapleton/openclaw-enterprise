import type {
  Clock,
  DispatchGate,
  ExchangeOutcome,
  ExchangeSender,
  RepoDriver,
  RequestPlan,
} from "../contracts.ts";
import type { CapturedCredential } from "../custody.ts";
import type { LifecycleOwner } from "../lifecycle.ts";
import { waitWithin } from "../provider-queue.ts";

export interface ExecutingExchange {
  readonly session: Readonly<{ lifecycle: LifecycleOwner; driver: RepoDriver }>;
  readonly plan: RequestPlan;
  readonly controller: AbortController;
  readonly deadline: number;
  readonly io: Set<Promise<void>>;
  readonly cancellations: Set<() => void>;
  executing: boolean;
  dispatched: boolean;
  finished: boolean;
}

interface ExchangeOwner {
  readonly clock: Clock;
  finish(): void;
  cancel(): void;
}

export async function executeExchange(
  exchange: ExecutingExchange,
  send: ExchangeSender,
  owner: ExchangeOwner,
): Promise<ExchangeOutcome> {
  if (exchange.executing) throw new Error("EXCHANGE_ALREADY_EXECUTED");
  exchange.executing = true;
  let record: CapturedCredential | undefined;
  let senderEntered = false;
  let acceptingIO = true;
  let senderWork: Promise<ExchangeOutcome> | undefined;
  const failure = (): ExchangeOutcome =>
    Object.freeze({
      kind: exchange.dispatched ? "possibly-dispatched" : "not-dispatched",
      code: "exchange-unavailable",
    });
  const work = (async (): Promise<ExchangeOutcome> => {
    try {
      record = await exchange.session.lifecycle.acquire(
        exchange.deadline,
        exchange.controller.signal,
      );
      const lease = record;
      const gate: DispatchGate = Object.freeze({
        dispatch<T>(stop: () => void, open: () => T): T {
          if (exchange.dispatched || exchange.finished || exchange.controller.signal.aborted)
            throw new Error("DISPATCH_CLOSED");
          exchange.session.lifecycle.assertUse(lease, exchange.deadline);
          exchange.cancellations.add(stop);
          exchange.dispatched = true;
          return open();
        },
        track(io: Promise<void>) {
          if (!acceptingIO || exchange.finished || exchange.io.size >= 16)
            throw new Error("IO_CAPACITY");
          const joined = Promise.resolve(io).then(
            () => undefined,
            () => undefined,
          );
          exchange.io.add(joined);
        },
      });
      const outcome = await exchange.session.driver.withAuthentication(
        lease.ref,
        exchange.plan,
        (request) => {
          if (senderEntered || exchange.controller.signal.aborted || request.plan !== exchange.plan)
            throw new Error("SENDER_CLOSED");
          senderEntered = true;
          senderWork = Promise.resolve().then(() =>
            send(
              request,
              Object.freeze({
                signal: exchange.controller.signal,
                deadlineMonoMs: exchange.deadline,
                gate,
              }),
            ),
          );
          void senderWork.catch(() => {});
          return senderWork;
        },
      );
      const sent = await senderWork;
      if (!senderEntered || outcome !== sent) return failure();
      return outcome.kind === "completed" && !exchange.dispatched ? failure() : outcome;
    } catch {
      return failure();
    } finally {
      await senderWork?.catch(() => {});
      acceptingIO = false;
      await Promise.allSettled([...exchange.io]);
      if (record) exchange.session.lifecycle.release(record);
      owner.finish();
    }
  })();
  try {
    return await waitWithin(work, exchange.controller.signal, exchange.deadline, owner.clock);
  } catch {
    owner.cancel();
    return failure();
  }
}
