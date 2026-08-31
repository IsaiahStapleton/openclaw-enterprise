import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";
import {
  ControllerGatewayUnknownOutcomeError,
  isAllowedGatewayCommand,
} from "../../apps/controller/src/gateway/contracts.ts";
import {
  OpenClawGatewayNativeConfigurationError,
  OpenClawGatewayNativeEnrollmentError,
  OpenClawGatewayNativeUnsupportedMethodError,
  connectOpenClawGatewayNativeWithBootstrap,
  createOpenClawGatewayNativeDeviceIdentity,
  deriveDeviceIdFromPublicKeyRaw,
  publicKeyRawBase64UrlFromPem,
  requestOpenClawGatewayNative,
  signOpenClawGatewayNativePayload,
  validateOpenClawGatewayNativeDeviceIdentity,
} from "../../apps/controller/src/gateway/native-client.ts";

const requireFromController = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);
const requireFromGatewayClient = createRequire(
  requireFromController.resolve("@openclaw/gateway-client"),
);
const { WebSocketServer } = requireFromGatewayClient("ws");

const sharedToken = "shared-gateway-token";
const deviceToken = "durable-device-token";
const operatorScopes = ["operator.admin"];

test("native identity generation creates a real Ed25519 key and rejects mismatched ids", () => {
  const identity = createOpenClawGatewayNativeDeviceIdentity();
  validateOpenClawGatewayNativeDeviceIdentity(identity);

  const rawPublicKey = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
  assert.equal(identity.deviceId, deriveDeviceIdFromPublicKeyRaw(rawPublicKey));

  const payload = "v3|device|openclaw-enterprise|backend|operator|operator.admin|1||nonce||";
  const signature = signOpenClawGatewayNativePayload(identity.privateKeyPem, payload);
  const publicKey = createPublicKey(identity.publicKeyPem);
  assert.equal(
    verify(null, Buffer.from(payload, "utf8"), publicKey, Buffer.from(signature, "base64url")),
    true,
  );

  assert.throws(
    () =>
      validateOpenClawGatewayNativeDeviceIdentity({
        ...identity,
        deviceId: `bad-${identity.deviceId}`,
      }),
    OpenClawGatewayNativeConfigurationError,
  );

  const otherIdentity = createOpenClawGatewayNativeDeviceIdentity();
  assert.throws(
    () =>
      validateOpenClawGatewayNativeDeviceIdentity({
        ...identity,
        privateKeyPem: otherIdentity.privateKeyPem,
      }),
    OpenClawGatewayNativeConfigurationError,
  );
});

test("bootstrap enrollment uses the shared gateway token and captures the issued device token", async () => {
  const identity = createOpenClawGatewayNativeDeviceIdentity();
  const gateway = await startLoopbackGateway({
    helloAuth: { role: "operator", scopes: operatorScopes, deviceToken },
  });
  try {
    const token = await connectOpenClawGatewayNativeWithBootstrap({
      url: gateway.url,
      identity,
      sharedToken,
    });

    assert.deepEqual(token, { token: deviceToken, scopes: operatorScopes });
    assert.equal(gateway.connectParams.length, 1);
    assert.equal(gateway.connectParams[0].auth.token, sharedToken);
    assert.equal("bootstrapToken" in gateway.connectParams[0].auth, false);
    assert.equal("deviceToken" in gateway.connectParams[0].auth, false);
  } finally {
    await gateway.close();
  }
});

test("bootstrap enrollment survives retryable pairing-required and captures the approved token", async () => {
  const identity = createOpenClawGatewayNativeDeviceIdentity();
  const gateway = await startLoopbackGateway({
    onConnect(_frame, attempt) {
      if (attempt === 1) {
        return {
          ok: false,
          error: {
            code: "FORBIDDEN",
            message: "pairing approval required",
            details: {
              code: "PAIRING_REQUIRED",
              reason: "not-paired",
              requestId: "pairing-test-request",
              recommendedNextStep: "wait_then_retry",
              pauseReconnect: false,
            },
            retryable: true,
            retryAfterMs: 10,
          },
        };
      }
      return {
        ok: true,
        payload: helloOk({
          helloAuth: { role: "operator", scopes: operatorScopes, deviceToken },
        }),
      };
    },
  });
  try {
    const token = await connectOpenClawGatewayNativeWithBootstrap({
      url: gateway.url,
      identity,
      sharedToken,
    });

    assert.deepEqual(token, { token: deviceToken, scopes: operatorScopes });
    assert.deepEqual(
      gateway.requests.map((frame) => frame.method),
      ["connect", "connect"],
    );
  } finally {
    await gateway.close();
  }
});

