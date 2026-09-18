import type {
  AttemptContext,
  Clock,
} from "../../../drivers/repository-credentials/backend-contracts.ts";
import { sendProviderRequest } from "./provider-transport/request.ts";

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
    sendProviderRequest({
      origin,
      ca,
      clock,
      input,
      attempt,
      onDispatch,
      assertMaterialCurrent,
      observeResponse,
    });
}
