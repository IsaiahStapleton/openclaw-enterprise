export interface RepositoryRevisionOwner {
  readonly namespaceId: string;
  readonly agentId: string;
  readonly revisionId: string;
}

export type RepositorySessionPhase = "opening" | "open" | "closing" | "disposed" | "invalidated";

/** Safe recovery identifiers only; gateway bearer material never belongs in State. */
export interface RepositorySessionAttempt extends RepositoryRevisionOwner {
  readonly repositoryRef: string;
  readonly admissionId: string;
  readonly durationSeconds: number;
  readonly deadlineWallMs: number;
  readonly phase: RepositorySessionPhase;
  readonly sessionId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RepositorySessionReadRepository {
  findAttempt(admissionId: string): Promise<Readonly<RepositorySessionAttempt> | undefined>;
  listRevisionAttempts(
    owner: RepositoryRevisionOwner,
  ): Promise<readonly Readonly<RepositorySessionAttempt>[]>;
  listNamespaceAttempts(
    namespaceId: string,
  ): Promise<readonly Readonly<RepositorySessionAttempt>[]>;
}

export interface RepositorySessionRepository extends RepositorySessionReadRepository {
  /** Persists the immutable request identity in the opening phase before external admission. */
  createAttempt(
    input: RepositoryRevisionOwner & {
      readonly repositoryRef: string;
      readonly admissionId: string;
      readonly durationSeconds: number;
      readonly deadlineWallMs: number;
      readonly createdAt: string;
    },
  ): Promise<Readonly<RepositorySessionAttempt>>;
  /** Compare-and-set phase changes preserve ownership, request fields, and any known session ID. */
  advanceAttempt(input: {
    readonly admissionId: string;
    readonly expectedPhase: RepositorySessionPhase;
    readonly phase: RepositorySessionPhase;
    readonly sessionId?: string;
    readonly updatedAt: string;
  }): Promise<Readonly<RepositorySessionAttempt> | undefined>;
}
