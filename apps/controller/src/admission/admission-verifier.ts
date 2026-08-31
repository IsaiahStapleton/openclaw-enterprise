export interface AdmissionScope {
  readonly installationId: string;
  readonly namespaceId?: string;
}

export type AdmissionHeaders =
  Headers | Readonly<Record<string, string | readonly string[] | undefined>>;

export interface TrustedTransportEvidence {
  readonly remoteAddress: string;
  readonly localAddress?: string;
  readonly trustProxy?: boolean;
}

export interface AdmissionRequest {
  readonly requestId: string;
  readonly method: string;
  readonly routeId: string;
  readonly requestedScope: AdmissionScope;
  readonly transport: TrustedTransportEvidence;
  readonly authorizationHeader?: string;
  readonly headers?: AdmissionHeaders;
  // TODO(production-admission): Replace this placeholder with verified OAG admission evidence.
  readonly futureAdmissionEvidence?: unknown;
}

export interface AdmittedCaller {
  readonly externalIdentity: {
    readonly issuer: string;
    readonly subject: string;
  };
  readonly admittedScope: AdmissionScope;
  readonly decisionId: string;
  readonly method: "session" | "api_key" | "oag";
}

export interface AdmissionVerifier {
  verify(request: AdmissionRequest): Promise<AdmittedCaller>;
}

export class AdmissionFailure extends Error {
  readonly status: 401 | 403;
  readonly code: "UNAUTHENTICATED" | "FORBIDDEN";

  constructor(status: 401 | 403, code: "UNAUTHENTICATED" | "FORBIDDEN", message: string) {
    super(message);
    this.name = "AdmissionFailure";
    this.status = status;
    this.code = code;
  }
}
