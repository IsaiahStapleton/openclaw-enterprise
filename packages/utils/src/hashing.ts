import { createHash } from "node:crypto";

/** SHA-256 hex, optionally truncated using the caller's existing slice length. */
export function sha256Hex(value: string, length?: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}
