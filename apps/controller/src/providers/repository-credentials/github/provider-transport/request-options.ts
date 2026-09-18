import type { RequestOptions } from "node:https";
import type { ProviderRequest } from "../provider-transport.ts";

export function providerRequestOptions(
  input: ProviderRequest,
  ca: Uint8Array | undefined,
): RequestOptions {
  return {
    method: input.method,
    agent: false,
    rejectUnauthorized: true,
    maxHeaderSize: 32768,
    ...(ca ? { ca: Buffer.from(ca) } : {}),
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${input.authorization}`,
      "user-agent": "openclaw-enterprise-repository-credentials",
      "x-github-api-version": "2026-03-10",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(input.body),
      "accept-encoding": "identity",
      connection: "close",
    },
  };
}
