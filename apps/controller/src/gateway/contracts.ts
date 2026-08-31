import { GATEWAY_COMMAND_METHODS } from "@openclaw-enterprise/contracts";
import type {
  AgentRevision,
  DispatchGatewayCommandBody,
  GatewayCommandMethod,
  OpenClawConfigurationValue,
} from "@openclaw-enterprise/contracts";

const ALLOWED_GATEWAY_COMMANDS = new Set<string>(GATEWAY_COMMAND_METHODS);

export interface ControllerGatewayRpcError {
  readonly code: string;
  readonly message: string;
  readonly details?: OpenClawConfigurationValue;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
}

export interface ControllerGatewayDispatchRequest {
  readonly revision: Readonly<AgentRevision>;
  readonly command: DispatchGatewayCommandBody;
  readonly signal: AbortSignal;
  readonly deadline: Date;
}

export type ControllerGatewayDispatchResult =
  | {
      readonly ok: true;
      readonly payload?: OpenClawConfigurationValue;
    }
  | {
      readonly ok: false;
      readonly error: ControllerGatewayRpcError;
    };

export interface ControllerGatewayAccess {
  dispatch(request: ControllerGatewayDispatchRequest): Promise<ControllerGatewayDispatchResult>;
}

export class ControllerGatewayUnknownOutcomeError extends Error {
  override readonly cause: unknown;

  constructor(
    message = "The native gateway command outcome is unknown.",
    options: { readonly cause?: unknown } = {},
  ) {
    super(message);
    this.name = "ControllerGatewayUnknownOutcomeError";
    this.cause = options.cause;
  }
}

export function isAllowedGatewayCommand(method: string): method is GatewayCommandMethod {
  return ALLOWED_GATEWAY_COMMANDS.has(method);
}
