import type {
  RepositoryCredentialSessionInput,
  RepositoryCredentialSessionResult,
  RepositoryCredentialSessionStatus,
} from "@openclaw-enterprise/contracts";

export type ControlRequest =
  | Readonly<{ method: "POST"; path: "/v1/sessions"; body: RepositoryCredentialSessionInput }>
  | Readonly<{ method: "GET"; path: `/v1/sessions/${string}` }>
  | Readonly<{ method: "POST"; path: `/v1/sessions/${string}/close` }>;
export type ControlErrorCode = "invalid-request" | "not-found" | "unavailable" | "overloaded";
export type ControlResponse =
  | RepositoryCredentialSessionResult
  | RepositoryCredentialSessionStatus
  | Readonly<{ error: ControlErrorCode }>;