test("bootstrap enrollment awaits one manual pairing barrier before reopening the shared-token client", async () => {
  const identity = createOpenClawGatewayNativeDeviceIdentity();
  let approvalCalls = 0;
  const gateway = await startLoopbackGateway({
    onConnect(_frame, attempt) {
      if (attempt === 1) {
        return {
          ok: false,
          error: {
            code: "FORBIDDEN",
            message: "pairing approval required",
            details: {
              code: "PAIRING_REQUIRED",
              reason: "not-paired",
              requestId: "pairing-test-request",
            },
            retryable: true,
          },
        };
      }
      assert.equal(approvalCalls, 1);
      return {
        ok: true,
        payload: helloOk({
          helloAuth: { role: "operator", scopes: operatorScopes, deviceToken },
        }),
      };
    },
  });
  try {
    const token = await connectOpenClawGatewayNativeWithBootstrap({
      url: gateway.url,
      identity,
      sharedToken,
      waitForPairingApproval: async () => {
        approvalCalls += 1;
      },
    });

    assert.deepEqual(token, { token: deviceToken, scopes: operatorScopes });
    assert.equal(approvalCalls, 1);
    assert.deepEqual(
      gateway.requests.map((frame) => frame.method),
      ["connect", "connect"],
    );
    assert.equal(
      gateway.connectParams.every((params) => params.auth.token === sharedToken),
      true,
    );
  } finally {
    await gateway.close();
  }
});

test("bootstrap enrollment does not run a second manual pairing barrier", async () => {
  const identity = createOpenClawGatewayNativeDeviceIdentity();
  let approvalCalls = 0;
  const gateway = await startLoopbackGateway({
    onConnect() {
      return {
        ok: false,
        error: {
          code: "FORBIDDEN",
          message: "pairing approval required",
          details: {
            code: "PAIRING_REQUIRED",
            reason: "not-paired",
            requestId: "pairing-test-request",
          },
          retryable: true,
        },
      };
    },
  });
  try {
    await assert.rejects(
      connectOpenClawGatewayNativeWithBootstrap({
        url: gateway.url,
        identity,
        sharedToken,
        waitForPairingApproval: async () => {
          approvalCalls += 1;
        },
      }),
      OpenClawGatewayNativeEnrollmentError,
    );
    assert.equal(approvalCalls, 1);
    assert.deepEqual(
      gateway.requests.map((frame) => frame.method),
      ["connect", "connect"],
    );
  } finally {
    await gateway.close();
  }
});

test("bootstrap enrollment rejects hello-ok without operator admin approval", async () => {
  const identity = createOpenClawGatewayNativeDeviceIdentity();
  const gateway = await startLoopbackGateway({
    helloAuth: { role: "operator", scopes: ["operator.read"], deviceToken },
  });
  try {
    await assert.rejects(
      connectOpenClawGatewayNativeWithBootstrap({
        url: gateway.url,
        identity,
        sharedToken,
      }),
      OpenClawGatewayNativeEnrollmentError,
    );
    assert.equal(gateway.connectParams.length, 1);
    assert.equal(gateway.connectParams[0].auth.token, sharedToken);
  } finally {
    await gateway.close();
  }
});

test("bootstrap enrollment rejects non-exact operator admin scope grants", async () => {
  const cases = [
    { name: "broader grant", scopes: ["operator.admin", "operator.read"] },
    { name: "duplicate grant", scopes: ["operator.admin", "operator.admin"] },
    { name: "malformed grant", scopes: ["operator.admin", " "] },
  ];

  for (const { name, scopes } of cases) {
    const identity = createOpenClawGatewayNativeDeviceIdentity();
    const gateway = await startLoopbackGateway({
      helloAuth: { role: "operator", scopes, deviceToken },
    });
    try {
      await assert.rejects(
        connectOpenClawGatewayNativeWithBootstrap({
          url: gateway.url,
          identity,
          sharedToken,
        }),
        OpenClawGatewayNativeEnrollmentError,
        name,
      );
      assert.equal(gateway.connectParams.length, 1, name);
      assert.equal(gateway.connectParams[0].auth.token, sharedToken, name);
    } finally {
      await gateway.close();
    }
  }
});

