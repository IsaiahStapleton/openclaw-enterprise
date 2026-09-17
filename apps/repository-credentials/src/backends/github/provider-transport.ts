import { request as httpsRequest } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { AttemptContext, Clock } from "../../contracts.ts";
export interface ProviderResponse {
  readonly status: number;
  readonly body: Buffer;
}
export interface ProviderRequest {
  readonly method: "POST" | "DELETE";
  readonly path: string;
  readonly authorization: string;
  readonly body: string;
}
export type ProviderTransport = (
  input: ProviderRequest,
  attempt: AttemptContext,
  onDispatch: () => void,
  assertMaterialCurrent?: () => void,
  observeResponse?: (response: ProviderResponse) => void,
) => Promise<ProviderResponse>;

export function createProviderTransport(
  origin: string,
  ca: Uint8Array | undefined,
  clock: Clock,
): ProviderTransport {
  return (
    input: ProviderRequest,
    attempt: AttemptContext,
    onDispatch: () => void,
    assertMaterialCurrent: () => void = () => {},
    observeResponse: (response: ProviderResponse) => void = () => {},
  ): Promise<ProviderResponse> =>
    new Promise((resolve, reject) => {
      let request: ClientRequest | undefined,
        response: IncomingMessage | undefined,
        result: ProviderResponse | undefined,
        failed = false,
        finished = false;
      const chunks: Buffer[] = [];
      let length = 0;
      let cancelTimer: () => void = () => {};
      const discard = () => {
        for (const chunk of chunks) chunk.fill(0);
        chunks.length = 0;
      };
      // Completion waits for the real request close, so settlement cannot outlive callbacks.
      const finish = () => {
        if (finished) return;
        finished = true;
        cancelTimer();
        attempt.signal.removeEventListener("abort", fail);
        discard();
        if (failed || !result) {
          result?.body.fill(0);
          reject(new Error("provider-unavailable"));
        } else resolve(result);
      };
      const fail = () => {
        failed = true;
        response?.destroy();
        request?.destroy();
        if (!request) finish();
      };
      try {
        attempt.assertAdmitted();
        assertMaterialCurrent();
        const remaining = attempt.deadlineMonoMs - clock.monotonicNow();
        if (attempt.signal.aborted || remaining <= 0) throw new Error("not-admitted");
        // No await separates this admission check, dispatch latch and socket creation.
        onDispatch();
        attempt.observeDispatch();
        request = httpsRequest(new URL(input.path, origin), {
          method: input.method,
          agent: false,
          rejectUnauthorized: true,
          maxHeaderSize: 32768,
          ...(ca ? { ca: Buffer.from(ca) } : {}),
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${input.authorization}`,
            "user-agent": "openclaw-enterprise-repository-credentials",
            "x-github-api-version": "2026-03-10",
            "content-type": "application/json",
            "content-length": Buffer.byteLength(input.body),
            "accept-encoding": "identity",
            connection: "close",
          },
        });
        request.on("error", fail);
        request.on("close", finish);
        request.on("response", (incoming) => {
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
          incoming.on("data", (chunk: Buffer) => {
            if (failed) {
              chunk.fill(0);
              return;
            }
            length += chunk.length;
            if (length > 262144) {
              chunk.fill(0);
              fail();
            } else chunks.push(chunk);
          });
          incoming.on("end", () => {
            if (!failed) {
              result = { status: incoming.statusCode ?? 0, body: Buffer.concat(chunks) };
              try {
                observeResponse(result);
              } catch {
                fail();
              }
            }
            discard();
          });
        });
        cancelTimer = clock.schedule(Math.min(30000, remaining), fail);
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
