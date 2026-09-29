import { APIError } from "better-auth";

// Bounded HTTP transport shared by the GitHub and Google sign-in providers.

export function rejected(): APIError {
  return APIError.fromStatus("UNAUTHORIZED", { message: "Authentication was not accepted." });
}

const providerResponseLimit = 64 * 1024;

// Every fixed provider endpoint the controller may call. Nothing else is fetchable.
export type ProviderEndpoint =
  | "https://github.com/login/oauth/access_token"
  | "https://api.github.com/user"
  | "https://oauth2.googleapis.com/token"
  | "https://www.googleapis.com/oauth2/v3/certs";

// A provider's fixed requests share a deadline, including streaming body reads.
export async function providerJSON(
  endpoint: ProviderEndpoint,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetch(endpoint, { ...init, signal, redirect: "error" });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw rejected();
  }
  const reader = response.body.getReader();
  try {
    if (Number(response.headers.get("content-length")) > providerResponseLimit) {
      await reader.cancel();
      throw rejected();
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) {
        break;
      }
      length += value.byteLength;
      if (length > providerResponseLimit) {
        await reader.cancel();
        throw rejected();
      }
      chunks.push(value);
    }
    const data: unknown = JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw rejected();
    }
    return data as Record<string, unknown>;
  } finally {
    reader.releaseLock();
  }
}
