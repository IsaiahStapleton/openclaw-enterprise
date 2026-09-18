import type {
  AdmittedRepositoryBinding,
  RepositoryBindingSelection,
  RepositoryRevisionState,
} from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { ScopeViolationError } from "../errors.ts";

const token = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const providerIdentifier = /^(?!\s)(?!.*\s$)(?!.*[\x00-\x1f\x7f]).{1,200}$/;

function boundedToken(value: unknown): value is string {
  return typeof value === "string" && token.exec(value)?.[0] === value;
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function opaqueIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 512 &&
    Buffer.from(value, "utf8").toString("utf8") === value &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}

function selection(value: unknown, admitted: boolean): boolean {
  if (
    !exactObject(
      value,
      admitted ? ["repositoryRef", "profile", "providerId", "grant"] : ["repositoryRef", "profile"],
    ) ||
    !boundedToken(value.repositoryRef) ||
    !boundedToken(value.profile)
  ) {
    return false;
  }
  return (
    !admitted ||
    (typeof value.providerId === "string" &&
      providerIdentifier.test(value.providerId) &&
      Buffer.from(value.providerId, "utf8").toString("utf8") === value.providerId &&
      exactObject(value.grant, ["providerInstanceId", "repositoryId", "grantId"]) &&
      opaqueIdentity(value.grant.providerInstanceId) &&
      opaqueIdentity(value.grant.repositoryId) &&
      opaqueIdentity(value.grant.grantId))
  );
}

function bindingArray(value: unknown, admitted: boolean): boolean {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    return false;
  }
  const refs = new Set<string>();
  for (const binding of value) {
    if (!selection(binding, admitted) || refs.has(binding.repositoryRef)) {
      return false;
    }
    refs.add(binding.repositoryRef);
  }
  return true;
}

/** Canonical desired state; request defaulting and authority resolution belong to admission. */
export function validRepositoryBindingSelections(
  value: unknown,
): value is readonly RepositoryBindingSelection[] {
  return bindingArray(value, false);
}

export function validAdmittedRepositoryBindings(
  value: unknown,
): value is readonly AdmittedRepositoryBinding[] {
  return bindingArray(value, true);
}

/** Mirrors the database's closed, material-free immutable snapshot shape. */
export function validRepositoryRevisionState(value: unknown): value is RepositoryRevisionState {
  return (
    exactObject(value, ["driver", "deadlineWallMs", "bindings"]) &&
    exactObject(value.driver, ["id", "implementation"]) &&
    opaqueIdentity(value.driver.id) &&
    opaqueIdentity(value.driver.implementation) &&
    typeof value.deadlineWallMs === "number" &&
    Number.isSafeInteger(value.deadlineWallMs) &&
    value.deadlineWallMs > 0 &&
    validAdmittedRepositoryBindings(value.bindings)
  );
}

export function normalizedRepositoryBindings(
  value: unknown,
): readonly RepositoryBindingSelection[] | undefined {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) {
    return undefined;
  }
  if (!validRepositoryBindingSelections(value)) {
    throw new ScopeViolationError("The Agent repository bindings are invalid.");
  }
  return immutableCopy(value);
}
