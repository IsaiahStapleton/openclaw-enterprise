import assert from "node:assert/strict";
import test from "node:test";
import { requestFailure } from "../../apps/controller/src/http/errors.ts";
import {
  ConfigurationOwnershipError,
  ConfigurationValidationError,
} from "../../apps/controller/src/drivers/configuration/kubernetes/index.ts";
import { PresetValidationError } from "../../packages/contracts/src/index.ts";
import {
  AgentDeletingError,
  AgentPrincipalAuthorizationError,
  AuthorizationDeniedError,
  ChannelCredentialError,
  ChannelDirectoryError,
  ConfigurationHarnessError,
  CredentialGatewayNotConfiguredError,
  DeletionRetryOwnedError,
  DependencyUnavailableError,
  DeviceAuthorizationStartError,
  IAMAccessBindingRoleError,
  IAMPolicyValidationError,
  IAMRoleInUseError,
  ModelCredentialValueError,
  NamespaceNotEmptyError,
  NamespaceNotReadyError,
  NativeWorkerSupportError,
  NotImplementedError,
  PluginDiscoveryError,
  PluginPolicyValidationError,
  PostgresCommitOutcomeUnknownError,
  ResourceConflictError,
  ResourceStateConflictError,
  RuntimeLogsError,
  ScopeViolationError,
  SecretValueError,
} from "../../packages/occ/src/index.ts";

// Text that must never reach a client: the mappings below that answer with fixed text are
// checked with an error carrying this message.
const INTERNAL = "internal detail: postgres row agent_abc in ns_secret";
const AGENT_NAME_CONFLICT =
  "An Agent with this name already exists in this Namespace. Choose a different name.";
const agentResource = { kind: "agent", id: "agt_1", namespaceId: "ns_1" };

function apiError(statusCode) {
  return Object.assign(new Error(INTERNAL), { name: "APIError", statusCode });
}

function fastifyError(code) {
  return Object.assign(new Error(INTERNAL), { code });
}

function admissionFailure(fields) {
  return Object.assign(new Error(INTERNAL), { name: "AdmissionFailure", ...fields });
}

