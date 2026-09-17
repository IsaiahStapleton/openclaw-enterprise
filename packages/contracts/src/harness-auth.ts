import { immutableCopy } from "@openclaw-enterprise/utils";
import { Check } from "typebox/value";
import { HarnessAuthBindingSchema } from "./api/common.ts";
import type { HarnessAuthBinding } from "./index.ts";

/** Use the public binding grammar for every intent entry point. */
export function normalizeHarnessAuthBinding(input: unknown): HarnessAuthBinding | null {
  if (input === null) return null;
  if (!Check(HarnessAuthBindingSchema, input))
    throw new Error("Harness authentication requires one supported exact source binding.");
  return immutableCopy(input as HarnessAuthBinding);
}
