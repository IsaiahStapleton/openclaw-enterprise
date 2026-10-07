import assert from "node:assert/strict";
import { createRequire } from "node:module";
import net from "node:net";
import test from "node:test";
import { createNativeAdminAccess } from "../../apps/controller/src/http/native-admin.ts";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const Fastify = require("fastify");

test("a client reset during native-admin upgrade admission does not crash", async () => {
  const crashes = [];
  const onUncaught = (error) => {
    crashes.push(error);
  };
  process.on("uncaughtException", onUncaught);
  const app = Fastify({ logger: false });
  createNativeAdminAccess({
    app,
    installationId: "inst_native_admin_upgrade",
    publicOrigin: undefined,
    factory: {
      create() {
        return {};
      },
    },
    getController() {
      return undefined;
    },
    selectedIAMDriver() {
      throw new Error("unused");
    },
    getContext() {
      return undefined;
    },
    getAdmission() {
      return undefined;
    },
    auth: {
      admissionVerifier: {
        verify() {
          return new Promise(() => {});
        },
      },
    },
    nativeAdmin: { enabled: false, domain: "agents.example.test" },
    nativeAdminGatewayApiKey: undefined,
    webSocketLeaseIntervalMs: undefined,
    auditSink: { async append() {} },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  try {
    await new Promise((resolve, reject) => {
      const socket = net.connect(address.port, "127.0.0.1");
      socket.on("error", reject);
      socket.on("connect", () => {
        socket.write(
          "GET / HTTP/1.1\r\nHost: agent-a.agents.example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        );
        setTimeout(() => {
          socket.resetAndDestroy();
          setTimeout(resolve, 300);
        }, 80);
      });
    });
    assert.deepEqual(crashes, []);
  } finally {
    process.off("uncaughtException", onUncaught);
    await app.close();
  }
});
