import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AuthorityIdentity, Clock, SessionRef } from "./backend-contracts.ts";
import type { RepositoryCredentialGrantIdentity } from "@openclaw-enterprise/contracts";

export interface SessionAdmission {
  readonly ref: SessionRef;
  readonly authority: AuthorityIdentity;
  readonly bearer: string;
  readonly digest: string;
  readonly binding: RepositoryCredentialGrantIdentity;
  readonly deadlineWallMs: number;
  readonly deadlineMonoMs: number;
}

export function bearerDigest(bearer: string): string | undefined {
  if (typeof bearer !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(bearer)) {
    return undefined;
  }
  return createHash("sha256").update(bearer).digest("hex");
}

export function snapshotBinding(
  binding: RepositoryCredentialGrantIdentity,
): RepositoryCredentialGrantIdentity {
  const { providerInstanceId, repositoryId, grantId } = binding;
  for (const value of [providerInstanceId, repositoryId, grantId]) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      Buffer.byteLength(value) > 512 ||
      /[\u0000-\u001f\u007f]/.test(value)
    ) {
      throw new Error("INVALID_BINDING");
    }
  }
  return Object.freeze({ providerInstanceId, repositoryId, grantId });
}

export function admitSession(
  binding: RepositoryCredentialGrantIdentity,
  durationSeconds: number,
  clock: Clock,
): SessionAdmission {
  const bearer = randomBytes(32).toString("base64url");
  const sessionId = randomUUID();
  const immutableBinding = snapshotBinding(binding);
  const authority: AuthorityIdentity = Object.freeze({ ...immutableBinding, sessionId });
  const ref = Object.freeze({}) as SessionRef;
  return {
    ref,
    authority,
    bearer,
    digest: bearerDigest(bearer)!,
    binding: immutableBinding,
    deadlineWallMs: clock.wallNow() + durationSeconds * 1000,
    deadlineMonoMs: clock.monotonicNow() + durationSeconds * 1000,
  };
}