// Many OCC errors subclass ScopeViolationError, ResourceConflictError or
// AuthorizationDeniedError, so each row also guards the order of the checks in
// requestFailure: a subclass must keep its own status and text, not its parent's.
const cases = [
  // 409: conflicts the user can act on.
  [
    "a state conflict names what blocks the operation",
    new ResourceStateConflictError(AGENT_NAME_CONFLICT),
    { status: 409, code: "RESOURCE_CONFLICT", message: AGENT_NAME_CONFLICT },
  ],
  [
    "a plain resource conflict keeps the generic text",
    new ResourceConflictError(INTERNAL),
    {
      status: 409,
      code: "RESOURCE_CONFLICT",
      message: "The requested platform resource already exists.",
    },
  ],
  [
    "a Role still referenced by bindings says to delete them first",
    new IAMRoleInUseError(),
    {
      status: 409,
      code: "RESOURCE_CONFLICT",
      message: "The IAM Role is referenced by AccessBindings. Delete those AccessBindings first.",
    },
  ],
  [
    "an Agent being deleted",
    new AgentDeletingError(INTERNAL),
    { status: 409, code: "AGENT_DELETING", message: "The requested Agent is being deleted." },
  ],
  [
    "a Namespace that is not ready",
    new NamespaceNotReadyError(INTERNAL),
    {
      status: 409,
      code: "NAMESPACE_NOT_READY",
      message: "The requested Namespace is not ready for deployment.",
    },
  ],
  [
    "a non-empty Namespace names what it still contains",
    new NamespaceNotEmptyError(["Agents", "Presets"]),
    {
      status: 409,
      code: "NAMESPACE_NOT_EMPTY",
      message: "The requested Namespace is not empty. It still contains: Agents, Presets.",
    },
  ],
  [
    "a non-empty Namespace with unnamed contents",
    new NamespaceNotEmptyError(),
    { status: 409, code: "NAMESPACE_NOT_EMPTY", message: "The requested Namespace is not empty." },
  ],
  [
    "an Installation without a Credential Gateway",
    new CredentialGatewayNotConfiguredError(),
    {
      status: 409,
      code: "CREDENTIAL_GATEWAY_NOT_CONFIGURED",
      message: new CredentialGatewayNotConfiguredError().message,
    },
  ],
  [
    "a Kubernetes API 409",
    apiError(409),
    {
      status: 409,
      code: "RESOURCE_CONFLICT",
      message: "The requested platform resource already exists.",
    },
  ],

  // 400: validation the caller can fix; the text names the field, never a value.
  [
    "a Role that cannot take effect through its binding",
    new IAMAccessBindingRoleError("Bindings to an exact Agent apply only agent permissions."),
    {
      status: 400,
      code: "INVALID_REQUEST",
      message: "Bindings to an exact Agent apply only agent permissions.",
      details: [{ path: "/roleId", code: "INVALID_VALUE" }],
    },
  ],
  [
    "an IAM policy write with an unusable subject",
    new IAMPolicyValidationError("/subjectId", "The subject is not usable in this Namespace."),
    {
      status: 400,
      code: "INVALID_REQUEST",
      message: "The subject is not usable in this Namespace.",
      details: [{ path: "/subjectId", code: "INVALID_VALUE" }],
    },
  ],
  [
    "a Secret value over the byte limit",
    new SecretValueError("TOO_LONG", "Secret values must be at most 65536 UTF-8 bytes."),
    {
      status: 400,
      code: "INVALID_REQUEST",
      message: "Secret values must be at most 65536 UTF-8 bytes.",
      details: [{ path: "/value", code: "TOO_LONG" }],
    },
  ],
  [
    "a Configuration that selects no supported Harness",
    new ConfigurationHarnessError("The Configuration does not select a supported Harness."),
    {
      status: 400,
      code: "INVALID_REQUEST",
      message: "The Configuration does not select a supported Harness.",
    },
  ],
  [
    "a runtime image without native worker support",
    new NativeWorkerSupportError(),
    { status: 400, code: "INVALID_REQUEST", message: new NativeWorkerSupportError().message },
  ],
  [
    "plugin selections that alias the same plugin",
    new PluginPolicyValidationError("aliasedPlugin"),
    {
      status: 400,
      code: "INVALID_REQUEST",
      message: new PluginPolicyValidationError("aliasedPlugin").message,
    },
  ],
  [
    "a Preset template rule",
    new PresetValidationError("Preset template.name: must be a string."),
    { status: 400, code: "INVALID_REQUEST", message: "Preset template.name: must be a string." },
  ],
  [
    "an inline model credential names its field",
    new ModelCredentialValueError("/models/providers/openai/apiKey"),
    {
      status: 400,
      code: "INVALID_REQUEST",
      message: new ModelCredentialValueError("/models/providers/openai/apiKey").message,
    },
  ],
  [
    "other Configuration validation stays generic",
    new ConfigurationValidationError(INTERNAL),
    { status: 400, code: "INVALID_REQUEST", message: "The supplied configuration is invalid." },
  ],
  [
    "a channel credential with the wrong token role",
    new ChannelCredentialError("role_mismatch", "/channels/slack/botToken"),
    {
      status: 400,
      code: "CHANNEL_CREDENTIAL_ROLE_MISMATCH",
      message: "The selected Secret has the wrong token role for this field.",
      details: [{ path: "/channels/slack/botToken", code: "INVALID_VALUE" }],
    },
  ],
  [
    "a channel credential that is not environment-backed",
    new ChannelCredentialError("binding_required", "/channels/slack/appToken"),
    {
      status: 400,
      code: "CHANNEL_CREDENTIAL_BINDING_REQUIRED",
      message: "Select an environment-backed Secret for this channel credential.",
      details: [{ path: "/channels/slack/appToken", code: "INVALID_VALUE" }],
    },
  ],
  [
    "channel credential validation that is unavailable",
    new ChannelCredentialError("unavailable", "/channels/slack/botToken"),
    {
      status: 503,
      code: "CHANNEL_CREDENTIAL_UNAVAILABLE",
      message: "Channel credential validation is temporarily unavailable. Retry before deploying.",
      details: [{ path: "/channels/slack/botToken", code: "INVALID_VALUE" }],
    },
  ],
  [
    "a channel directory credential without directory scopes",
    new ChannelDirectoryError("missing_scope"),
    {
      status: 400,
      code: "CHANNEL_DIRECTORY_MISSING_SCOPE",
      message:
        "The channel credential lacks directory permissions. Update its provider scopes and retry.",
    },
  ],
  [
    "a rate-limited channel directory",
    new ChannelDirectoryError("rate_limited"),
    {
      status: 429,
      code: "CHANNEL_DIRECTORY_RATE_LIMITED",
      message: "The channel provider rate-limited directory lookup. Wait and retry.",
    },
  ],
  [
    "a plugin service that rejects the credential",
    new PluginDiscoveryError("credentials_rejected"),
    {
      status: 400,
      code: "PLUGIN_DISCOVERY_CREDENTIALS_REJECTED",
      message:
        "The plugin service rejected this credential. Check its permission to list plugins, then retry.",
    },
  ],
  [
    "a Kubernetes API 400",
    apiError(400),
    {
      status: 400,
      code: "INVALID_REQUEST",
      message: "The request does not match the operation contract.",
    },
  ],
  [
    "a body that is not JSON",
    fastifyError("FST_ERR_CTP_INVALID_JSON_BODY"),
    {
      status: 400,
      code: "INVALID_REQUEST",
      message: "The request does not match the operation contract.",
    },
  ],
  [
    "a body over the size limit",
    fastifyError("FST_ERR_CTP_BODY_TOO_LARGE"),
    {
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
      message: "The request body exceeds the permitted size.",
    },
  ],
  [
    "a body that is not application/json",
    fastifyError("FST_ERR_CTP_INVALID_MEDIA_TYPE"),
    {
      status: 415,
      code: "UNSUPPORTED_MEDIA_TYPE",
      message: "Requests must use application/json.",
    },
  ],
  [
    "a runtime log cursor from another view",
    new RuntimeLogsError("RUNTIME_LOGS_CURSOR_INVALID"),
    {
      status: 400,
      code: "RUNTIME_LOGS_CURSOR_INVALID",
      message: "The runtime log cursor is invalid for this caller and view. Start a new view.",
    },
  ],
  [
    "a runtime log read that timed out",
    new RuntimeLogsError("RUNTIME_LOGS_TIMEOUT"),
    {
      status: 504,
      code: "RUNTIME_LOGS_TIMEOUT",
      message: "The runtime status or log read timed out.",
    },
  ],

  // 404: a scope miss never says whether the resource exists.
  [
    "a scope violation hides its detail",
    new ScopeViolationError(INTERNAL),
    {
      status: 404,
      code: "NOT_FOUND",
      message: "The requested platform resource was not found.",
    },
  ],

  // 401/403: authorization.
  [
    "a caller denial stays generic",
    new AuthorizationDeniedError(INTERNAL),
    {
      status: 403,
      code: "FORBIDDEN",
      message: "The exact platform operation was not authorized.",
    },
  ],
  [
    "a deletion retry owned by another actor names the condition",
    new DeletionRetryOwnedError("prn_initiator", agentResource),
    {
      status: 403,
      code: "FORBIDDEN",
      message: new DeletionRetryOwnedError("prn_initiator", agentResource).message,
    },
  ],
  [
    "an Agent principal denial names the missing grant",
    new AgentPrincipalAuthorizationError("prn_agent", "operate", {
      kind: "secret",
      id: "sec_1",
      namespaceId: "ns_1",
    }),
    {
      status: 403,
      code: "FORBIDDEN",
      message:
        "The Agent service principal prn_agent is not authorized to operate secret sec_1. Grant that principal operate on the secret, then deploy again.",
    },
  ],
  [
    "a Kubernetes API 401",
    apiError(401),
    {
      status: 401,
      code: "UNAUTHENTICATED",
      message: "The caller did not provide valid credentials.",
    },
  ],
  [
    "a Kubernetes API 403",
    apiError(403),
    {
      status: 403,
      code: "FORBIDDEN",
      message: "The exact platform operation was not authorized.",
    },
  ],
  [
    "missing admission evidence",
    admissionFailure({ statusCode: 401 }),
    {
      status: 401,
      code: "UNAUTHENTICATED",
      message: "The caller did not provide valid admission evidence.",
    },
  ],
  [
    "a refused admission boundary",
    admissionFailure({ statusCode: 403 }),
    {
      status: 403,
      code: "FORBIDDEN",
      message: "The request did not satisfy the configured admission boundary.",
    },
  ],
  [
    "a state change without a trusted browser origin",
    admissionFailure({ status: 403, reason: "untrusted_origin" }),
    {
      status: 403,
      code: "FORBIDDEN",
      message:
        "A trusted browser origin is required: session-cookie requests that change state must come from the console and send its Origin header.",
    },
  ],

  // 5xx: the platform, not the request.
  [
    "an unimplemented operation",
    new NotImplementedError("agents.fork"),
    {
      status: 501,
      code: "NOT_IMPLEMENTED",
      message: "The requested platform operation is not implemented.",
    },
  ],
  [
    "an unknown commit outcome says not to retry automatically",
    new PostgresCommitOutcomeUnknownError(),
    {
      status: 503,
      code: "DEPENDENCY_UNAVAILABLE",
      message:
        "The operation outcome is unknown. Do not retry automatically; inspect current state before a deliberate new action.",
    },
  ],
  [
    "an unavailable dependency is not a denial",
    new DependencyUnavailableError(INTERNAL),
    {
      status: 503,
      code: "DEPENDENCY_UNAVAILABLE",
      message: "A required platform dependency is unavailable.",
    },
  ],
  [
    "a Configuration ConfigMap OCC does not own",
    new ConfigurationOwnershipError(INTERNAL),
    {
      status: 503,
      code: "DEPENDENCY_UNAVAILABLE",
      message: "A required platform dependency is unavailable.",
    },
  ],
  [
    "a device login the sign-in service could not start",
    new DeviceAuthorizationStartError("unavailable", "HTTP_503"),
    {
      status: 503,
      code: "DEPENDENCY_UNAVAILABLE",
      message: "The sign-in service could not start device login. Try again.",
    },
  ],
  [
    "a Kubernetes API 404",
    apiError(404),
    {
      status: 503,
      code: "DEPENDENCY_UNAVAILABLE",
      message: "A required platform dependency is unavailable.",
    },
  ],
  [
    "an unclassified error",
    new Error(INTERNAL),
    {
      status: 500,
      code: "INTERNAL_ERROR",
      message: "The platform request could not be completed.",
    },
  ],
];

for (const [name, error, expected] of cases) {
  test(`HTTP error mapping: ${name} (${expected.status} ${expected.code})`, () => {
    const failure = requestFailure(error);
    assert.deepEqual(
      {
        status: failure.status,
        code: failure.code,
        message: failure.message,
        ...(failure.details === undefined ? {} : { details: failure.details }),
      },
      expected,
    );
    assert.doesNotMatch(failure.message, /internal detail/);
  });
}