test("durable dispatch waits for hello-ok, uses the shared allowlist, and requests a first response", async () => {
  const identity = createOpenClawGatewayNativeDeviceIdentity();
  const gateway = await startLoopbackGateway({
    onRequest(frame) {
      assert.equal(frame.method, "status");
      return { ok: true, payload: { status: "ok" } };
    },
  });
  try {
    const result = await requestOpenClawGatewayNative({
      url: gateway.url,
      identity,
      deviceToken,
      scopes: operatorScopes,
      request: { method: "status", params: {} },
    });

    assert.deepEqual(result, { ok: true, payload: { status: "ok" } });
    assert.deepEqual(
      gateway.requests.map((frame) => frame.method),
      ["connect", "status"],
    );
    assert.equal(Object.values(gateway.connectParams[0].auth).includes(deviceToken), true);
    assert.equal(Object.values(gateway.connectParams[0].auth).includes(sharedToken), false);
    assert.equal("bootstrapToken" in gateway.connectParams[0].auth, false);
    assert.equal(isAllowedGatewayCommand("status"), true);
    assert.equal(isAllowedGatewayCommand("config.patch"), false);
  } finally {
    await gateway.close();
  }
});

test("config.get dispatch omits native internal source snapshot while preserving public fields", async () => {
  const identity = createOpenClawGatewayNativeDeviceIdentity();
  const gatewaySecret = "native-gateway-token-secret";
  const redacted = "__OPENCLAW_REDACTED__";
  const gateway = await startLoopbackGateway({
    onRequest(frame) {
      assert.equal(frame.method, "config.get");
      return {
        ok: true,
        payload: {
          path: "/tmp/openclaw.json5",
          exists: true,
          raw: `{ gateway: { auth: { token: "${redacted}" } } }`,
          parsed: { gateway: { auth: { token: redacted } } },
          sourceConfigBeforeMigrations: { gateway: { auth: { token: gatewaySecret } } },
          sourceConfig: { gateway: { auth: { token: redacted } } },
          resolved: { gateway: { auth: { token: redacted } } },
          runtimeConfig: { gateway: { auth: { token: redacted } } },
          config: { gateway: { auth: { token: redacted } } },
          valid: true,
          hash: "projected-config-hash",
          configRevisionHash: "projected-revision-hash",
          appliedConfigHash: null,
          issues: [],
          warnings: [],
          legacyIssues: [],
        },
      };
    },
  });
  try {
    const result = await requestOpenClawGatewayNative({
      url: gateway.url,
      identity,
      deviceToken,
      scopes: operatorScopes,
      request: { method: "config.get", params: {} },
    });

    assert.equal(result.ok, true);
    assert.equal(JSON.stringify(result).includes(gatewaySecret), false);
    assert.equal("sourceConfigBeforeMigrations" in result.payload, false);
    assert.deepEqual(result.payload.config, { gateway: { auth: { token: redacted } } });
    assert.deepEqual(result.payload.runtimeConfig, { gateway: { auth: { token: redacted } } });
    assert.equal(result.payload.configRevisionHash, "projected-revision-hash");
    assert.deepEqual(
      gateway.requests.map((frame) => frame.method),
      ["connect", "config.get"],
    );
  } finally {
    await gateway.close();
  }
});

test("unsupported methods are rejected before opening a gateway socket", async () => {
  const identity = createOpenClawGatewayNativeDeviceIdentity();
  const gateway = await startLoopbackGateway();
  try {
    await assert.rejects(
      requestOpenClawGatewayNative({
        url: gateway.url,
        identity,
        deviceToken,
        scopes: operatorScopes,
        request: { method: "config.patch", params: {} },
      }),
      OpenClawGatewayNativeUnsupportedMethodError,
    );
    assert.equal(gateway.requests.length, 0);
  } finally {
    await gateway.close();
  }
});

