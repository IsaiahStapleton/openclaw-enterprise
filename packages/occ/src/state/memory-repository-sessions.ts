import type { AgentRevision } from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { ResourceConflictError, ScopeViolationError } from "../errors.ts";
import type {
  RepositoryRevisionOwner,
  RepositorySessionAttempt,
  RepositorySessionPhase,
  RepositorySessionRepository,
} from "../ports/repository-sessions.ts";

const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && identifier.exec(value)?.[0] === value;
}

const transitions: Readonly<Record<RepositorySessionPhase, readonly RepositorySessionPhase[]>> = {
  opening: ["open", "closing", "invalidated"],
  open: ["closing", "invalidated"],
  closing: ["closing", "disposed", "invalidated"],
  disposed: [],
  invalidated: [],
};

function timestamp(value: string): string {
  const date = new Date(value);
  if (typeof value !== "string" || !Number.isFinite(date.getTime())) {
    throw new ScopeViolationError("The repository session timestamp is invalid.");
  }
  return date.toISOString();
}

function sameOwner(attempt: RepositorySessionAttempt, owner: RepositoryRevisionOwner): boolean {
  return (
    attempt.namespaceId === owner.namespaceId &&
    attempt.agentId === owner.agentId &&
    attempt.revisionId === owner.revisionId
  );
}

/** The process-local adapter mirrors the database's constrained attempt lifecycle. */
export function memoryRepositorySessions(
  attempts: Map<string, Readonly<RepositorySessionAttempt>>,
  findRevision: (owner: RepositoryRevisionOwner) => Readonly<AgentRevision> | undefined,
  ownerAcceptsAdmission: (owner: RepositoryRevisionOwner) => boolean,
): RepositorySessionRepository {
  const list = (matches: (attempt: RepositorySessionAttempt) => boolean) =>
    Object.freeze(
      Array.from(attempts.values())
        .filter(matches)
        .sort((left, right) => {
          const byTime = Date.parse(left.createdAt) - Date.parse(right.createdAt);
          return byTime === 0 ? left.admissionId.localeCompare(right.admissionId) : byTime;
        })
        .map((attempt) => immutableCopy(attempt)),
    );

  function assertUnique(attempt: RepositorySessionAttempt): void {
    for (const current of attempts.values()) {
      if (current.admissionId === attempt.admissionId) {
        continue;
      }
      if (attempt.sessionId !== undefined && current.sessionId === attempt.sessionId) {
        throw new ResourceConflictError("The repository session already belongs to an attempt.");
      }
      if (
        (attempt.phase === "opening" || attempt.phase === "open") &&
        (current.phase === "opening" || current.phase === "open") &&
        sameOwner(current, attempt) &&
        current.repositoryRef === attempt.repositoryRef
      ) {
        throw new ResourceConflictError("The revision repository already has an active attempt.");
      }
    }
  }

  return {
    findAttempt: async (admissionId) => {
      const attempt = attempts.get(admissionId);
      return attempt === undefined ? undefined : immutableCopy(attempt);
    },
    listRevisionAttempts: async (owner) => list((attempt) => sameOwner(attempt, owner)),
    listNamespaceAttempts: async (namespaceId) =>
      list((attempt) => attempt.namespaceId === namespaceId),
    createAttempt: async (input) => {
      const revision = findRevision(input);
      const admitted = revision?.repositoryCredentials;
      const binding = admitted?.bindings.find(
        (candidate) => candidate.repositoryRef === input.repositoryRef,
      );
      if (
        !ownerAcceptsAdmission(input) ||
        admitted === undefined ||
        admitted.deadlineWallMs !== input.deadlineWallMs ||
        binding === undefined
      ) {
        throw new ScopeViolationError(
          "The repository session does not match its admitted revision.",
        );
      }
      if (
        !validIdentifier(input.admissionId) ||
        !validIdentifier(input.repositoryRef) ||
        !Number.isSafeInteger(input.durationSeconds) ||
        input.durationSeconds <= 0 ||
        !Number.isSafeInteger(input.deadlineWallMs) ||
        input.deadlineWallMs <= 0
      ) {
        throw new ScopeViolationError("The repository session input is invalid.");
      }
      if (attempts.has(input.admissionId)) {
        throw new ResourceConflictError("The repository session admission already exists.");
      }
      const createdAt = timestamp(input.createdAt);
      const attempt: RepositorySessionAttempt = {
        namespaceId: input.namespaceId,
        agentId: input.agentId,
        revisionId: input.revisionId,
        liveRevisionId: input.revisionId,
        cleanupContext: { driver: admitted.driver, binding },
        repositoryRef: input.repositoryRef,
        admissionId: input.admissionId,
        durationSeconds: input.durationSeconds,
        deadlineWallMs: input.deadlineWallMs,
        phase: "opening",
        createdAt,
        updatedAt: createdAt,
      };
      assertUnique(attempt);
      const saved = immutableCopy(attempt);
      attempts.set(saved.admissionId, saved);
      return immutableCopy(saved);
    },
    advanceAttempt: async (input) => {
      const current = attempts.get(input.admissionId);
      if (current === undefined || current.phase !== input.expectedPhase) {
        return undefined;
      }
      const sessionId = input.sessionId === undefined ? current.sessionId : input.sessionId;
      const updatedAt = timestamp(input.updatedAt);
      if (
        !transitions[current.phase].includes(input.phase) ||
        (sessionId !== undefined && !validIdentifier(sessionId)) ||
        (current.sessionId !== undefined && current.sessionId !== sessionId) ||
        ((input.phase === "open" || input.phase === "disposed") && sessionId === undefined) ||
        Date.parse(updatedAt) < Date.parse(current.createdAt)
      ) {
        throw new ScopeViolationError("The repository session transition is invalid.");
      }
      const saved = immutableCopy({
        ...current,
        phase: input.phase,
        ...(sessionId === undefined ? {} : { sessionId }),
        updatedAt,
      });
      assertUnique(saved);
      attempts.set(saved.admissionId, saved);
      return immutableCopy(saved);
    },
  };
}
