import type { HarnessDescriptor, HarnessExecutionMode } from "@openclaw-enterprise/contracts";
import type { HarnessResolver } from "@openclaw-enterprise/occ";

export const DEVELOPMENT_HARNESS_DESCRIPTOR: HarnessDescriptor = Object.freeze({
  id: "openclaw",
  version: "1.0.0",
});

/** Dedicated execution connects to the approved Codex app-server protocol. */
export const PRODUCTION_HARNESS_DESCRIPTOR: HarnessDescriptor = Object.freeze({
  id: "codex",
  version: "1.0.0",
});

export function resolveApprovedHarness(
  harnessId: string,
  executionMode: HarnessExecutionMode,
): HarnessDescriptor | undefined {
  if (executionMode === "dedicated" && harnessId === PRODUCTION_HARNESS_DESCRIPTOR.id) {
    return PRODUCTION_HARNESS_DESCRIPTOR;
  }
  if (executionMode === "embedded" && harnessId === DEVELOPMENT_HARNESS_DESCRIPTOR.id) {
    return DEVELOPMENT_HARNESS_DESCRIPTOR;
  }
  return undefined;
}

/** Production admits only approved, version-pinned Harness and placement combinations. */
export const resolveApprovedProductionHarness: HarnessResolver = (harnessId, executionMode) =>
  resolveApprovedHarness(harnessId, executionMode);