test("durable dispatch rejects non-exact device token scopes before opening a gateway socket", async () => {
  const identity = createOpenClawGatewayNativeDeviceIdentity();
  const gateway = await startLoopbackGateway();
  try {
    await assert.rejects(
      requestOpenClawGatewayNative({
        url: gateway.url,
        identity,
        deviceToken,
        scopes: ["operator.admin", "operator.read"],
        request: { method: "status", params: {} },
      }),
      OpenClawGatewayNativeConfigurationError,
    );
    assert.equal(gateway.requests.length, 0);
  } finally {
    await gateway.close();
  }
});

test("durable dispatch rejects hello-ok without operator admin approval before command dispatch", async () => {
  const identity = createOpenClawGatewayNativeDeviceIdentity();
  const gateway = await startLoopbackGateway({
    helloAuth: { role: "viewer", scopes: ["operator.admin"] },
  });
  try {
    await assert.rejects(
      requestOpenClawGatewayNative({
        url: gateway.url,
        identity,
        deviceToken,
        scopes: operatorScopes,
        request: { method: "status", params: {} },
      }),
      OpenClawGatewayNativeConfigurationError,
    );
    assert.deepEqual(
      gateway.requests.map((frame) => frame.method),
      ["connect"],
    );
  } finally {
    await gateway.close();
  }
});

test("durable dispatch rejects connect-time auth failure before command dispatch", async () => {
  const identity = createOpenClawGatewayNativeDeviceIdentity();
  const gateway = await startLoopbackGateway({
    onConnect() {
      return {
        ok: false,
        error: {
          code: "FORBIDDEN",
          message: "device token revoked",
          details: { code: "AUTH_TOKEN_MISMATCH" },
          retryable: false,
        },
      };
    },
  });
  try {
    await assert.rejects(
      requestOpenClawGatewayNative({
        url: gateway.url,
        identity,
        deviceToken,
        scopes: operatorScopes,
        request: { method: "status", params: {} },
      }),
      (error) => error.name === "GatewayClientRequestError",
    );
    assert.deepEqual(
      gateway.requests.map((frame) => frame.method),
      ["connect"],
    );
    assert.equal(Object.values(gateway.connectParams[0].auth).includes(sharedToken), false);
  } finally {
    await gateway.close();
  }
});

test("native RPC rejection preserves gateway error semantics as an ok:false result", async () => {
  const identity = createOpenClawGatewayNativeDeviceIdentity();
  const gateway = await startLoopbackGateway({
    onRequest(frame) {
      assert.equal(frame.method, "agents.files.get");
      return {
        ok: false,
        error: {
          code: "FORBIDDEN",
          message: "missing scope",
          details: { code: "MISSING_SCOPE", missingScope: "operator.admin" },
          retryable: true,
          retryAfterMs: 12,
        },
      };
    },
  });
  try {
    const result = await requestOpenClawGatewayNative({
      url: gateway.url,
      identity,
      deviceToken,
      scopes: operatorScopes,
      request: { method: "agents.files.get", params: { agentId: "main", name: "AGENTS.md" } },
    });

    assert.deepEqual(result, {
      ok: false,
      error: {
        code: "FORBIDDEN",
        message: "missing scope",
        details: { code: "MISSING_SCOPE", missingScope: "operator.admin" },
        retryable: true,
        retryAfterMs: 12,
      },
    });
  } finally {
    await gateway.close();
  }
});

test("abort after SDK dispatch is surfaced as an unknown outcome without replay", async () => {
  const identity = createOpenClawGatewayNativeDeviceIdentity();
  const controller = new AbortController();
  let requestSeen;
  const observedRequest = new Promise((resolve) => {
    requestSeen = resolve;
  });
  const gateway = await startLoopbackGateway({
    onRequest(frame) {
      assert.equal(frame.method, "agents.files.set");
      requestSeen();
      return "pending";
    },
  });
  try {
    const requestPromise = requestOpenClawGatewayNative({
      url: gateway.url,
      identity,
      deviceToken,
      scopes: operatorScopes,
      request: { method: "agents.files.set", params: { agentId: "main", name: "x", content: "y" } },
      signal: controller.signal,
    });
    await observedRequest;
    controller.abort(new Error("test abort after gateway dispatch"));

    await assert.rejects(
      requestPromise,
      (error) =>
        error instanceof ControllerGatewayUnknownOutcomeError &&
        error.message.includes("agents.files.set"),
    );
    assert.deepEqual(
      gateway.requests.map((frame) => frame.method),
      ["connect", "agents.files.set"],
    );
  } finally {
    await gateway.close();
  }
});

