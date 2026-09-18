import { request as httpsRequest } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { AttemptContext, Clock } from "../../../driver-contracts.ts";
import type { ProviderRequest, ProviderResponse } from "../provider-transport.ts";
import { providerRequestOptions } from "./request-options.ts";
import { createProviderResponseBody } from "./response-body.ts";

interface ProviderRequestDependencies {
  readonly origin: string;
  readonly ca: Uint8Array | undefined;
  readonly clock: Clock;
  readonly input: ProviderRequest;
  readonly attempt: AttemptContext;
  readonly onDispatch: () => void;
  readonly assertMaterialCurrent: () => void;
  readonly observeResponse: (response: ProviderResponse) => void;
}

export function sendProviderRequest({
  origin,
  ca,
  clock,
  input,
  attempt,
  onDispatch,
  assertMaterialCurrent,
  observeResponse,
}: ProviderRequestDependencies): Promise<ProviderResponse> {
  return new Promise((resolve, reject) => {
    const responseBody = createProviderResponseBody();
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let result: ProviderResponse | undefined;
    let failed = false;
    let settled = false;
    let cancelDeadline: () => void = () => {};

    // A dispatched request settles only after its actual close event.
    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      cancelDeadline();
      attempt.signal.removeEventListener("abort", fail);
      responseBody.discard();
      if (failed || !result) {
        result?.body.fill(0);
        reject(new Error("provider-unavailable"));
      } else {
        resolve(result);
      }
    };
    const fail = () => {
      failed = true;
      response?.destroy();
      request?.destroy();
      if (!request) {
        settle();
      }
    };
    const receiveResponse = (incoming: IncomingMessage) => {
      response = incoming;
      incoming.on("error", fail);
      incoming.on("aborted", fail);
      if (
        incoming.headers["content-encoding"] &&
        incoming.headers["content-encoding"] !== "identity"
      ) {
        fail();
        return;
      }
      incoming.on("data", function receiveChunk(chunk: Buffer) {
        if (failed) {
          chunk.fill(0);
        } else if (!responseBody.append(chunk)) {
          fail();
        }
      });
      incoming.on("end", function completeResponse() {
        if (!failed) {
          result = { status: incoming.statusCode ?? 0, body: responseBody.assemble() };
          try {
            observeResponse(result);
          } catch {
            fail();
          }
        }
        responseBody.discard();
      });
    };

    try {
      attempt.assertAdmitted();
      assertMaterialCurrent();
      const remaining = attempt.deadlineMonoMs - clock.monotonicNow();
      if (attempt.signal.aborted || remaining <= 0) {
        throw new Error("not-admitted");
      }
      // No await separates this admission check, dispatch latch and socket creation.
      onDispatch();
      attempt.observeDispatch();
      request = httpsRequest(new URL(input.path, origin), providerRequestOptions(input, ca));
      request.on("error", fail);
      request.on("close", settle);
      request.on("response", receiveResponse);
      cancelDeadline = clock.schedule(Math.min(30000, remaining), fail);
      attempt.signal.addEventListener("abort", fail, { once: true });
      if (attempt.signal.aborted) {
        fail();
        return;
      }
      request.end(input.body);
    } catch {
      fail();
    }
  });
}
