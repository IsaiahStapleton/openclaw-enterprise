import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { loadYaml } from "@kubernetes/client-node";
import {
  AgentId as AgentIdSchema,
  NamespaceId as NamespaceIdSchema,
} from "@openclaw-enterprise/contracts";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { ControllerWorkspaceFilesAccess } from "../gateway/contracts.ts";
import {
  createNativeWorkspaceFilesAccess,
  type NativeWorkspaceFilesTarget,
} from "../gateway/workspace-files-client.ts";

interface NativeWorkspaceFilesEndpoint extends NativeWorkspaceFilesTarget {
  readonly namespaceId: string;
  readonly agentId: string;
}

const WorkspaceFilesEndpointSchema = Type.Object(
  {
    namespaceId: NamespaceIdSchema,
    agentId: AgentIdSchema,
    url: Type.String({ minLength: 1 }),
    nativeAgentId: Type.String({ minLength: 1 }),
    identity: Type.String({ minLength: 1 }),
    userHeader: Type.String({ minLength: 1 }),
    tlsFingerprint: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const WorkspaceFilesConfigurationSchema = Type.Object(
  { endpoints: Type.Array(WorkspaceFilesEndpointSchema) },
  { additionalProperties: false },
);

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const RESERVED_HEADER =
  /^(?:authorization|connection|content-length|cookie|forwarded|host|origin|proxy-authorization|set-cookie|transfer-encoding|upgrade|x-real-ip|sec-websocket-.+|x-forwarded-.+)$/;
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]+$/;
const SHA256_FINGERPRINT = /^(?:[0-9A-Fa-f]{64}|(?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2})$/;

function endpointKey(endpoint: Pick<NativeWorkspaceFilesEndpoint, "namespaceId" | "agentId">) {
  return `${endpoint.namespaceId}\0${endpoint.agentId}`;
}

function validateUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("workspace-files endpoint url must be a valid absolute URL.");
  }
  if (
    parsed.protocol !== "wss:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error(
      "workspace-files endpoint url must be a wss URL without credentials, query, or fragment.",
    );
  }
  return parsed.toString();
}

function validateUserHeader(value: string): string {
  const lower = value.toLowerCase();
  if (!HEADER_NAME.test(value) || RESERVED_HEADER.test(lower)) {
    throw new Error("workspace-files endpoint userHeader is reserved or invalid.");
  }
  return value;
}

function validateHeaderValue(value: string, field: "identity" | "nativeAgentId"): string {
  if (value.trim().length === 0 || !HEADER_VALUE.test(value)) {
    throw new Error(`workspace-files endpoint ${field} is empty or invalid.`);
  }
  return value;
}

function validateFingerprint(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!SHA256_FINGERPRINT.test(value)) {
    throw new Error("workspace-files endpoint tlsFingerprint must be a SHA-256 hex fingerprint.");
  }
  return value;
}

export function createWorkspaceFilesAccess(
  endpoints: readonly NativeWorkspaceFilesEndpoint[],
): ControllerWorkspaceFilesAccess {
  const byAgent = new Map<string, NativeWorkspaceFilesTarget>();
  for (const endpoint of endpoints) {
    const key = endpointKey(endpoint);
    if (byAgent.has(key)) {
      throw new Error("workspace-files endpoints must be unique by namespaceId and agentId.");
    }
    const tlsFingerprint = validateFingerprint(endpoint.tlsFingerprint);
    byAgent.set(
      key,
      Object.freeze({
        url: validateUrl(endpoint.url),
        nativeAgentId: validateHeaderValue(endpoint.nativeAgentId, "nativeAgentId"),
        identity: validateHeaderValue(endpoint.identity, "identity"),
        userHeader: validateUserHeader(endpoint.userHeader),
        ...(tlsFingerprint === undefined ? {} : { tlsFingerprint }),
      }),
    );
  }
  return createNativeWorkspaceFilesAccess((request) => byAgent.get(endpointKey(request.revision)));
}

export async function loadWorkspaceFilesAccess(
  path: string,
): Promise<ControllerWorkspaceFilesAccess> {
  if (!isAbsolute(path)) {
    throw new Error(
      "OCC_WORKSPACE_FILES_CONFIG_PATH must identify an absolute workspace-files YAML path.",
    );
  }

  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch {
    throw new Error("The configured workspace-files YAML is unavailable.");
  }

  let parsed: unknown;
  try {
    parsed = loadYaml(contents);
  } catch {
    throw new Error("The configured workspace-files file must contain valid YAML.");
  }

  if (!Check(WorkspaceFilesConfigurationSchema, parsed)) {
    throw new Error("The configured workspace-files file does not match the expected schema.");
  }
  return createWorkspaceFilesAccess(parsed.endpoints);
}