test("abort before hello-ok is surfaced as dependency unavailable before command dispatch", async () => {
  const identity = createOpenClawGatewayNativeDeviceIdentity();
  const controller = new AbortController();
  const gateway = await startLoopbackGateway({ challengeDelayMs: 50 });
  try {
    const requestPromise = requestOpenClawGatewayNative({
      url: gateway.url,
      identity,
      deviceToken,
      scopes: operatorScopes,
      request: { method: "status", params: {} },
      signal: controller.signal,
    });
    controller.abort(new Error("test abort before hello"));

    await assert.rejects(
      requestPromise,
      (error) =>
        error instanceof Error &&
        !(error instanceof ControllerGatewayUnknownOutcomeError) &&
        error.message === "test abort before hello",
    );
    assert.equal(
      gateway.requests.some((frame) => frame.method === "status"),
      false,
    );
  } finally {
    await gateway.close();
  }
});

test("oversized native responses are capped after dispatch", async () => {
  const identity = createOpenClawGatewayNativeDeviceIdentity();
  const gateway = await startLoopbackGateway({
    onRequest(frame) {
      assert.equal(frame.method, "chat.history");
      return { ok: true, payload: { content: "x".repeat(1024 * 1024) } };
    },
  });
  try {
    await assert.rejects(
      requestOpenClawGatewayNative({
        url: gateway.url,
        identity,
        deviceToken,
        scopes: operatorScopes,
        request: { method: "chat.history", params: {} },
      }),
      ControllerGatewayUnknownOutcomeError,
    );
  } finally {
    await gateway.close();
  }
});

async function startLoopbackGateway(options = {}) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const requests = [];
  const connectParams = [];
  server.on("connection", (socket) => {
    const sendChallenge = () => {
      if (socket.readyState === socket.OPEN) {
        socket.send(
          JSON.stringify({
            type: "event",
            event: "connect.challenge",
            payload: { nonce: "test-nonce", ts: Date.now() },
          }),
        );
      }
    };
    if (options.challengeDelayMs === undefined) sendChallenge();
    else setTimeout(sendChallenge, options.challengeDelayMs).unref?.();

    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString("utf8"));
      requests.push(frame);
      if (frame.method === "connect") {
        connectParams.push(frame.params);
        const connectResponse = options.onConnect?.(frame, connectParams.length) ?? {
          ok: true,
          payload: helloOk(options),
        };
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ...connectResponse,
          }),
        );
        return;
      }

      const response = options.onRequest?.(frame);
      if (response === "pending") return;
      if (response === undefined) {
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { method: frame.method, params: frame.params ?? null },
          }),
        );
        return;
      }
      socket.send(JSON.stringify({ type: "res", id: frame.id, ...response }));
    });
  });
  await once(server, "listening");
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  return {
    url: `ws://127.0.0.1:${address.port}`,
    requests,
    connectParams,
    close: async () => {
      for (const client of server.clients) client.close();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function helloOk(options) {
  return {
    type: "hello-ok",
    protocol: 4,
    server: { version: "test", connId: "conn-test" },
    features: {
      methods: ["status", "agents.files.get", "agents.files.set", "chat.history"],
      events: [],
    },
    snapshot: {
      presence: [],
      health: { ok: true, ts: Date.now(), durationMs: 0 },
      stateVersion: { presence: 0, health: 0 },
      uptimeMs: 0,
    },
    auth: options.helloAuth ?? { role: "operator", scopes: operatorScopes },
    policy: { maxPayload: 1, maxBufferedBytes: 1, tickIntervalMs: 60_000 },
  };
}
